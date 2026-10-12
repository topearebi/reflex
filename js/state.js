/**
 * js/state.js — decks, progress and preferences.
 *
 * Three things are kept apart so none can clobber another:
 *   content   Built-in decks come from data/*.json every launch (never copied
 *             into storage). Your own decks, and cards you add to built-in
 *             decks, live in `customDecks` / `extraCards`.
 *   progress  Per card, keyed "deckId::cardId": weight, attempts, correct, last seen.
 *   prefs     Current deck, plus per-deck checking mode and selected units.
 */

import { Modes, effectiveMode } from "./normalizer.js";

const STORAGE_KEY = "speedrecall_v3";
const LEGACY_KEY = "speedrecall_state_v2";
const MANIFEST_URL = "./data/manifest.json";

const DAY = 86400000;
const HALF_LIFE_DAYS = 7; // learned weights drift back to neutral over time
const MIN_WEIGHT = 0.2;
const MAX_WEIGHT = 6;

export const unitKey = (card) => `${card.group || "General"}::${card.unit || "General"}`;

function emptyState() {
  return {
    version: 3,
    customDecks: {},
    extraCards: {},
    deletedDecks: {},
    progress: {},
    prefs: { currentDeckId: "", decks: {} },
    sync: { lastSynced: null }
  };
}

/** Accepts `answer: "x"` or `answers: ["x", ...]`; returns a clean card. */
export function normalizeCard(raw, fallbackId) {
  if (!raw || typeof raw !== "object") return null;
  const answers = (Array.isArray(raw.answers) ? raw.answers : [raw.answer])
    .map((a) => String(a ?? "").trim())
    .filter(Boolean);
  const prompt = String(raw.prompt ?? "").trim();
  if (!prompt || answers.length === 0) return null;
  return {
    id: String(raw.id || fallbackId),
    group: String(raw.group || "General").trim(),
    unit: String(raw.unit || "General").trim(),
    prompt,
    subtitle: raw.subtitle ? String(raw.subtitle).trim() : "",
    answers
  };
}

function normalizeDeckMeta(raw = {}) {
  return {
    name: String(raw.name || "Untitled deck").trim(),
    lang: raw.lang || "",
    answerLang: raw.answerLang || "",
    romanization: raw.romanization || "",
    dir: raw.dir || "",
    defaultMode: raw.defaultMode || Modes.STANDARD
  };
}

export class Store extends EventTarget {
  constructor() {
    super();
    this.state = emptyState();
    this.builtIn = {}; // id -> deck (from data files)
    this.builtInOrder = [];
    this.session = { correct: 0, attempts: 0, streak: 0 };
    this._deckCache = new Map();
  }

  /* ---------- lifecycle ---------- */

  async init() {
    this.state = this.#load();
    await this.#loadBuiltIns();
    this.#migrateLegacy();
    const ids = this.deckIds();
    if (!this.decksExists(this.state.prefs.currentDeckId)) {
      this.state.prefs.currentDeckId = this.defaultDeckId || ids[0] || "";
    }
    this.save();
  }

  #load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.version === 3) return { ...emptyState(), ...parsed };
      }
    } catch (err) {
      console.warn("Could not read saved state", err);
    }
    return emptyState();
  }

  save() {
    this._deckCache.clear();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (err) {
      console.error("Could not save state", err);
      this.dispatchEvent(new CustomEvent("save-failed"));
    }
  }

  async #loadBuiltIns() {
    try {
      const res = await fetch(MANIFEST_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = await res.json();
      this.defaultDeckId = manifest.defaultDeckId;
      const results = await Promise.all(
        manifest.decks.map(async (entry) => {
          try {
            const r = await fetch(entry.file, { cache: "no-cache" });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            const cards = (data.cards || [])
              .map((c, i) => normalizeCard(c, `${entry.id}-${i}`))
              .filter(Boolean);
            return [entry.id, { ...normalizeDeckMeta({ ...data, ...entry }), cards, builtIn: true }];
          } catch (err) {
            console.warn(`Could not load deck ${entry.file}`, err);
            return null;
          }
        })
      );
      for (const r of results) {
        if (!r) continue;
        this.builtIn[r[0]] = r[1];
        this.builtInOrder.push(r[0]);
      }
    } catch (err) {
      console.warn("Could not load built-in decks", err);
    }
  }

  /** One-off import of the old v2 storage format. */
  #migrateLegacy() {
    let raw;
    try {
      raw = localStorage.getItem(LEGACY_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const old = JSON.parse(raw);
      this.importLegacyDecks(old.decks || {});
      if (old.currentDeckId) this.state.prefs.currentDeckId = old.currentDeckId;
      localStorage.removeItem(LEGACY_KEY);
    } catch (err) {
      console.warn("Legacy migration skipped", err);
    }
  }

  /** Old format: { deckId: { name, defaultMode, cards: [{..., weight}] } } */
  importLegacyDecks(decks) {
    const now = Date.now();
    for (const [deckId, deck] of Object.entries(decks)) {
      if (!deck || !Array.isArray(deck.cards)) continue;
      if (this.builtIn[deckId]) {
        const known = new Set(this.builtIn[deckId].cards.map((c) => c.id));
        const extras = [];
        for (const c of deck.cards) {
          if (known.has(c.id)) {
            if (typeof c.weight === "number" && c.weight !== 1) {
              this.state.progress[`${deckId}::${c.id}`] = { w: c.weight, n: 1, c: 0, t: now };
            }
          } else {
            const card = normalizeCard(c, `card-${now}-${extras.length}`);
            if (card) extras.push(card);
          }
        }
        if (extras.length) this.addCards(deckId, extras, { silent: true });
      } else {
        const cards = deck.cards.map((c, i) => normalizeCard(c, `card-${now}-${i}`)).filter(Boolean);
        this.state.customDecks[deckId] = {
          ...normalizeDeckMeta({ ...deck, defaultMode: Modes.STANDARD }),
          cards,
          updated: now
        };
      }
    }
  }

  /* ---------- decks ---------- */

  deckIds() {
    return [...this.builtInOrder, ...Object.keys(this.state.customDecks)];
  }

  decksExists(id) {
    return Boolean(id && (this.builtIn[id] || this.state.customDecks[id]));
  }

  getDeck(id = this.currentDeckId) {
    if (this._deckCache.has(id)) return this._deckCache.get(id);
    let deck = null;
    if (this.builtIn[id]) {
      const extra = this.state.extraCards[id] || [];
      deck = { id, ...this.builtIn[id], cards: [...this.builtIn[id].cards, ...extra] };
    } else if (this.state.customDecks[id]) {
      deck = { id, ...this.state.customDecks[id], builtIn: false };
    }
    if (deck) this._deckCache.set(id, deck);
    return deck;
  }

  get currentDeckId() {
    return this.state.prefs.currentDeckId;
  }

  get currentDeck() {
    return this.getDeck(this.currentDeckId);
  }

  setDeck(id) {
    if (!this.decksExists(id) || id === this.currentDeckId) return;
    this.state.prefs.currentDeckId = id;
    this.resetSession();
    this.save();
    this.dispatchEvent(new CustomEvent("deck-changed"));
  }

  #deckPrefs(id = this.currentDeckId) {
    const p = this.state.prefs.decks;
    if (!p[id]) p[id] = { mode: null, units: null };
    return p[id];
  }

  get mode() {
    const deck = this.currentDeck;
    return effectiveMode(this.#deckPrefs().mode || deck?.defaultMode, deck);
  }

  setMode(mode) {
    this.#deckPrefs().mode = mode;
    this.save();
    this.dispatchEvent(new CustomEvent("mode-changed"));
  }

  /** { group: { unit: cards[] } } in file order. */
  hierarchy(deck = this.currentDeck) {
    const out = {};
    for (const card of deck?.cards || []) {
      const g = card.group || "General";
      const u = card.unit || "General";
      ((out[g] ||= {})[u] ||= []).push(card);
    }
    return out;
  }

  allUnitKeys(deck = this.currentDeck) {
    return [...new Set((deck?.cards || []).map(unitKey))];
  }

  /** Selected units for the current deck. Defaults to the first unit for a fresh deck. */
  get selectedUnits() {
    const prefs = this.#deckPrefs();
    const all = this.allUnitKeys();
    if (!Array.isArray(prefs.units)) return new Set(all.slice(0, 1));
    const valid = new Set(all);
    return new Set(prefs.units.filter((k) => valid.has(k)));
  }

  setUnits(keys) {
    this.#deckPrefs().units = [...keys];
    this.save();
    this.dispatchEvent(new CustomEvent("units-changed"));
  }

  toggleUnits(keys, on) {
    const sel = this.selectedUnits;
    for (const k of keys) on ? sel.add(k) : sel.delete(k);
    this.setUnits(sel);
  }

  pool() {
    const sel = this.selectedUnits;
    return (this.currentDeck?.cards || []).filter((c) => sel.has(unitKey(c)));
  }

  /* ---------- progress ---------- */

  #pkey(card, deckId = this.currentDeckId) {
    return `${deckId}::${card.id}`;
  }

  /** Weight with time decay toward 1.0 (neutral). */
  weight(card, now = Date.now()) {
    const p = this.state.progress[this.#pkey(card)];
    if (!p) return 1;
    const days = Math.max(0, (now - p.t) / DAY);
    return 1 + (p.w - 1) * Math.pow(0.5, days / HALF_LIFE_DAYS);
  }

  /** 0..1 — how well a card is known. Unseen = 0. */
  mastery(card) {
    if (!this.state.progress[this.#pkey(card)]) return 0;
    const w = this.weight(card);
    return Math.max(0, Math.min(1, (1 - w) / (1 - MIN_WEIGHT)));
  }

  unitMastery(cards) {
    if (!cards.length) return 0;
    return cards.reduce((s, c) => s + this.mastery(c), 0) / cards.length;
  }

  record(card, correct) {
    const key = this.#pkey(card);
    const w = this.weight(card);
    const prev = this.state.progress[key] || { n: 0, c: 0 };
    this.state.progress[key] = {
      w: correct ? Math.max(MIN_WEIGHT, w * 0.7) : Math.min(MAX_WEIGHT, w + 1.5),
      n: prev.n + 1,
      c: prev.c + (correct ? 1 : 0),
      t: Date.now()
    };
    const s = this.session;
    s.attempts++;
    if (correct) {
      s.correct++;
      s.streak++;
    } else {
      s.streak = 0;
    }
    this.save();
    this.dispatchEvent(new CustomEvent("stats-changed"));
  }

  resetSession() {
    this.session = { correct: 0, attempts: 0, streak: 0 };
    this.dispatchEvent(new CustomEvent("stats-changed"));
  }

  /* ---------- editing content ---------- */

  addCards(deckId, cards, { silent = false } = {}) {
    if (this.builtIn[deckId]) {
      (this.state.extraCards[deckId] ||= []).push(...cards);
    } else if (this.state.customDecks[deckId]) {
      const d = this.state.customDecks[deckId];
      d.cards.push(...cards);
      d.updated = Date.now();
    } else {
      return;
    }
    // Make new units visible straight away
    const prefs = this.state.prefs.decks[deckId];
    if (prefs && Array.isArray(prefs.units)) {
      prefs.units = [...new Set([...prefs.units, ...cards.map(unitKey)])];
    }
    if (!silent) {
      this.save();
      this.dispatchEvent(new CustomEvent("deck-updated"));
    }
  }

  createDeck(meta, cards) {
    const base = String(meta.name || "deck").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
    let id = `my-${base || "deck"}`;
    let n = 2;
    while (this.decksExists(id)) id = `my-${base}-${n++}`;
    this.state.customDecks[id] = { ...normalizeDeckMeta(meta), cards, updated: Date.now() };
    delete this.state.deletedDecks[id];
    this.state.prefs.decks[id] = { mode: null, units: [...new Set(cards.map(unitKey))] };
    this.save();
    this.setDeck(id);
    return id;
  }

  deleteDeck(id) {
    if (!this.state.customDecks[id]) return;
    delete this.state.customDecks[id];
    delete this.state.prefs.decks[id];
    this.state.deletedDecks[id] = Date.now();
    for (const k of Object.keys(this.state.progress)) {
      if (k.startsWith(`${id}::`)) delete this.state.progress[k];
    }
    if (this.currentDeckId === id) this.state.prefs.currentDeckId = this.defaultDeckId || this.deckIds()[0];
    this.save();
    this.resetSession();
    this.dispatchEvent(new CustomEvent("deck-changed"));
  }

  resetProgress() {
    this.state.progress = {};
    this.save();
    this.resetSession();
    this.dispatchEvent(new CustomEvent("deck-updated"));
  }

  /* ---------- backup / sync payload ---------- */

  exportData() {
    const { customDecks, extraCards, deletedDecks, progress, prefs } = this.state;
    return { app: "speedrecall", schema: 3, exported: new Date().toISOString(), customDecks, extraCards, deletedDecks, progress, prefs };
  }

  /**
   * Merges a backup/sync payload into local state. Never deletes local cards;
   * for progress, the most recently practised record wins.
   * Also accepts the old v1/v2 `{ decks: {...} }` format.
   */
  mergeData(data, { adoptPrefs = false } = {}) {
    if (!data || typeof data !== "object") throw new Error("Not a SpeedRecall backup.");
    if (data.schema !== 3) {
      const legacy = data.decks && typeof data.decks === "object" ? data.decks : data;
      const looksLegacy = Object.values(legacy).some((d) => d && Array.isArray(d.cards));
      if (!looksLegacy) throw new Error("Not a SpeedRecall backup.");
      this.importLegacyDecks(legacy);
      this.save();
      this.dispatchEvent(new CustomEvent("deck-changed"));
      return;
    }

    const s = this.state;

    // Deletions (tombstones) first
    for (const [id, t] of Object.entries(data.deletedDecks || {})) {
      s.deletedDecks[id] = Math.max(s.deletedDecks[id] || 0, t);
    }

    // Custom decks: union; newer `updated` wins metadata; cards merged by id
    for (const [id, remote] of Object.entries(data.customDecks || {})) {
      if (!remote || !Array.isArray(remote.cards)) continue;
      const local = s.customDecks[id];
      const cards = remote.cards.map((c, i) => normalizeCard(c, `${id}-${i}`)).filter(Boolean);
      if (!local) {
        s.customDecks[id] = { ...normalizeDeckMeta(remote), cards, updated: remote.updated || Date.now() };
      } else {
        const ids = new Set(local.cards.map((c) => c.id));
        local.cards.push(...cards.filter((c) => !ids.has(c.id)));
        if ((remote.updated || 0) > (local.updated || 0)) {
          Object.assign(local, normalizeDeckMeta(remote), { cards: local.cards, updated: remote.updated });
        }
      }
    }
    for (const [id, t] of Object.entries(s.deletedDecks)) {
      if (s.customDecks[id] && (s.customDecks[id].updated || 0) <= t) delete s.customDecks[id];
    }

    // Extra cards on built-in decks: union by id
    for (const [deckId, cards] of Object.entries(data.extraCards || {})) {
      const local = (s.extraCards[deckId] ||= []);
      const ids = new Set(local.map((c) => c.id));
      for (const raw of cards || []) {
        const c = normalizeCard(raw, `card-${Date.now()}`);
        if (c && !ids.has(c.id)) local.push(c);
      }
    }

    // Progress: latest wins
    for (const [k, p] of Object.entries(data.progress || {})) {
      if (!p || typeof p.w !== "number") continue;
      if (!s.progress[k] || (p.t || 0) > (s.progress[k].t || 0)) s.progress[k] = p;
    }

    // Per-deck prefs: fill gaps (or adopt fully on first sync of a new device)
    for (const [id, p] of Object.entries(data.prefs?.decks || {})) {
      if (adoptPrefs || !s.prefs.decks[id]) s.prefs.decks[id] = p;
    }

    if (!this.decksExists(s.prefs.currentDeckId)) s.prefs.currentDeckId = this.defaultDeckId || this.deckIds()[0];
    this.save();
    this.dispatchEvent(new CustomEvent("deck-changed"));
  }
}
