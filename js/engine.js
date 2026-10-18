/**
 * js/engine.js — the drill loop.
 *
 *   answering   Type; the card advances the instant the input matches.
 *               Enter (or Reveal) gives up: counts as a miss.
 *   correcting  After a miss the answer is shown and must be typed correctly
 *               to move on. Nothing else advances the card.
 *   advancing   Brief lock after a match so a stray Enter can't score a miss.
 *   empty       No units selected.
 */

import { evaluateInput, isMatch, Modes } from "./normalizer.js";
import { hasLegacyCloze, generateCloze } from "./cloze.js";

const ADVANCE_DELAY = 140;
const CORRECTION_DELAY = 220;

export class RecallEngine extends EventTarget {
  constructor(store) {
    super();
    this.store = store;
    this.card = null;
    this.phase = "empty";
    this._timer = null;
    this.activePromptRole = "prompt";
    this.activeTargetRole = "answer";

    const refresh = () => this.#onPoolChange();
    store.addEventListener("deck-changed", () => this.next());
    store.addEventListener("units-changed", refresh);
    store.addEventListener("deck-updated", refresh);
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail: { card: this.card, phase: this.phase, ...detail } }));
  }

  /**
   * Applies activePromptRole and activeTargetRole transformations to a card instance.
   */
  #applyRoles(card) {
    if (!card) return null;
    if (!card._original) {
      card._original = {
        prompt: card.prompt,
        answer: card.answer,
        answers: card.answers ? [...card.answers] : (card.answer ? [card.answer] : []),
        subtitle: card.subtitle,
        script: card.script,
        phonetic: card.phonetic,
        gloss: card.gloss,
        aliases: card.aliases ? [...card.aliases] : []
      };
    }
    const orig = card._original;
    const pRole = this.activePromptRole || "prompt";
    const tRole = this.activeTargetRole || "answer";

    if (pRole === "prompt" && tRole === "answer") {
      card.prompt = orig.prompt;
      card.answers = [...orig.answers];
      card.answer = orig.answers[0] || orig.answer;
      return card;
    }

    if (pRole === "answer" && tRole === "prompt") {
      card.prompt = orig.answers[0] || orig.answer;
      card.answers = [orig.prompt];
      card.answer = orig.prompt;
      return card;
    }

    const getVal = (role, defaultVal) => {
      if (role === "script") return orig.script || orig.prompt || defaultVal;
      if (role === "phonetic") return orig.phonetic || orig.answers[0] || orig.subtitle || defaultVal;
      if (role === "gloss") return orig.gloss || orig.subtitle || orig.prompt || defaultVal;
      if (role === "answer") return orig.answers[0] || orig.answer || defaultVal;
      if (role === "prompt") return orig.prompt || defaultVal;
      return defaultVal;
    };

    const promptVal = getVal(pRole, orig.prompt);
    const targetVal = getVal(tRole, orig.answers[0] || orig.answer);

    card.prompt = promptVal;
    card.answers = [targetVal];
    card.answer = targetVal;
    return card;
  }

  /**
   * Sets the active prompt and target roles and re-renders current card if present.
   */
  setRoles(promptRole = "prompt", targetRole = "answer") {
    this.activePromptRole = promptRole;
    this.activeTargetRole = targetRole;
    if (this.card) {
      this.card = this.#applyRoles(this.card);
      this.#emit("card");
    }
  }

  /**
   * Instantly flips Front (prompt) and Back (target) roles and re-renders active card.
   */
  flipRoles() {
    const prevP = this.activePromptRole || "prompt";
    const prevT = this.activeTargetRole || "answer";
    this.activePromptRole = prevT;
    this.activeTargetRole = prevP;
    if (this.card) {
      this.card = this.#applyRoles(this.card);
      this.#emit("card");
    }
  }

  /**
   * Prepares a session-derived card instance without mutating the source card definition.
   */
  #prepareCard(sourceCard) {
    if (!sourceCard) return null;
    const card = { ...sourceCard };

    // Dynamically generate cloze structure if prompt contains legacy or sentence markup
    if (hasLegacyCloze(card.prompt) || card.isCloze) {
      card.cloze = generateCloze(card, { ledger: this.store.tokenLedger });
      if (card.cloze?.target) {
        card.answers = [card.cloze.target, ...(card.answers || [])];
      }
    }
    return this.#applyRoles(card);
  }

  /** Weighted random pick, never repeating the previous card, prioritizing due stumbles. */
  pick() {
    // 1. Dynamic stumble re-insertion check
    if (this.store.stumbleQueue && this.store.stumbleQueue.length > 0) {
      const attempts = this.store.session.attempts;
      const stumbleIndex = this.store.stumbleQueue.findIndex(
        (c) => c._dueAfter <= attempts && (!this.card || c.id !== this.card.id)
      );
      if (stumbleIndex !== -1) {
        const [stumbledCard] = this.store.stumbleQueue.splice(stumbleIndex, 1);
        return this.#prepareCard(stumbledCard);
      }
    }

    // 2. Regular roulette pick from selected pool
    let pool = this.store.pool();
    if (pool.length === 0) return null;
    if (pool.length > 1 && this.card) pool = pool.filter((c) => c.id !== this.card.id);
    const now = Date.now();
    const weights = pool.map((c) => this.store.weight(c, now));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return this.#prepareCard(pool[i]);
    }
    return this.#prepareCard(pool[pool.length - 1]);
  }

  next() {
    clearTimeout(this._timer);
    this.card = this.pick();
    this.phase = this.card ? "answering" : "empty";
    this.#emit("card");
  }

  #onPoolChange() {
    const inPool = this.card && this.store.pool().some((c) => c.id === this.card.id);
    if (!inPool || this.phase === "empty") this.next();
    else this.#emit("pool");
  }

  #matches(value) {
    return evaluateInput(value, this.card.answers, this.card.aliases, {
      mode: this.store.mode,
      deck: this.store.currentDeck
    });
  }

  /** Called on every keystroke. */
  input(value) {
    if (!this.card) return;
    if (this.phase === "answering" && this.#matches(value)) {
      this.phase = "advancing";
      this.store.record(this.card, true);
      const isSpeedMode = this.store.mode !== Modes.STRICT;
      const canonical = (this.card.answers && this.card.answers[0]) || this.card.prompt || "";
      if (isSpeedMode) {
        this.dispatchEvent(new CustomEvent("visual-reinforcement", {
          detail: { card: this.card, canonical, duration: 220 }
        }));
      }
      this.#emit("correct", { card: this.card, canonical, isSpeedMode });
      this._timer = setTimeout(() => this.next(), ADVANCE_DELAY);
    } else if (this.phase === "correcting" && this.#matches(value)) {
      this.phase = "advancing";
      this.#emit("corrected");
      this._timer = setTimeout(() => this.next(), CORRECTION_DELAY);
    }
  }

  /** Enter key / Reveal button. */
  giveUp(attempt = "") {
    if (this.phase === "answering") {
      this.phase = "correcting";
      this.store.record(this.card, false);
      this.#emit("miss", { card: this.card, attempt, answer: this.card.answers[0] });
    } else if (this.phase === "correcting") {
      this.#emit("nudge");
    }
  }
}
