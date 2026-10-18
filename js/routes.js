/**
 * js/routes.js — polymorphic route architecture for disparate pedagogical modes.
 *
 * Route 1: Reflex Sprint (Isolated Word/Character) - Prefix-free auto-advance, ghost input, 3s hesitation stumble.
 * Route 2: Contextual Cloze (Single Sentence Blank) - Fixed inline blank, phonetic/gloss match auto-advance.
 * Route 3: Variable Cloze (Dynamic Syntax Rotation) - Ledger-driven rotating blank, dynamic token alignment.
 * Route 4: Kid / Sensory Flash (Audio-First Touch Stage) - Fullscreen locked canvas, tap surface, pacing countdown, 2s hold safety exit.
 * Route 5: Strict Production (Native Script & IME) - Composition shielding, Enter submission, editable backspacing.
 */

import { evaluateInput, Modes } from "./normalizer.js";
import { generateCloze, renderCloze, hasLegacyCloze, isCJK } from "./cloze.js";

export const Routes = Object.freeze({
  REFLEX: "reflex",
  CONTEXT_CLOZE: "contextual-cloze",
  VARIABLE_CLOZE: "variable-cloze",
  SENSORY_FLASH: "sensory-flash",
  STRICT_PRODUCTION: "strict-production"
});

export const ROUTE_LABELS = Object.freeze({
  [Routes.REFLEX]: "Speed Sprint",
  [Routes.CONTEXT_CLOZE]: "Sentence Cloze",
  [Routes.VARIABLE_CLOZE]: "Grammar Gym",
  [Routes.SENSORY_FLASH]: "Audio Flashcards",
  [Routes.STRICT_PRODUCTION]: "Native Typing"
});

/**
 * Determines whether a given deck requires / supports Native Typing (IME composition mode).
 * Decks using Latin / Romanized scripts (French, Spanish, Yoruba, English, etc.) where OS composition
 * buffers are irrelevant are excluded. Non-Latin scripts (Hanzi, Kana, Hangul, Arabic, Cyrillic, etc.)
 * or explicit Pinyin checking decks return true.
 *
 * @param {object} deck - Deck configuration object
 * @returns {boolean}
 */
export function isNativeTypingCompatible(deck) {
  if (!deck) return false;
  if (deck.romanization === "pinyin") return true;
  const lang = String(deck.lang || "").toLowerCase();
  if (/^(zh|ja|ko|ar|he|hi|th|ru|el|uk|fa|ur)/.test(lang)) return true;
  if (Array.isArray(deck.cards) && deck.cards.some((c) => c?.script || isCJK(c?.answer || c?.prompt))) return true;
  return false;
}

/**
 * Returns the permitted pedagogical routes for a given deck archetype.
 *
 * @param {object} deck - Deck configuration object
 * @returns {Array<{ value: string, label: string }>}
 */
export function routesForDeck(deck) {
  const all = [
    { value: Routes.REFLEX, label: ROUTE_LABELS[Routes.REFLEX] },
    { value: Routes.CONTEXT_CLOZE, label: ROUTE_LABELS[Routes.CONTEXT_CLOZE] },
    { value: Routes.VARIABLE_CLOZE, label: ROUTE_LABELS[Routes.VARIABLE_CLOZE] },
    { value: Routes.SENSORY_FLASH, label: ROUTE_LABELS[Routes.SENSORY_FLASH] }
  ];
  if (isNativeTypingCompatible(deck)) {
    all.push({ value: Routes.STRICT_PRODUCTION, label: ROUTE_LABELS[Routes.STRICT_PRODUCTION] });
  }
  return all;
}

export const HESITATION_THRESHOLD_MS = 3000;
export const PACING_COUNTDOWN_MS = 2000;
export const SAFETY_HOLD_DURATION_MS = 2000;

export class RouteController extends EventTarget {
  constructor(options = {}) {
    super();
    this.store = options.store || null;
    this.audio = options.audio || null;
    this.activeRoute = options.defaultRoute || Routes.REFLEX;

    this.activeCard = null;
    this.phase = "answering"; // "answering" | "revealed" | "advancing"
    this.isComposing = false;
    this.queue = [];
    this.currentIndex = 0;

    // Timers
    this._hesitationTimer = null;
    this._pacingTimer = null;
    this._safetyHoldTimer = null;
    this._safetyHoldStart = 0;
    this._lastTapTime = 0;
    this._wakeLock = null;

    // Elements injection / hooks
    this.elements = options.elements || {};
    this._listeners = [];

    if (options.queue) {
      this.setQueue(options.queue);
    }
  }

  /* ----------------- Queue Management ----------------- */

  setQueue(cards = []) {
    this.queue = [...cards];
    this.currentIndex = 0;
  }

  getQueue() {
    return [...this.queue];
  }

  /**
   * Splices failed card exactly 3 to 4 positions ahead in the active queue.
   */
  spliceStumble(card, positionsAhead = 3) {
    if (!card) return;
    const targetIdx = Math.min(this.queue.length, this.currentIndex + positionsAhead);
    const stumbleClone = {
      ...card,
      _stumbled: true,
      _stumbledAt: Date.now()
    };
    this.queue.splice(targetIdx, 0, stumbleClone);
    this.dispatchEvent(new CustomEvent("queue-spliced", { detail: { card: stumbleClone, targetIdx } }));
  }

  /* ----------------- Lifecycle & Route Switching ----------------- */

  /**
   * Cleanly unmounts active route listeners, cancels timers, stops audio,
   * configures virtual keyboard/touch surface, and mounts new route.
   */
  async switchRoute(newRoute) {
    const prevRoute = this.activeRoute;

    // 1. Teardown active route context
    this.cancelTimers();
    if (this.audio) {
      this.audio.stopAll();
    }

    // Blur active inputs to collapse virtual keyboard on mobile when leaving typing routes
    const activeEl = typeof document !== "undefined" ? document.activeElement : null;
    if (activeEl && typeof activeEl.blur === "function") {
      activeEl.blur();
    }

    this.isComposing = false;
    this.activeRoute = newRoute;

    // 2. Setup new route environment
    if (newRoute === Routes.REFLEX) {
      if (this.elements.ghostInput && typeof this.elements.ghostInput.focus === "function") {
        this.elements.ghostInput.focus({ preventScroll: true });
      }
    } else if (newRoute === Routes.SENSORY_FLASH) {
      // Ensure virtual keyboard does not flap open
      if (this.elements.ghostInput && typeof this.elements.ghostInput.blur === "function") {
        this.elements.ghostInput.blur();
      }
      if (this.elements.inlineInput && typeof this.elements.inlineInput.blur === "function") {
        this.elements.inlineInput.blur();
      }
    }

    // Wake Lock management
    if (newRoute === Routes.SENSORY_FLASH) {
      await this.requestWakeLock();
    } else if (prevRoute === Routes.SENSORY_FLASH) {
      await this.releaseWakeLock();
    }

    // Topbar suppression guardrail for Route 4 Sensory Flash
    if (typeof document !== "undefined") {
      const topbar = document.getElementById("topbar");
      if (topbar) {
        if (newRoute === Routes.SENSORY_FLASH) {
          topbar.setAttribute("inert", "");
        } else {
          topbar.removeAttribute("inert");
        }
      }
    }

    this.dispatchEvent(new CustomEvent("route-changed", { detail: { prevRoute, route: newRoute } }));

    // Re-mount current card in new route presentation if active
    if (this.activeCard) {
      this.mountCard(this.activeCard);
    }
  }

  async requestWakeLock() {
    const nav = typeof navigator !== "undefined" ? navigator : null;
    if (nav && "wakeLock" in nav && typeof nav.wakeLock?.request === "function") {
      try {
        this._wakeLockPromise = nav.wakeLock.request("screen");
        this._wakeLock = await this._wakeLockPromise;
        this._wakeLock.addEventListener?.("release", () => {
          this._wakeLock = null;
        });
      } catch {
        // Platform or battery-saver prevented wake lock
      }
    }
  }

  async releaseWakeLock() {
    if (this._wakeLockPromise) {
      try {
        await this._wakeLockPromise;
      } catch {}
      this._wakeLockPromise = null;
    }
    if (this._wakeLock) {
      try {
        await this._wakeLock.release();
      } catch {}
      this._wakeLock = null;
    }
  }

  cancelTimers() {
    if (this._hesitationTimer) {
      clearTimeout(this._hesitationTimer);
      this._hesitationTimer = null;
    }
    if (this._pacingTimer) {
      clearTimeout(this._pacingTimer);
      this._pacingTimer = null;
    }
    if (this._safetyHoldTimer) {
      clearTimeout(this._safetyHoldTimer);
      this._safetyHoldTimer = null;
    }
  }

  /* ----------------- Card Mounting ----------------- */

  /**
   * Mounts a card with route-specific staging, pacing, and input hooks.
   */
  mountCard(sourceCard) {
    this.cancelTimers();
    if (!sourceCard) {
      this.activeCard = null;
      this.phase = "empty";
      return;
    }

    this.phase = "answering";
    this.isComposing = false;
    const card = { ...sourceCard };

    // Route-specific transformations
    if (this.activeRoute === Routes.CONTEXT_CLOZE) {
      card.cloze = generateCloze(card, {
        lang: card.lang,
        viewMode: isCJK(card.prompt) ? "native" : "segmented"
      });
      if (card.cloze?.target) {
        card.activeTarget = card.cloze.target;
        card.answers = [card.cloze.target, ...(card.answers || [])];
      }
    } else if (this.activeRoute === Routes.VARIABLE_CLOZE) {
      card.cloze = generateCloze(card, {
        ledger: this.store?.tokenLedger,
        lang: card.lang,
        viewMode: isCJK(card.prompt) ? "native" : "segmented"
      });
      if (card.cloze?.target) {
        card.activeTarget = card.cloze.target;
        card.answers = [card.cloze.target, ...(card.answers || [])];
      }
    } else if (this.activeRoute === Routes.STRICT_PRODUCTION) {
      card.activeTarget = card.script || (Array.isArray(card.answers) ? card.answers[0] : card.answer);
    } else {
      card.activeTarget = Array.isArray(card.answers) ? card.answers[0] : card.answer;
    }

    this.activeCard = card;

    // Preload lookahead queue including stumble-recycled cards
    if (this.audio && typeof this.audio.preloadQueue === "function" && Array.isArray(this.queue)) {
      this.audio.preloadQueue(this.queue, this.currentIndex);
    }

    // Route-specific timer & audio initialization
    if (this.activeRoute === Routes.REFLEX) {
      // 3.0s hesitation timer
      this._hesitationTimer = setTimeout(() => {
        this.handleHesitationTimeout();
      }, HESITATION_THRESHOLD_MS);

      if (this.elements.ghostInput && typeof this.elements.ghostInput.focus === "function") {
        this.elements.ghostInput.focus({ preventScroll: true });
      }
    } else if (this.activeRoute === Routes.SENSORY_FLASH) {
      // Audio-first touch stage: play native asset or speech instantly (<20ms)
      if (this.audio) {
        this.audio.playCurrent(card);
      }
      // Pacing countdown timer: depletes over 2.0s
      this._pacingTimer = setTimeout(() => {
        this.handlePacingTimeout();
      }, PACING_COUNTDOWN_MS);
    } else if (this.activeRoute === Routes.STRICT_PRODUCTION) {
      if (this.elements.nativeInput && typeof this.elements.nativeInput.focus === "function") {
        this.elements.nativeInput.focus({ preventScroll: true });
      }
    }

    this.dispatchEvent(new CustomEvent("card-mounted", { detail: { card, route: this.activeRoute } }));
  }

  /* ----------------- Input & IME Event Handling ----------------- */

  handleCompositionStart(e) {
    this.isComposing = true;
    this.dispatchEvent(new CustomEvent("composition-start", { detail: e }));
  }

  handleCompositionUpdate(e) {
    this.isComposing = true;
    this.dispatchEvent(new CustomEvent("composition-update", { detail: e }));
  }

  handleCompositionEnd(e) {
    this.isComposing = false;
    this.dispatchEvent(new CustomEvent("composition-end", { detail: e }));
    // Note: In Route 5, compositionend does NOT auto-advance. Enter keydown is required.
  }

  /**
   * Called on raw input event.
   */
  handleInput(value) {
    if (!this.activeCard) return;

    // IME Composition Shielding: Never auto-advance while active IME composition is in flight
    if (this.isComposing) {
      return;
    }

    // Any input activity resets hesitation timer in Reflex mode
    if (this.activeRoute === Routes.REFLEX && this._hesitationTimer) {
      clearTimeout(this._hesitationTimer);
      this._hesitationTimer = setTimeout(() => this.handleHesitationTimeout(), HESITATION_THRESHOLD_MS);
    }

    // In Strict Production (Route 5), prefix-free auto-advance is disabled!
    if (this.activeRoute === Routes.STRICT_PRODUCTION) {
      return;
    }

    // In Routes 1, 2, and 3: prefix-free auto-advancement
    const target = this.activeCard.activeTarget || this.activeCard.answers;
    const aliases = this.activeCard.aliases || [];
    const isMatched = evaluateInput(value, target, aliases, {
      strict: false,
      deck: this.store?.currentDeck
    });

    if (isMatched) {
      this.advanceCard(true, value);
    }
  }

  /**
   * Called on keydown event.
   */
  handleKeyDown(e) {
    if (!this.activeCard) return;

    if (e.key === "Enter" && !this.isComposing) {
      if (this.activeRoute === Routes.STRICT_PRODUCTION) {
        // Route 5 explicit Enter submission: check confirmation
        const inputVal = e.target?.value ?? e.value ?? "";
        const target = this.activeCard.activeTarget || this.activeCard.script || this.activeCard.answers;
        const aliases = this.activeCard.aliases || [];
        const isMatched = evaluateInput(inputVal, target, aliases, {
          strict: true,
          deck: this.store?.currentDeck
        });

        if (isMatched) {
          this.advanceCard(true, inputVal);
        } else {
          // Typos in IME mode allow editable backspacing without immediate lock
          this.dispatchEvent(new CustomEvent("input-rejected", { detail: { value: inputVal, card: this.activeCard } }));
        }
      } else {
        // Enter in typing routes acts as give-up / reveal
        this.giveUp(e.target?.value || "");
      }
    }
  }

  /* ----------------- Touch Surface & Safety Lock (Route 4) ----------------- */

  handleTapSurface() {
    if (this.activeRoute !== Routes.SENSORY_FLASH || !this.activeCard) return;

    // Tap debounce protection: prevent rapid-fire skipping (under 200ms)
    const now = Date.now();
    if (now - this._lastTapTime < 200) {
      return;
    }
    this._lastTapTime = now;

    if (this.phase === "answering") {
      // Tap cancels countdown and reveals answer
      if (this._pacingTimer) {
        clearTimeout(this._pacingTimer);
        this._pacingTimer = null;
      }
      this.phase = "revealed";
      if (this.audio) {
        this.audio.playCurrent(this.activeCard);
      }
      this.dispatchEvent(new CustomEvent("card-revealed", { detail: { card: this.activeCard, mode: "tap" } }));
    } else if (this.phase === "revealed") {
      // Subsequent tap moves to next card
      this.advanceCard(true, "tap");
    }
  }

  handlePacingTimeout() {
    if (this.activeRoute !== Routes.SENSORY_FLASH || !this.activeCard) return;
    this.phase = "revealed";
    if (this.audio) {
      this.audio.playCurrent(this.activeCard);
    }
    this.dispatchEvent(new CustomEvent("card-revealed", { detail: { card: this.activeCard, mode: "pacing-timeout" } }));
  }

  startSafetyHold() {
    this._safetyHoldStart = Date.now();
    this.cancelTimers();
    this._safetyHoldTimer = setTimeout(() => {
      this.dispatchEvent(new CustomEvent("safety-unlocked"));
      this.switchRoute(Routes.REFLEX);
    }, SAFETY_HOLD_DURATION_MS);
  }

  cancelSafetyHold() {
    if (this._safetyHoldTimer) {
      clearTimeout(this._safetyHoldTimer);
      this._safetyHoldTimer = null;
      this.dispatchEvent(new CustomEvent("safety-cancelled"));
    }
  }

  /* ----------------- Advancement & Stumble Recovery ----------------- */

  handleHesitationTimeout() {
    if (this.activeRoute !== Routes.REFLEX || !this.activeCard) return;
    this.giveUp("hesitation-timeout");
  }

  giveUp(reason = "") {
    if (!this.activeCard) return;
    const failedCard = this.activeCard;
    this.phase = "revealed";
    this.cancelTimers();

    // Retain stumbled card in audio controller memory
    if (this.audio && typeof this.audio.retainStumbled === "function") {
      this.audio.retainStumbled(failedCard);
    }

    // Splice failed card 3-4 slots ahead in active queue
    this.spliceStumble(failedCard, 3);

    // Record miss in store and token ledger
    if (this.store) {
      this.store.record(failedCard, false);
    }

    this.dispatchEvent(new CustomEvent("stumble", { detail: { card: failedCard, reason } }));
  }

  advanceCard(success = true, value = "") {
    if (!this.activeCard) return;
    this.cancelTimers();
    this.phase = "advancing";

    if (this.audio) {
      if (typeof this.audio.stopAll === "function") {
        this.audio.stopAll();
      }
      if (success && typeof this.audio.clearStumbled === "function") {
        this.audio.clearStumbled(this.activeCard);
      }
    }

    if (this.store && success) {
      this.store.record(this.activeCard, true);
    }

    const isSpeedMode = this.store?.mode !== Modes.STRICT && this.activeRoute !== Routes.STRICT_PRODUCTION;
    const canonical = (this.activeCard.answers && this.activeCard.answers[0]) || this.activeCard.prompt || "";
    if (success && isSpeedMode) {
      this.dispatchEvent(new CustomEvent("visual-reinforcement", {
        detail: { card: this.activeCard, canonical, duration: 220 }
      }));
    }

    this.dispatchEvent(new CustomEvent("advance", { detail: { card: this.activeCard, success, value, canonical } }));

    // Step to next card in queue
    this.currentIndex++;
    if (this.currentIndex < this.queue.length) {
      this.mountCard(this.queue[this.currentIndex]);
    } else {
      this.dispatchEvent(new CustomEvent("queue-complete"));
    }
  }
}

