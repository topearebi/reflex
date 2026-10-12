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

function base(str) {
  return String(str ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc`´]/g, "'")
    .trim();
}

function latinKey(str) {
  return base(str)
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(OPTIONAL_MARKS, "")
    .normalize("NFC")
    .replace(IGNORABLE, "");
}

/** Splits pinyin (numbers, marks or a mix) into letters + tone sequence. */
export function parsePinyin(str) {
  const s = base(str).replace(/u:/g, "v");
  let letters = "";
  const tones = [];
  for (const ch of s) {
    const mark = TONE_MARKS[ch];
    if (mark) {
      letters += mark[0];
      if (mark[1]) tones.push(mark[1]);
    } else if (ch >= "1" && ch <= "5") {
      tones.push(Number(ch));
    } else if (/\p{L}/u.test(ch)) {
      letters += ch;
    }
    // spaces, apostrophes, hyphens, tone 0 etc. are dropped
  }
  // Neutral tone is optional: "ba4ba5" == "ba4ba"
  return { letters, tones: tones.filter((t) => t !== 5) };
}

function strictKey(str) {
  return base(str).replace(/\s+/g, " ");
}

/**
 * Comparison key for a string under a mode. Two strings match when their
 * keys are equal.
 */
export function answerKey(str, mode, deck) {
  const pinyin = deck?.romanization === "pinyin";
  if (mode === Modes.STRICT) return strictKey(str);
  if (pinyin) {
    const { letters, tones } = parsePinyin(str);
    return mode === Modes.RELAXED ? letters : `${letters}|${tones.join("")}`;
  }
  return latinKey(str);
}

/** True when `input` is an acceptable way of typing any of the card's answers. */
export function isMatch(input, answers, mode, deck) {
  const key = answerKey(input, mode, deck);
  if (!key || key === "|") return false;
  return answers.some((a) => answerKey(a, mode, deck) === key);
}

/** The mode actually used for a deck (relaxed only exists for pinyin decks). */
export function effectiveMode(mode, deck) {
  const allowed = modesForDeck(deck).map((m) => m.value);
  return allowed.includes(mode) ? mode : Modes.STANDARD;
}
