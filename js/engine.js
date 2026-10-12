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

/** Adapts a card's prompt, answer, and subtitle based on selected Front and Back fields. */
export function adaptCardRoles(card, frontField = "prompt", backField = "answer", showHints = true) {
  if (!card) return card;

  // Preserve canonical source fields so repeat adaptations or hint toggles never flip or lose data
  const sourcePrompt = card.sourcePrompt !== undefined ? card.sourcePrompt : card.prompt;
  const sourceAnswer = card.sourceAnswer !== undefined
    ? card.sourceAnswer
    : (Array.isArray(card.answers) && card.answers.length > 0 ? card.answers[0] : (card.answer || ""));
  const sourceSubtitle = card.sourceSubtitle !== undefined
    ? card.sourceSubtitle
    : (card.subtitle !== undefined ? card.subtitle : "");

  if (card.isCloze) {
    return {
      ...card,
      sourcePrompt,
      sourceAnswer,
      sourceSubtitle,
      canonicalHint: sourceSubtitle,
      subtitle: showHints ? sourceSubtitle : ""
    };
  }

  const getVal = (f) => {
    if (f === "prompt") return sourcePrompt;
    if (f === "answer") return sourceAnswer;
    if (f === "subtitle") return sourceSubtitle;
    return "";
  };

  let promptVal = getVal(frontField) || sourcePrompt;
  const answerVal = getVal(backField) || sourceAnswer;

  // If front is not the target prompt, ensure any highlight or annotation brackets are stripped
  if (frontField !== "prompt" && typeof promptVal === "string") {
    promptVal = promptVal.replace(/<[^>]+>/g, "").replace(/\[\[(.*?)\]\]/g, "$1");
  }

  // Remaining third field becomes the hint
  const allFields = ["prompt", "answer", "subtitle"];
  const remainingField = allFields.find((f) => f !== frontField && f !== backField);
  const canonicalHint = (remainingField ? getVal(remainingField) : sourceSubtitle) || "";
  const hintVal = showHints ? canonicalHint : "";

  return {
    ...card,
    sourcePrompt,
    sourceAnswer,
    sourceSubtitle,
    canonicalHint,
    prompt: promptVal,
    answers: [answerVal],
    subtitle: hintVal,
    isAdapted: frontField !== "prompt" || backField !== "answer",
    frontField,
    backField
  };
}

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
    store.addEventListener("fields-changed", () => this.next());
    store.addEventListener("hints-changed", ({ detail }) => {
      if (this.card) {
        const show = detail?.showHints !== undefined ? Boolean(detail.showHints) : this.store.showHints;
        const canonical = this.card.canonicalHint !== undefined
          ? this.card.canonicalHint
          : (this.card.sourceSubtitle !== undefined ? this.card.sourceSubtitle : (this.card.subtitle || ""));
        this.card.subtitle = show ? canonical : "";
        this.#emit("hint", { showHints: show });
      }
    });
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail: { card: this.card, phase: this.phase, ...detail } }));
  }

  /** Weighted random pick, never repeating the previous card. */
  pick() {
    let pool = this.store.pool();
    if (pool.length === 0) return null;
    if (pool.length > 1 && this.card) {
      const prevId = this.card.sourceId || this.card.id;
      pool = pool.filter((c) => c.id !== this.card.id && (c.sourceId || c.id) !== prevId);
      if (pool.length === 0) pool = this.store.pool();
    }
    const now = Date.now();
    const weights = pool.map((c) => this.store.weight(c, now));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    let chosen = pool[pool.length - 1];
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        chosen = pool[i];
        break;
      }
    }

    if (!chosen) return null;
    return adaptCardRoles(chosen, this.store.frontField, this.store.backField, this.store.showHints);
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
  input(value, isComposing = false) {
    if (!this.card) return;
    this.#emit("input", { value });
    if (isComposing) return;
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
