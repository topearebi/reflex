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

import { isMatch } from "./normalizer.js";

const ADVANCE_DELAY = 140;
const CORRECTION_DELAY = 220;

export class RecallEngine extends EventTarget {
  constructor(store) {
    super();
    this.store = store;
    this.card = null;
    this.phase = "empty";
    this._timer = null;

    const refresh = () => this.#onPoolChange();
    store.addEventListener("deck-changed", () => this.next());
    store.addEventListener("units-changed", refresh);
    store.addEventListener("deck-updated", refresh);
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail: { card: this.card, phase: this.phase, ...detail } }));
  }

  /** Weighted random pick, never repeating the previous card. */
  pick() {
    let pool = this.store.pool();
    if (pool.length === 0) return null;
    if (pool.length > 1 && this.card) pool = pool.filter((c) => c.id !== this.card.id);
    const now = Date.now();
    const weights = pool.map((c) => this.store.weight(c, now));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
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
    return isMatch(value, this.card.answers, this.store.mode, this.store.currentDeck);
  }

  /** Called on every keystroke. */
  input(value) {
    if (!this.card) return;
    if (this.phase === "answering" && this.#matches(value)) {
      this.phase = "advancing";
      this.store.record(this.card, true);
      this.#emit("correct");
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
      this.#emit("miss", { attempt, answer: this.card.answers[0] });
    } else if (this.phase === "correcting") {
      this.#emit("nudge");
    }
  }
}
