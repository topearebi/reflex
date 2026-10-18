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
import { STOP_WORDS } from "./cloze.js";

const STORAGE_KEY = "reflex_v3";
const LEGACY_STORAGE_KEY = "speedrecall_v3";
const LEGACY_KEY = "speedrecall_state_v2";
const LEDGER_LOG_KEY = "reflex_token_ledger";
const LEGACY_LEDGER_KEYS = ["speedrecall_token_ledger", "speedrecall_ledger_log_v1"];
const MANIFEST_URL = "./data/manifest.json";

const DAY = 86400000;
const HALF_LIFE_DAYS = 7; // learned weights drift back to neutral over time
const MIN_WEIGHT = 0.2;
const MAX_WEIGHT = 6;

export const unitKey = (card) => `${card.group || "General"}::${card.unit || "General"}`;

/**
 * Append-only log and in-memory ledger tracking token-level reviews and errors.
 */
export class TokenExposureLedger {
  constructor(storageKey = LEDGER_LOG_KEY) {
    this.storageKey = storageKey;
    this.tokens = new Map();
    this.load();
  }

  #normalizeToken(token) {
    return String(token ?? "").trim().toLowerCase();
  }

  load() {
    this.tokens.clear();
    try {
      if (typeof localStorage === "undefined") return;
      let raw = localStorage.getItem(this.storageKey);
      if (!raw) {
        for (const legacyKey of LEGACY_LEDGER_KEYS) {
          const legacyRaw = localStorage.getItem(legacyKey);
          if (legacyRaw) {
            raw = legacyRaw;
            try {
              localStorage.setItem(this.storageKey, legacyRaw);
            } catch {
              /* ignore */
            }
            break;
          }
        }
      }
      if (!raw) return;
      const lines = raw.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        this.#applyEntry(entry, false);
      }
    } catch (err) {
      console.warn("Could not load token exposure ledger", err);
    }
  }

  #applyEntry({ token, success, t }, append = false) {
    const key = this.#normalizeToken(token);
    if (!key) return;
    const prev = this.tokens.get(key) || { text: token, reviews: 0, errors: 0, lastSeen: 0 };
    this.tokens.set(key, {
      text: prev.text || token,
      reviews: prev.reviews + 1,
      errors: prev.errors + (success ? 0 : 1),
      lastSeen: t || Date.now()
    });
    if (append && typeof localStorage !== "undefined") {
      try {
        const raw = localStorage.getItem(this.storageKey) || "";
        const line = JSON.stringify({ token: key, success, t: t || Date.now() });
        localStorage.setItem(this.storageKey, raw ? `${raw}\n${line}` : line);
      } catch (err) {
        console.warn("Could not append to token ledger log", err);
      }
    }
  }

  recordExposure(token, success = true) {
    this.#applyEntry({ token, success, t: Date.now() }, true);
  }

  getTokenStats(token) {
    const key = this.#normalizeToken(token);
    const s = this.tokens.get(key);
    return s ? { ...s } : { text: token, reviews: 0, errors: 0, lastSeen: 0 };
  }

  getLeastDrilledToken(tokens = [], options = {}) {
    if (!tokens || tokens.length === 0) return null;
    const saturationLimit = typeof options === "number" ? options : (options?.saturationLimit ?? 5);
    const customStopWords = options?.stopWords || STOP_WORDS;

    // Filter out predefined stop words unless all candidate tokens are stop words
    const candidateNonStop = tokens.filter((t) => {
      const norm = this.#normalizeToken(t);
      return !customStopWords.has(norm);
    });
    const pool = candidateNonStop.length > 0 ? candidateNonStop : tokens;

    // 1. Prioritize unsaturated tokens (reviews < saturationLimit)
    const unsaturated = pool.filter((t) => {
      const stats = this.getTokenStats(t);
      return stats.reviews < saturationLimit;
    });

    if (unsaturated.length > 0) {
      let leastToken = unsaturated[0];
      let minReviews = Infinity;
      let maxErrors = -1;

      for (const t of unsaturated) {
        const stats = this.getTokenStats(t);
        if (stats.reviews < minReviews) {
          minReviews = stats.reviews;
          maxErrors = stats.errors;
          leastToken = t;
        } else if (stats.reviews === minReviews && stats.errors > maxErrors) {
          maxErrors = stats.errors;
          leastToken = t;
        }
      }
      return leastToken;
    }

    // 2. Fallback on Full Saturation:
    // If all tokens have reached the saturation limit in the ledger, the engine falls back
    // to selecting the token with the oldest last-reviewed timestamp, ensuring a cloze blank is always generated.
    let oldestToken = pool[0];
    let oldestTimestamp = Infinity;

    for (const t of pool) {
      const stats = this.getTokenStats(t);
      const seen = stats.lastSeen || 0;
      if (seen < oldestTimestamp) {
        oldestTimestamp = seen;
        oldestToken = t;
      }
    }

    return oldestToken || pool[0];
  }

  clear() {
    this.tokens.clear();
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(this.storageKey);
      }
    } catch {}
  }
}

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
  const rawAnswers = Array.isArray(raw.answers)
    ? raw.answers
    : (raw.answer !== undefined ? [raw.answer] : (raw.phonetic !== undefined ? [raw.phonetic] : []));
  const answers = rawAnswers
    .map((a) => String(a ?? "").normalize("NFC").trim())
    .filter(Boolean);
  const aliases = (Array.isArray(raw.aliases) ? raw.aliases : (raw.alias ? [raw.alias] : []))
    .map((a) => String(a ?? "").normalize("NFC").trim())
    .filter(Boolean);
  const prompt = String(raw.prompt ?? raw.script ?? raw.phonetic ?? "").normalize("NFC").trim();
  if (!prompt || answers.length === 0) return null;
  const id = String(raw.id || fallbackId).normalize("NFC");
  const group = String(raw.group || "General").normalize("NFC").trim();
  const unit = String(raw.unit || "General").normalize("NFC").trim();
  const subtitle = String(raw.subtitle ?? raw.gloss ?? "").normalize("NFC").trim();
  const script = raw.script !== undefined && raw.script !== null ? String(raw.script).normalize("NFC").trim() : null;
  const phonetic = String(raw.phonetic ?? answers[0] ?? "").normalize("NFC").trim();
  const gloss = String(raw.gloss ?? subtitle ?? "").normalize("NFC").trim();
  const lang = String(raw.lang || "").normalize("NFC").trim();
  const audio = raw.audio !== undefined ? raw.audio : null;
  const isCloze = Boolean(raw.isCloze);

  return {
    id,
    group,
    unit,
    prompt,
    subtitle,
    answers,
    aliases,
    script,
    phonetic,
    gloss,
    lang,
    audio,
    isCloze
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
    this.state = this.#load();
    this.builtIn = {}; // id -> deck (from data files)
    this.builtInOrder = [];
    this.session = { correct: 0, attempts: 0, streak: 0 };
    this.tokenLedger = new TokenExposureLedger();
    this.stumbleQueue = [];
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
      if (typeof localStorage === "undefined") return emptyState();
      let raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacyRaw) {
          raw = legacyRaw;
          try {
            localStorage.setItem(STORAGE_KEY, legacyRaw);
          } catch {
            /* ignore */
          }
        }
      }
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
      if (typeof localStorage === "undefined") return;
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
      // Stumble re-insertion: clone card metadata so deck definitions are never mutated
      this.stumbleQueue.push({
        ...card,
        _stumbleId: `stumble-${Date.now()}-${Math.random()}`,
        _dueAfter: s.attempts + 3
      });
    }

    // Token exposure ledgering: record exposure for the tested token
    const token = card.target || (Array.isArray(card.answers) ? card.answers[0] : card.answer);
    if (token) {
      this.tokenLedger.recordExposure(token, correct);
    }

    this.save();
    this.dispatchEvent(new CustomEvent("stats-changed"));
  }

  resetSession() {
    this.session = { correct: 0, attempts: 0, streak: 0 };
    this.stumbleQueue = [];
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
