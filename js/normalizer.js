/**
 * js/normalizer.js — answer matching.
 *
 * Every card has one canonical answer. Matching never accepts a *different*
 * answer; it only forgives how the canonical one is typed:
 *
 *   standard  Accents/vowel marks optional, punctuation and spaces ignored.
 *             Pinyin decks: tones required, as numbers (ni3hao3) or marks (nǐhǎo).
 *   relaxed   Pinyin decks only: tones optional too. (Same as standard elsewhere.)
 *   strict    Exactly as written, accents and tones included (case-insensitive).
 */

export const Modes = Object.freeze({
  STANDARD: "standard",
  RELAXED: "relaxed",
  STRICT: "strict"
});

/** Modes offered in the UI for a given deck. */
export function modesForDeck(deck) {
  const pinyin = deck?.romanization === "pinyin";
  return pinyin
    ? [
        { value: Modes.STANDARD, label: "Tones required" },
        { value: Modes.RELAXED, label: "Tones optional" },
        { value: Modes.STRICT, label: "Exact spelling" }
      ]
    : [
        { value: Modes.STANDARD, label: "Accents optional" },
        { value: Modes.STRICT, label: "Accents required" }
      ];
}

// Tone-marked vowel -> [base letter, tone]
const TONE_MARKS = {
  ā: ["a", 1], á: ["a", 2], ǎ: ["a", 3], à: ["a", 4],
  ē: ["e", 1], é: ["e", 2], ě: ["e", 3], è: ["e", 4],
  ī: ["i", 1], í: ["i", 2], ǐ: ["i", 3], ì: ["i", 4],
  ō: ["o", 1], ó: ["o", 2], ǒ: ["o", 3], ò: ["o", 4],
  ū: ["u", 1], ú: ["u", 2], ǔ: ["u", 3], ù: ["u", 4],
  ǖ: ["v", 1], ǘ: ["v", 2], ǚ: ["v", 3], ǜ: ["v", 4],
  ü: ["v", 0],
  // Rare but valid: tone-marked m/n/ê (ḿ, ň ...). Treat as base letter.
  ḿ: ["m", 2], ń: ["n", 2], ň: ["n", 3], ǹ: ["n", 4]
};

// Combining marks that "accents optional" may ignore: Latin/Greek/Cyrillic
// diacritics, Arabic harakat, Hebrew niqqud. Deliberately excludes the kana
// (han)dakuten (U+3099/309A), which change the sound.
const OPTIONAL_MARKS = /[\u0300-\u036f\u064b-\u065f\u0670\u0591-\u05c7]/g;
const IGNORABLE = /[\s\p{P}\p{S}]/gu;
const RE_APOSTROPHES = /[\u2018\u2019\u02bc`´]/g;
const RE_OE = /œ/g;
const RE_AE = /æ/g;
const RE_SS = /ß/g;
const RE_SPACES = /\s+/g;
const RE_U_COLON = /u:/g;
const RE_LETTER = /\p{L}/u;
const RE_NON_ASCII = /[\u0080-\uffff]/;

function toNFC(str) {
  if (typeof str !== "string") str = String(str ?? "");
  return RE_NON_ASCII.test(str) ? str.normalize("NFC") : str;
}

function base(str) {
  return toNFC(str)
    .toLowerCase()
    .replace(RE_APOSTROPHES, "'")
    .trim();
}

const LATIN_CACHE = new Map();
const PINYIN_CACHE = new Map();
const MAX_CACHE_SIZE = 1000;

function latinKey(str) {
  if (typeof str !== "string") str = String(str ?? "");
  const cached = LATIN_CACHE.get(str);
  if (cached !== undefined) return cached;

  const res = base(str)
    .replace(RE_OE, "oe")
    .replace(RE_AE, "ae")
    .replace(RE_SS, "ss")
    .normalize("NFD")
    .replace(OPTIONAL_MARKS, "")
    .normalize("NFC")
    .replace(IGNORABLE, "");

  if (LATIN_CACHE.size >= MAX_CACHE_SIZE) LATIN_CACHE.clear();
  LATIN_CACHE.set(str, res);
  return res;
}

/** Splits pinyin (numbers, marks or a mix) into letters + tone sequence. */
export function parsePinyin(str) {
  if (typeof str !== "string") str = String(str ?? "");
  const cached = PINYIN_CACHE.get(str);
  if (cached !== undefined) return cached;

  const s = base(str).replace(RE_U_COLON, "v");
  let letters = "";
  const tones = [];
  for (const ch of s) {
    const mark = TONE_MARKS[ch];
    if (mark) {
      letters += mark[0];
      if (mark[1]) tones.push(mark[1]);
    } else if (ch >= "1" && ch <= "5") {
      tones.push(Number(ch));
    } else if (RE_LETTER.test(ch)) {
      letters += ch;
    }
    // spaces, apostrophes, hyphens, tone 0 etc. are dropped
  }
  // Neutral tone is optional: "ba4ba5" == "ba4ba"
  const res = { letters, tones: tones.filter((t) => t !== 5) };
  if (PINYIN_CACHE.size >= MAX_CACHE_SIZE) PINYIN_CACHE.clear();
  PINYIN_CACHE.set(str, res);
  return res;
}

function strictKey(str) {
  return base(str).replace(RE_SPACES, " ");
}

const ANSWER_KEY_CACHE = new Map();
const MAX_KEY_CACHE = 2000;

/**
 * Comparison key for a string under a mode. Two strings match when their
 * keys are equal.
 */
export function answerKey(str, mode, deck) {
  const pinyin = deck?.romanization === "pinyin";
  const cacheKey = `${str}\x00${mode}\x00${pinyin ? 1 : 0}`;
  const cached = ANSWER_KEY_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  let res;
  if (mode === Modes.STRICT) res = strictKey(str);
  else if (pinyin) {
    const { letters, tones } = parsePinyin(str);
    res = mode === Modes.RELAXED ? letters : `${letters}|${tones.join("")}`;
  } else {
    res = latinKey(str);
  }

  if (ANSWER_KEY_CACHE.size >= MAX_KEY_CACHE) ANSWER_KEY_CACHE.clear();
  ANSWER_KEY_CACHE.set(cacheKey, res);
  return res;
}

/** True when `input` is an acceptable way of typing any of the card's answers. */
export function isMatch(input, answers, mode, deck) {
  const key = answerKey(input, mode, deck);
  if (!key || key === "|") return false;
  for (let i = 0; i < answers.length; i++) {
    if (answerKey(answers[i], mode, deck) === key) return true;
  }
  return false;
}

/** The mode actually used for a deck (relaxed only exists for pinyin decks). */
export function effectiveMode(mode, deck) {
  const allowed = modesForDeck(deck).map((m) => m.value);
  return allowed.includes(mode) ? mode : Modes.STANDARD;
}

function evaluateSingle(inputTrimmed, inputLower, candidate, strict, mode, deck) {
  if (candidate == null) return false;
  const candTrimmed = toNFC(candidate).trim();
  if (!candTrimmed) return false;

  // Fast-path exact / case-insensitive check
  if (candTrimmed.toLowerCase() === inputLower) return true;

  if (strict) {
    return isMatch(inputTrimmed, [candTrimmed], Modes.STRICT, deck);
  }

  // Speed / Lenient mode:
  // 1. Standard mode for this deck
  if (isMatch(inputTrimmed, [candTrimmed], mode, deck)) return true;

  // 2. Latin key fallback
  const inLat = latinKey(inputTrimmed);
  if (inLat && latinKey(candTrimmed) === inLat) return true;

  // 3. Pinyin fallback for tone numbers / pinyin romanization
  const isPinyin = deck?.romanization === "pinyin" || /[1-5]/.test(inputTrimmed) || /[1-5]/.test(candTrimmed);
  if (isPinyin) {
    const pinyinDeck = deck?.romanization === "pinyin" ? deck : { ...deck, romanization: "pinyin" };
    if (isMatch(inputTrimmed, [candTrimmed], Modes.RELAXED, pinyinDeck)) return true;
    if (isMatch(inputTrimmed, [candTrimmed], Modes.STANDARD, pinyinDeck)) return true;
  }

  return false;
}

/**
 * Evaluates user input against a target and optional aliases.
 * Supports dual-mode evaluation (Speed/Lenient vs Strict),
 * multi-target alias arrays, Unicode canonical equivalence, and
 * tone-number parsing consistently across candidates.
 *
 * @param {string} input - Raw user input
 * @param {string|string[]} target - Primary target answer or array of answers
 * @param {string[]} [aliases=[]] - Optional array of alternate acceptable answers
 * @param {boolean|object} [options={}] - Boolean strictness flag or { strict, mode, deck }
 * @returns {boolean}
 */
export function evaluateInput(input, target, aliases = [], options = {}) {
  if (aliases && !Array.isArray(aliases) && typeof aliases === "object") {
    options = aliases;
    aliases = [];
  }
  const strict = typeof options === "boolean" ? options : Boolean(options?.strict || options?.mode === Modes.STRICT);
  const deck = typeof options === "object" ? options?.deck : undefined;
  const mode = typeof options === "string" ? options : (typeof options === "object" && options?.mode) ? options.mode : (strict ? Modes.STRICT : Modes.STANDARD);

  if (input == null) return false;

  const inputTrimmed = toNFC(input).trim();
  if (!inputTrimmed) return false;
  const inputLower = inputTrimmed.toLowerCase();

  // Fast-path exact match check on target
  if (typeof target === "string" && toNFC(target).trim().toLowerCase() === inputLower) {
    return true;
  }

  // 1. Hierarchical evaluation: Evaluate primary target(s) first
  if (Array.isArray(target)) {
    for (let i = 0; i < target.length; i++) {
      if (evaluateSingle(inputTrimmed, inputLower, target[i], strict, mode, deck)) return true;
    }
  } else if (target != null) {
    if (evaluateSingle(inputTrimmed, inputLower, target, strict, mode, deck)) return true;
  }

  // 2. Iteratively evaluate registered aliases if primary target didn't match
  if (aliases != null) {
    if (Array.isArray(aliases)) {
      for (let i = 0; i < aliases.length; i++) {
        if (evaluateSingle(inputTrimmed, inputLower, aliases[i], strict, mode, deck)) return true;
      }
    } else {
      if (evaluateSingle(inputTrimmed, inputLower, aliases, strict, mode, deck)) return true;
    }
  }

  return false;
}
