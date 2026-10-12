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
import { expandClozeCard } from "./cloze.js";

const STORAGE_KEY = "speedrecall_v3";
const LEGACY_KEY = "speedrecall_state_v2";
const MANIFEST_URL = "./data/manifest.json";

const DAY = 86400000;
const HALF_LIFE_DAYS = 7; // learned weights drift back to neutral over time
const MIN_WEIGHT = 0.2;
const MAX_WEIGHT = 6;

export const unitKey = (card) => `${card.group || "General"}::${card.unit || "General"}`;

export function cardContentHash(card) {
  if (!card) return "";
  const p = String(card.prompt || "").trim().toLowerCase();
  const a = (Array.isArray(card.answers) ? card.answers : [card.answer || ""])
    .map((s) => String(s || "").trim().toLowerCase())
    .sort()
    .join("|");
  const h = String(card.subtitle || card.hint || "").trim().toLowerCase();
  const str = `${p}:::${a}:::${h}`;
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function emptyState() {
  return {
    version: 4,
    customDecks: {},
    extraCards: {},
    deckOverrides: {},
    deletedDecks: {},
    progress: {},
    hashIndex: {},
    prefs: { currentDeckId: "", reverseMode: false, showHints: false, decks: {} },
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
  const subtitle = raw.subtitle ? String(raw.subtitle).trim() : (raw.hint ? String(raw.hint).trim() : "");
  const card = {
    id: String(raw.id || fallbackId),
    group: String(raw.group || "General").trim(),
    unit: String(raw.unit || "General").trim(),
    prompt,
    subtitle,
    answers
  };
  card.hash = raw.hash || cardContentHash(card);
  return card;
}

export function getDeckFieldOptions(deck) {
  if (!deck) {
    return [
      { value: "prompt", label: "Target Language" },
      { value: "answer", label: "Native Language" }
    ];
  }
  const isPinyin = deck.romanization === "pinyin";
  if (isPinyin) {
    return [
      { value: "prompt", label: "Target Language (Hanzi)" },
      { value: "answer", label: "Hint / Romanization (Pinyin)" },
      { value: "subtitle", label: "Native Language (English)" }
    ];
  }
  const hasSubtitle = (deck.rawCards || deck.cards || []).some((c) => Boolean(c.subtitle));
  const fields = [
    { value: "prompt", label: "Target Language" },
    { value: "answer", label: "Native Language" }
  ];
  if (hasSubtitle) {
    fields.push({ value: "subtitle", label: "Hint / Notes" });
  }
  return fields;
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
    if (this.state.deckOverrides?.[id]) {
      const override = this.state.deckOverrides[id];
      const rawCards = override.cards || [];
      const cards = rawCards.flatMap((c) => expandClozeCard(c));
      deck = { id, ...override, rawCards, cards, builtIn: Boolean(this.builtIn[id]), isOverride: true };
    } else if (this.builtIn[id]) {
      const extra = this.state.extraCards[id] || [];
      const rawCards = [...this.builtIn[id].cards, ...extra];
      const cards = rawCards.flatMap((c) => expandClozeCard(c));
      deck = { id, ...this.builtIn[id], rawCards, cards, isOverride: false };
    } else if (this.state.customDecks[id]) {
      const rawCards = this.state.customDecks[id].cards || [];
      const cards = rawCards.flatMap((c) => expandClozeCard(c));
      deck = { id, ...this.state.customDecks[id], rawCards, cards, builtIn: false, isOverride: false };
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

  get frontField() {
    return this.#deckPrefs().frontField || "prompt";
  }

  get backField() {
    return this.#deckPrefs().backField || "answer";
  }

  setDeckFields(frontField, backField) {
    const p = this.#deckPrefs();
    p.frontField = frontField;
    p.backField = backField;
    this.save();
    this.dispatchEvent(new CustomEvent("fields-changed"));
  }

  swapDeckFields() {
    const p = this.#deckPrefs();
    const prevFront = p.frontField || "prompt";
    const prevBack = p.backField || "answer";
    p.frontField = prevBack;
    p.backField = prevFront;
    this.save();
    this.dispatchEvent(new CustomEvent("fields-changed"));
    return { front: p.frontField, back: p.backField };
  }

  get showHints() {
    return Boolean(this.state.prefs.showHints);
  }

  setShowHints(show) {
    this.state.prefs.showHints = Boolean(show);
    this.save();
    this.dispatchEvent(new CustomEvent("hints-changed", { detail: { showHints: this.showHints } }));
  }

  toggleHints() {
    this.setShowHints(!this.showHints);
    return this.showHints;
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
    if (!p[id]) p[id] = { mode: null, units: null, frontField: "prompt", backField: "answer" };
    if (!p[id].frontField) p[id].frontField = "prompt";
    if (!p[id].backField) p[id].backField = "answer";
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
    if (!card) return `${deckId}::unknown`;
    const idKey = `${deckId}::${card.id}`;
    if (this.state.progress[idKey]) return idKey;

    // Content hash fallback: if card ID was changed or re-indexed externally
    const cardHash = card.hash || cardContentHash(card);
    if (cardHash) {
      this.state.hashIndex ||= {};
      const mappedId = this.state.hashIndex[`${deckId}::${cardHash}`];
      if (mappedId && this.state.progress[`${deckId}::${mappedId}`]) {
        const rec = this.state.progress[`${deckId}::${mappedId}`];
        this.state.progress[idKey] = rec;
        this.state.hashIndex[`${deckId}::${cardHash}`] = card.id;
        return idKey;
      }
      for (const [k, rec] of Object.entries(this.state.progress)) {
        if (k.startsWith(`${deckId}::`) && rec?.hash === cardHash) {
          this.state.progress[idKey] = rec;
          this.state.hashIndex[`${deckId}::${cardHash}`] = card.id;
          return idKey;
        }
      }
    }
    return idKey;
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
    const hash = card.hash || cardContentHash(card);
    this.state.progress[key] = {
      w: correct ? Math.max(MIN_WEIGHT, w * 0.7) : Math.min(MAX_WEIGHT, w + 1.5),
      n: prev.n + 1,
      c: prev.c + (correct ? 1 : 0),
      t: Date.now(),
      hash
    };
    if (hash) {
      this.state.hashIndex ||= {};
      this.state.hashIndex[`${this.currentDeckId}::${hash}`] = card.id;
    }
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

  updateDeck(id, meta, cards) {
    if (!this.state.customDecks[id]) return;
    this.state.customDecks[id] = {
      ...this.state.customDecks[id],
      ...normalizeDeckMeta(meta),
      cards,
      updated: Date.now()
    };
    this._deckCache.clear();
    const prefs = this.state.prefs.decks[id];
    if (prefs && Array.isArray(prefs.units)) {
      prefs.units = [...new Set([...prefs.units, ...cards.map(unitKey)])];
    }
    this.save();
    this.dispatchEvent(new CustomEvent("deck-updated"));
  }

  overrideBuiltInDeck(id, meta, cards) {
    (this.state.deckOverrides ||= {})[id] = {
      ...normalizeDeckMeta(meta),
      cards,
      updated: Date.now()
    };
    this._deckCache.clear();
    const prefs = this.state.prefs.decks[id];
    if (prefs && Array.isArray(prefs.units)) {
      prefs.units = [...new Set([...prefs.units, ...cards.map(unitKey)])];
    }
    this.save();
    this.dispatchEvent(new CustomEvent("deck-updated"));
  }

  revertBuiltInDeck(id) {
    if (this.state.deckOverrides?.[id]) {
      delete this.state.deckOverrides[id];
      this._deckCache.clear();
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

  /* ---------- modular deck import / export ---------- */

  importSingleDeck(deckObj) {
    if (!deckObj || typeof deckObj !== "object") throw new Error("Invalid deck data.");
    const id = String(deckObj.id || `deck-${Date.now()}`).trim();
    const rawCards = Array.isArray(deckObj.cards) ? deckObj.cards : [];
    const cards = rawCards.map((c, i) => normalizeCard(c, `${id}-${i}`)).filter(Boolean);
    const meta = normalizeDeckMeta(deckObj);
    const updated = deckObj.updated || Date.now();

    this.state.customDecks[id] = {
      id,
      ...meta,
      units: deckObj.units || [...new Set(cards.map(unitKey))],
      cards,
      updated
    };

    delete this.state.deletedDecks[id];
    this._deckCache.delete(id);

    // Index card hashes and re-link any existing progress
    this.state.hashIndex ||= {};
    for (const c of cards) {
      if (c.hash) {
        this.state.hashIndex[`${id}::${c.hash}`] = c.id;
        // Check if progress exists under an older card id with this hash
        for (const [k, rec] of Object.entries(this.state.progress)) {
          if (k.startsWith(`${id}::`) && rec?.hash === c.hash && k !== `${id}::${c.id}`) {
            this.state.progress[`${id}::${c.id}`] = rec;
          }
        }
      }
    }

    if (!this.state.prefs.currentDeckId) {
      this.state.prefs.currentDeckId = id;
    }
    this.save();
    this.dispatchEvent(new CustomEvent("deck-changed"));
    this.dispatchEvent(new CustomEvent("deck-updated"));
    return this.getDeck(id);
  }

  exportDeck(id = this.currentDeckId) {
    const deck = this.getDeck(id);
    if (!deck) throw new Error("Deck not found");
    return {
      id: deck.id,
      name: deck.name,
      lang: deck.lang || "",
      answerLang: deck.answerLang || "",
      romanization: deck.romanization || "",
      dir: deck.dir || "",
      defaultMode: deck.defaultMode || Modes.STANDARD,
      units: deck.units || [...new Set((deck.cards || []).map(unitKey))],
      updated: deck.updated || Date.now(),
      cards: (deck.rawCards || deck.cards || []).map((c) => ({
        id: c.id,
        group: c.group || "General",
        unit: c.unit || "General",
        prompt: c.prompt,
        subtitle: c.subtitle || "",
        answers: c.answers,
        hash: c.hash || cardContentHash(c)
      }))
    };
  }

  exportProgress() {
    return {
      app: "speedrecall",
      type: "progress",
      version: 4,
      exported: new Date().toISOString(),
      progress: this.state.progress,
      hashIndex: this.state.hashIndex || {},
      deletedDecks: this.state.deletedDecks,
      prefs: this.state.prefs
    };
  }

  /* ---------- backup / sync payload ---------- */

  exportData() {
    const { customDecks, extraCards, deckOverrides, deletedDecks, progress, prefs, hashIndex } = this.state;
    const manifest = {
      decks: this.deckIds().map((id) => {
        const d = this.getDeck(id);
        return {
          id: d?.id || id,
          name: d?.name || id,
          cardCount: (d?.rawCards || d?.cards || []).length,
          builtIn: Boolean(this.builtIn[id])
        };
      })
    };
    return {
      app: "speedrecall",
      schema: 4,
      exported: new Date().toISOString(),
      manifest,
      customDecks,
      extraCards,
      deckOverrides: deckOverrides || {},
      deletedDecks,
      progress,
      hashIndex: hashIndex || {},
      prefs
    };
  }

  /**
   * Merges a backup/sync payload into local state. Never deletes local cards;
   * for progress, the most recently practised record wins.
   * Also accepts single-deck exports, decoupled progress files, and legacy formats.
   */
  mergeData(data, { adoptPrefs = false } = {}) {
    if (!data || typeof data !== "object") throw new Error("Not a SpeedRecall backup.");

    // Case 1: Single modular deck file
    if (data.cards && Array.isArray(data.cards) && (data.name || data.id)) {
      this.importSingleDeck(data);
      return;
    }

    // Case 2: Decoupled progress-only payload
    if (data.type === "progress" && data.progress) {
      for (const [k, p] of Object.entries(data.progress)) {
        if (!p || typeof p.w !== "number") continue;
        if (!this.state.progress[k] || (p.t || 0) > (this.state.progress[k].t || 0)) {
          this.state.progress[k] = p;
        }
      }
      if (data.deletedDecks) {
        for (const [id, t] of Object.entries(data.deletedDecks)) {
          this.state.deletedDecks[id] = Math.max(this.state.deletedDecks[id] || 0, t);
        }
      }
      if (data.hashIndex) {
        this.state.hashIndex = Object.assign(this.state.hashIndex || {}, data.hashIndex);
      }
      this.save();
      this.dispatchEvent(new CustomEvent("deck-updated"));
      return;
    }

    // Case 3: Legacy format (< schema 3)
    if (data.schema !== 4 && data.schema !== 3) {
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

    // Custom decks: union; newer `updated` wins metadata; cards merged by id or hash
    for (const [id, remote] of Object.entries(data.customDecks || {})) {
      if (!remote || !Array.isArray(remote.cards)) continue;
      const local = s.customDecks[id];
      const cards = remote.cards.map((c, i) => normalizeCard(c, `${id}-${i}`)).filter(Boolean);
      if (!local) {
        s.customDecks[id] = { ...normalizeDeckMeta(remote), cards, updated: remote.updated || Date.now() };
      } else {
        const ids = new Set(local.cards.map((c) => c.id));
        const hashes = new Set(local.cards.map((c) => c.hash || cardContentHash(c)));
        local.cards.push(...cards.filter((c) => !ids.has(c.id) && !hashes.has(c.hash)));
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

    // Deck overrides on built-in decks: latest updated wins
    if (data.deckOverrides && typeof data.deckOverrides === "object") {
      s.deckOverrides ||= {};
      for (const [id, ovr] of Object.entries(data.deckOverrides)) {
        if (!ovr || !Array.isArray(ovr.cards)) continue;
        const local = s.deckOverrides[id];
        if (!local || (ovr.updated || 0) > (local.updated || 0)) {
          s.deckOverrides[id] = ovr;
        }
      }
    }

    // Progress: latest wins
    for (const [k, p] of Object.entries(data.progress || {})) {
      if (!p || typeof p.w !== "number") continue;
      if (!s.progress[k] || (p.t || 0) > (s.progress[k].t || 0)) s.progress[k] = p;
    }

    // Hash index
    if (data.hashIndex) {
      s.hashIndex = Object.assign(s.hashIndex || {}, data.hashIndex);
    }

    // Per-deck prefs: fill gaps (or adopt fully on first sync of a new device)
    for (const [id, p] of Object.entries(data.prefs?.decks || {})) {
      if (adoptPrefs || !s.prefs.decks[id]) s.prefs.decks[id] = p;
    }

    if (!this.decksExists(s.prefs.currentDeckId)) s.prefs.currentDeckId = this.defaultDeckId || this.deckIds()[0];
    this._deckCache.clear();
    this.save();
    this.dispatchEvent(new CustomEvent("deck-changed"));
  }
}
