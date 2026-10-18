/**
 * js/audio.js — low-latency audio controller with Web Audio pre-decoding,
 * lookahead queue management, and automated fallback cascade.
 *
 * Tier 1: Low-latency Web Audio API (pre-decoded AudioBuffers).
 * Tier 2: Speech Synthesis API.
 * Tier 3: Silence.
 */

export const AutoplaySettings = Object.freeze({
  MOUNT: "mount",
  REVEAL: "reveal",
  MUTE: "mute"
});

export class AudioController {
  /**
   * @param {object} [options={}]
   * @param {AudioContext} [options.audioContext] - Injected or mocked AudioContext
   * @param {SpeechSynthesis} [options.speechSynthesis] - Injected SpeechSynthesis
   * @param {Function} [options.fetchAudio] - Custom fetch/decoder function: (card) => Promise<AudioBuffer>
   * @param {EventTarget} [options.eventTarget] - Document or window target for interaction listeners
   * @param {boolean} [options.autoUnlock=true] - Whether to automatically attach gesture recovery listeners
   * @param {string} [options.autoplay="mount"] - Autoplay setting: "mount" | "reveal" | "mute"
   */
  constructor(options = {}) {
    this.options = options;
    this.ctx = options.audioContext || null;
    this.speechSynthesis =
      options.speechSynthesis ||
      (typeof window !== "undefined" && window.speechSynthesis ? window.speechSynthesis : null);
    this.fetchAudio = options.fetchAudio || this._defaultFetchAudio.bind(this);
    this.autoplaySetting = options.autoplay || options.autoplaySetting || AutoplaySettings.MOUNT;

    this.bufferMap = new Map(); // cardId -> AudioBuffer
    this.lookaheadQueue = []; // array of card IDs currently buffered
    this.retainedStumbleIds = new Set(); // set of card IDs kept in memory due to stumbles
    this.activeCard = null;
    this.activeSource = null;
    this.activeAbort = null;
    this.isSpeaking = false;

    if (options.autoUnlock !== false) {
      this.attachAutoplayRecovery(options.eventTarget);
    }
  }

  setAutoplaySetting(setting) {
    this.autoplaySetting = setting;
  }

  getAutoplaySetting() {
    return this.autoplaySetting;
  }

  /**
   * Explicitly marks a card as stumbled so its audio buffer is retained
   * in memory even when it drops out of the active lookahead queue.
   */
  retainStumbled(cardOrId) {
    const id = typeof cardOrId === "object" ? cardOrId?.id : cardOrId;
    if (id) {
      this.retainedStumbleIds.add(String(id));
    }
  }

  /**
   * Clears a card from stumble retention once it has been answered correctly.
   */
  clearStumbled(cardOrId) {
    const id = typeof cardOrId === "object" ? cardOrId?.id : cardOrId;
    if (id) {
      this.retainedStumbleIds.delete(String(id));
    }
  }

  isStumbledRetained(cardOrId) {
    const id = typeof cardOrId === "object" ? cardOrId?.id : cardOrId;
    return this.retainedStumbleIds.has(String(id));
  }

  evictBuffer(cardId) {
    this.retainedStumbleIds.delete(cardId);
    return this.bufferMap.delete(cardId);
  }

  /**
   * Attaches gesture listeners to recover from suspended autoplay state.
   */
  attachAutoplayRecovery(target) {
    const t =
      target ||
      (typeof document !== "undefined"
        ? document
        : typeof window !== "undefined"
          ? window
          : null);
    if (!t || typeof t.addEventListener !== "function") return;

    const resumeHandler = async () => {
      await this.resumeContext();
      if (this.ctx && this.ctx.state === "running") {
        for (const evt of ["click", "touchstart", "keydown", "pointerdown"]) {
          t.removeEventListener(evt, resumeHandler);
        }
      }
    };

    for (const evt of ["click", "touchstart", "keydown", "pointerdown"]) {
      t.addEventListener(evt, resumeHandler, { capture: true, passive: true });
    }
  }

  /**
   * Gracefully resumes the AudioContext if suspended by autoplay policies.
   */
  async resumeContext() {
    if (!this.ctx && typeof AudioContext !== "undefined") {
      this.ctx = new AudioContext();
    }
    if (this.ctx && this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch (err) {
        // Autoplay policy still preventing resume
      }
    }
    return this.ctx ? this.ctx.state : "unsupported";
  }

  /**
   * Updates lookahead queue holding exactly cards N+1, N+2, and N+3.
   * Evicts completed/unneeded buffers to prevent memory leaks.
   *
   * @param {Array} cards - Active card list
   * @param {number} [currentIndex=0] - Mounted card index N
   */
  async preloadQueue(cards = [], currentIndex = 0, options = {}) {
    if (!Array.isArray(cards)) return;
    this.activeCard = cards[currentIndex] || null;

    // Next 3 cards: N+1, N+2, N+3
    const lookaheadCards = cards.slice(currentIndex + 1, currentIndex + 4);
    const lookaheadIds = lookaheadCards.map((c) => c?.id).filter(Boolean);
    this.lookaheadQueue = lookaheadIds;

    // Automatically retain any cards flagged as stumbled in active queue or options
    for (const card of cards) {
      if (card?._stumbled && card.id) {
        this.retainedStumbleIds.add(String(card.id));
      }
    }
    if (Array.isArray(options?.stumbleQueue)) {
      for (const card of options.stumbleQueue) {
        if (card?.id) this.retainedStumbleIds.add(String(card.id));
      }
    }

    // Retain only currently active card, the 3 lookahead cards, and any stumble-recycled cards until cleared
    const neededIds = new Set([
      this.activeCard?.id,
      ...lookaheadIds,
      ...this.retainedStumbleIds
    ].filter(Boolean));

    for (const id of this.bufferMap.keys()) {
      if (!neededIds.has(id)) {
        this.bufferMap.delete(id);
      }
    }

    // Pre-decode lookahead cards and any retained stumble cards
    const cardsToPreload = [...lookaheadCards];
    for (const id of this.retainedStumbleIds) {
      if (!this.bufferMap.has(id)) {
        const sc = cards.find((c) => c?.id === id) || (options?.stumbleQueue || []).find((c) => c?.id === id);
        if (sc) cardsToPreload.push(sc);
      }
    }

    await Promise.all(
      cardsToPreload.map(async (card) => {
        if (!card || !card.id || this.bufferMap.has(card.id)) return;
        try {
          const buffer = await this.fetchAudio(card);
          if (buffer) {
            this.bufferMap.set(card.id, buffer);
          }
        } catch (err) {
          // Graceful fallback to speech synthesis or silence
        }
      })
    );
  }

  /**
   * Default audio fetcher and decoder using Web Audio API.
   */
  async _defaultFetchAudio(card) {
    const url = card?.audio || card?.audioUrl;
    if (!url || typeof fetch === "undefined") return null;

    if (!this.ctx && typeof AudioContext !== "undefined") {
      this.ctx = new AudioContext();
    }
    if (!this.ctx) return null;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Audio fetch failed: HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    return await this.ctx.decodeAudioData(arrayBuffer);
  }

  /**
   * Idempotent trigger to stop active playback and cancel speech synthesis.
   */
  stopAll() {
    if (typeof this.activeAbort === "function") {
      this.activeAbort();
      this.activeAbort = null;
    }

    if (this.activeSource) {
      try {
        this.activeSource.stop();
      } catch {}
      try {
        this.activeSource.disconnect();
      } catch {}
      this.activeSource = null;
    }

    if (this.speechSynthesis) {
      try {
        this.speechSynthesis.cancel();
      } catch {}
    }
    this.isSpeaking = false;
  }

  /**
   * Plays audio for the mounted card or specified card.
   * Employs fallback cascade: Web Audio Buffer -> Speech Synthesis -> Silence.
   * Cleanly handles early advancement without throwing unhandled rejections.
   * Honors autoplay settings: "mount" | "reveal" | "mute".
   *
   * @param {object} [card=this.activeCard]
   * @param {string} [trigger="mount"] - "mount" | "reveal"
   * @returns {Promise<{ status: string, mode: string, lang?: string }>}
   */
  async playCurrent(card = this.activeCard, trigger = "mount") {
    this.stopAll();
    if (!card) return { status: "empty", mode: "none" };

    if (this.autoplaySetting === AutoplaySettings.MUTE) {
      return { status: "muted", mode: "none" };
    }
    if (this.autoplaySetting === AutoplaySettings.REVEAL && trigger === "mount") {
      return { status: "skipped", mode: "none" };
    }

    if (!this.ctx && typeof AudioContext !== "undefined") {
      this.ctx = new AudioContext();
    }
    if (this.ctx && this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {}
    }

    const cardId = card.id;
    let buffer = cardId ? this.bufferMap.get(cardId) : null;

    if (!buffer && (card.audio || card.audioUrl)) {
      try {
        buffer = await this.fetchAudio(card);
        if (buffer && cardId) this.bufferMap.set(cardId, buffer);
      } catch {}
    }

    // Tier 1: Web Audio Buffer
    if (buffer && this.ctx) {
      return new Promise((resolve) => {
        let aborted = false;
        try {
          const source = this.ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(this.ctx.destination);
          this.activeSource = source;

          this.activeAbort = () => {
            aborted = true;
            resolve({ status: "aborted", mode: "webaudio" });
          };

          source.onended = () => {
            if (this.activeSource === source) {
              this.activeSource = null;
              this.activeAbort = null;
            }
            if (!aborted) resolve({ status: "finished", mode: "webaudio" });
          };

          source.start(0);
        } catch (err) {
          resolve(this._playSpeechSynthesis(card));
        }
      });
    }

    // Tier 2: Speech Synthesis
    if (this.speechSynthesis && (card.answer || card.prompt || card.script)) {
      return this._playSpeechSynthesis(card);
    }

    // Tier 3: Silence
    return { status: "silence", mode: "fallback" };
  }

  _playSpeechSynthesis(card) {
    return new Promise((resolve) => {
      let aborted = false;
      try {
        const text = card.answer || card.prompt || card.script || "";
        const lang = card.lang || card.answerLang || "en";
        const UtteranceClass =
          typeof SpeechSynthesisUtterance !== "undefined"
            ? SpeechSynthesisUtterance
            : this.options.SpeechSynthesisUtterance;

        if (!UtteranceClass || !this.speechSynthesis || typeof this.speechSynthesis.speak !== "function") {
          return resolve({ status: "silence", mode: "fallback" });
        }

        const utterance = new UtteranceClass(text);
        utterance.lang = lang;

        this.activeAbort = () => {
          aborted = true;
          try {
            this.speechSynthesis.cancel();
          } catch {}
          this.isSpeaking = false;
          resolve({ status: "aborted", mode: "speech" });
        };

        utterance.onend = () => {
          this.isSpeaking = false;
          this.activeAbort = null;
          if (!aborted) resolve({ status: "finished", mode: "speech", lang });
        };

        utterance.onerror = () => {
          this.isSpeaking = false;
          this.activeAbort = null;
          resolve({ status: "silence", mode: "fallback" });
        };

        this.isSpeaking = true;
        this.speechSynthesis.speak(utterance);
      } catch {
        resolve({ status: "silence", mode: "fallback" });
      }
    });
  }

  getLookaheadQueue() {
    return [...this.lookaheadQueue];
  }

  isBuffered(cardId) {
    return this.bufferMap.has(cardId);
  }

  getBufferSize() {
    return this.bufferMap.size;
  }
}

