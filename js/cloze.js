/**
 * js/cloze.js — dynamic cloze token parsing, generation and rendering.
 *
 * Supports both legacy {{c1::...}} cloze syntax and space-delimited token strings.
 * Provides deterministic token splitting, lexical item identification,
 * ledger-driven target selection for un-targeted sentences, and DOM rendering
 * with toggleable Segmented / Native views.
 */

import { evaluateInput, isMatch, Modes } from "./normalizer.js";

export const STOP_WORDS = new Set([
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "and", "or",
  "but", "not", "that", "this", "it", "as", "he", "she", "they", "we", "i", "you",
  // French
  "le", "la", "les", "l", "un", "une", "des", "du", "de", "d", "et", "ou",
  "est", "sont", "a", "ont", "ce", "cet", "cette", "ces", "dans", "en", "par",
  "pour", "sur", "avec", "qui", "que", "ne", "pas", "se", "sa", "son", "ses",
  // Chinese
  "是", "的", "了", "在", "和", "有", "我", "他", "她", "它", "们", "这", "那",
  "就", "也", "都", "而", "及", "与", "着", "或", "一个", "没有", "我们", "你们", "他们",
  // Spanish
  "el", "la", "los", "las", "un", "una", "unos", "unas", "y", "o", "en", "de",
  "es", "son", "fue", "por", "para", "con", "que", "no", "se", "su", "sus",
  // German
  "der", "die", "das", "ein", "eine", "einer", "einem", "einen", "und", "in",
  "zu", "von", "mit", "ist", "sind", "war", "waren", "nicht", "den", "dem", "des"
]);

export function isStopWord(word) {
  if (!word) return false;
  return STOP_WORDS.has(String(word).trim().toLowerCase());
}

const RE_LEGACY_CLOZE = /\{\{c\d+::([^:}]+)(?:::([^}]+))?\}\}/g;
const RE_LEGACY_TEST = /\{\{c\d+::[^}]+?\}\}/;
const RE_LEGACY_MATCH = /^\{\{c\d+::([^:}]+)(?:::([^}]+))?\}\}$/;
const RE_CJK = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/;
const RE_WORD_CHAR = /[\p{L}\p{N}]/u;
const RE_LEADING_PUNCT = /^([\p{P}\p{S}]+)([\p{L}\p{N}].*)$/u;
const RE_TRAILING_PUNCT = /^(.*?[\p{L}\p{N}])([\p{P}\p{S}]+)$/u;

/**
 * Checks if a string contains CJK characters (Hanzi, Kana, Hangul).
 */
export function isCJK(str) {
  return RE_CJK.test(String(str ?? ""));
}

/**
 * Checks whether text or card uses legacy {{c1::...}} cloze syntax.
 */
export function hasLegacyCloze(cardOrText) {
  const text = typeof cardOrText === "string" ? cardOrText : cardOrText?.prompt || "";
  return text.includes("{{c") && RE_LEGACY_TEST.test(text);
}


/**
 * Parses legacy cloze syntax {{c1::word::hint}} into clean text and target metadata.
 */
export function parseLegacyCloze(text) {
  const str = String(text ?? "");
  const matches = [];
  let m;
  const regex = new RegExp(RE_LEGACY_CLOZE.source, "g");
  while ((m = regex.exec(str)) !== null) {
    matches.push({
      full: m[0],
      answer: m[1],
      hint: m[2] || "",
      index: m.index
    });
  }
  const cleanText = str.replace(RE_LEGACY_CLOZE, "$1");
  return {
    isLegacy: matches.length > 0,
    matches,
    cleanText
  };
}

/**
 * Extracts prefix punctuation, core word, and suffix punctuation from a raw token.
 */
export function splitPunctuation(rawToken) {
  let prefix = "";
  let text = String(rawToken ?? "");
  let suffix = "";

  const leadingMatch = text.match(RE_LEADING_PUNCT);
  if (leadingMatch) {
    prefix = leadingMatch[1];
    text = leadingMatch[2];
  }

  const trailingMatch = text.match(RE_TRAILING_PUNCT);
  if (trailingMatch) {
    text = trailingMatch[1];
    suffix = trailingMatch[2];
  }

  const isTargetable = RE_WORD_CHAR.test(text);
  return { prefix, text, suffix, isTargetable };
}

/**
 * Deterministically splits a sentence into token structures.
 * Supports legacy {{c1::target::hint}} syntax inline with surrounding words.
 */
export function tokenizeSentence(sentence) {
  const raw = String(sentence ?? "").trim();
  if (!raw) return [];

  // Match either legacy cloze tag {{c...}} or non-whitespace chunks
  const tokens = [];
  const chunkRegex = /(\{\{c\d+::[^}]+?\}\}|\S+)/g;
  let match;
  let index = 0;

  while ((match = chunkRegex.exec(raw)) !== null) {
    const chunk = match[0];
    const legacy = chunk.match(RE_LEGACY_MATCH);

    if (legacy) {
      const targetText = legacy[1];
      const hint = legacy[2] || "";
      const { prefix, text, suffix, isTargetable } = splitPunctuation(targetText);
      const isPunct = !isTargetable || /^[\p{P}\p{S}]+$/u.test(text);
      tokens.push({
        id: `tok-${index}`,
        index,
        raw: chunk,
        prefix,
        text,
        suffix,
        isTargetable,
        isPunct,
        isLegacy: true,
        hint
      });
    } else {
      const { prefix, text, suffix, isTargetable } = splitPunctuation(chunk);
      const isPunct = !isTargetable || /^[\p{P}\p{S}]+$/u.test(text);
      tokens.push({
        id: `tok-${index}`,
        index,
        raw: chunk,
        prefix,
        text,
        suffix,
        isTargetable,
        isPunct,
        isLegacy: false,
        hint: ""
      });
    }
    index++;
  }

  return tokens;
}

/**
 * Generates a cloze structure from a card object or sentence string.
 *
 * @param {object|string} cardOrSentence - Card object or prompt sentence
 * @param {object} [options={}] - Options: target, targetIndex, ledger, viewMode, lang
 * @returns {object} ClozeStructure
 */
export function generateCloze(cardOrSentence, options = {}) {
  const isCard = typeof cardOrSentence === "object" && cardOrSentence !== null;
  const prompt = isCard ? cardOrSentence.prompt || "" : String(cardOrSentence || "");
  const cardAnswer = isCard ? (cardOrSentence.answer || (Array.isArray(cardOrSentence.answers) ? cardOrSentence.answers[0] : "")) : "";
  const cardHint = isCard ? cardOrSentence.subtitle || "" : "";
  const lang = options.lang || (isCard ? cardOrSentence.lang : "") || "";

  const tokens = tokenizeSentence(prompt);
  const targetableTokens = tokens.filter((t) => t.isTargetable);

  let targetIndex = -1;
  let targetWord = "";
  let targetHint = options.hint || cardHint || "";

  // 1. Check if there is an explicit legacy cloze token
  const legacyTokenIndex = tokens.findIndex((t) => t.isLegacy);
  if (legacyTokenIndex !== -1) {
    targetIndex = legacyTokenIndex;
    targetWord = tokens[targetIndex].text;
    if (tokens[targetIndex].hint) targetHint = tokens[targetIndex].hint;
  }
  // 2. Check if options.targetIndex is explicitly passed
  else if (
    typeof options.targetIndex === "number" &&
    options.targetIndex >= 0 &&
    options.targetIndex < tokens.length &&
    tokens[options.targetIndex].isTargetable
  ) {
    targetIndex = options.targetIndex;
    targetWord = tokens[targetIndex].text;
  }
  // 3. Check if target word is explicitly passed in options
  else if (options.target) {
    const wanted = options.target.trim().toLowerCase();
    const idx = tokens.findIndex((t) => t.isTargetable && t.text.toLowerCase() === wanted);
    if (idx !== -1) {
      targetIndex = idx;
      targetWord = tokens[idx].text;
    }
  }
  // 4. If ledger is provided, pick least-drilled token dynamically
  else if (options.ledger && typeof options.ledger.getLeastDrilledToken === "function" && targetableTokens.length > 0) {
    const candidateTexts = targetableTokens.map((t) => t.text);
    const chosenText = options.ledger.getLeastDrilledToken(candidateTexts, {
      lang,
      saturationLimit: options.saturationLimit || 5,
      stopWords: STOP_WORDS
    });
    const idx = tokens.findIndex((t) => t.isTargetable && t.text === chosenText);
    if (idx !== -1) {
      targetIndex = idx;
      targetWord = tokens[idx].text;
    }
  }
  // 5. Fallback: check if card answer matches a token
  else if (cardAnswer) {
    const wanted = cardAnswer.trim().toLowerCase();
    const idx = tokens.findIndex((t) => t.isTargetable && t.text.toLowerCase() === wanted);
    if (idx !== -1) {
      targetIndex = idx;
      targetWord = tokens[idx].text;
    }
  }

  // 5. Fallback: select first targetable token
  if (targetIndex === -1 && targetableTokens.length > 0) {
    targetIndex = targetableTokens[0].index;
    targetWord = targetableTokens[0].text;
  }

  // Mark the target token in the array
  const formattedTokens = replaceTokenWithBlank(tokens, targetIndex);

  const viewMode = options.viewMode || (isCJK(prompt) ? "native" : "segmented");

  return {
    original: prompt,
    target: targetWord || cardAnswer,
    targetIndex,
    hint: targetHint,
    tokens: formattedTokens,
    viewMode,
    isLegacy: legacyTokenIndex !== -1,
    lang
  };
}

/**
 * Given a token array, replaces an index with a blank (isTarget: true)
 * while retaining all preceding and following tokens in their original order.
 *
 * @param {Array} tokens - Array of token objects
 * @param {number} targetIndex - Token index to mark as blank
 * @returns {Array} New token array with the target token blanked
 */
export function replaceTokenWithBlank(tokens, targetIndex) {
  if (!Array.isArray(tokens)) return [];
  return tokens.map((tok, idx) => ({
    ...tok,
    isTarget: idx === targetIndex || tok.index === targetIndex
  }));
}

export const punchHole = replaceTokenWithBlank;
export const substituteBlank = replaceTokenWithBlank;

/**
 * Renders sentence text in native presentation format.
 * Non-Latin / unspaced scripts (such as Chinese, Japanese, Thai) automatically have
 * inter-token spaces collapsed to present unbroken native script.
 * Latin scripts (English, French, Spanish, German, Yoruba, etc.) preserve inter-word spacing.
 *
 * @param {string|object} sentenceOrCloze - Raw sentence string or ClozeStructure
 * @param {object|string} [options={}] - Options object or lang string
 * @returns {string} Formatted native text string
 */
export function renderNativeText(sentenceOrCloze, options = {}) {
  const lang = typeof options === "string" ? options : (options?.lang || sentenceOrCloze?.lang || "");
  const viewMode = (typeof options === "object" && options?.viewMode) ? options.viewMode : "native";

  let raw = typeof sentenceOrCloze === "string"
    ? sentenceOrCloze
    : (sentenceOrCloze?.original || sentenceOrCloze?.prompt || "");

  if (viewMode === "segmented") return raw;

  const isUnspaced = isCJK(raw) || (lang && /^(zh|ja|ko|th)/i.test(lang));
  if (isUnspaced) {
    return raw
      .replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{P}\p{S}\p{N}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{P}\p{S}\p{N}])/gu, "")
      .replace(/\s+(?=[。，、！？：；”’）》〉\p{P}\p{S}])/gu, "")
      .replace(/([“‘（《〈\p{P}\p{S}])\s+/gu, "$1")
      .trim();
  }

  return raw.replace(/[^\S\r\n]+/g, " ").trim();
}

export const renderNative = renderNativeText;
export const formatNativeText = renderNativeText;
export const renderNativeSentence = renderNativeText;

/**
 * Calculates rigid bounding width for the inline cloze input element
 * to eliminate layout jitter and reflow, strictly differentiating between
 * Latin (ch) and CJK (em) character metrics.
 */
export function calculateInputWidth(targetText, options = {}) {
  const text = String(targetText ?? "");
  const isCjkText = isCJK(text) || Boolean(options?.lang && (options.lang.startsWith("zh") || options.lang.startsWith("ja") || options.lang.startsWith("ko")));
  const len = Math.max(1, [...text].length);
  if (isCjkText) {
    // CJK full-width glyph metrics in em units
    const cjkChars = [...text].filter((ch) => isCJK(ch)).length || len;
    const nonCjkChars = len - cjkChars;
    const emWidth = Math.max(2, cjkChars * 1.15 + nonCjkChars * 0.6 + 0.5);
    return `${emWidth.toFixed(2)}em`;
  }
  // Latin / proportional glyph metrics in font-relative ch units
  return `${(Math.max(3, len) + 1.2).toFixed(2)}ch`;
}

/**
 * Renders a ClozeStructure to the DOM with rigid inline input bounds and
 * clean toggle hooks for Segmented View vs Native View.
 *
 * @param {object} clozeStructure - Output from generateCloze
 * @param {object} [options={}] - Rendering options
 * @returns {object} { container, input, setViewMode, tokens }
 */
export function renderCloze(clozeStructure, options = {}) {
  const doc = options.document || (typeof document !== "undefined" ? document : null);
  if (!doc) throw new Error("Document object required to render cloze DOM elements.");

  let viewMode = options.viewMode || clozeStructure.viewMode || "segmented";
  const container = options.container || doc.createElement("div");
  container.className = `cloze-sentence cloze-view-${viewMode}`;

  const tokenElements = [];
  let inlineInput = null;

  for (let i = 0; i < clozeStructure.tokens.length; i++) {
    const tok = clozeStructure.tokens[i];
    const isPunct = tok.isPunct || (!tok.isTarget && (!tok.isTargetable || /^[\p{P}\p{S}]+$/u.test(tok.text)));
    const nextTok = clozeStructure.tokens[i + 1];
    const isBeforePunct = Boolean(
      nextTok && (nextTok.isPunct || (!nextTok.isTarget && (!nextTok.isTargetable || /^[\p{P}\p{S}]+$/u.test(nextTok.text))))
    );

    const span = doc.createElement("span");
    const classes = ["cloze-token"];
    if (tok.isTarget) classes.push("cloze-token--target");
    if (isPunct) classes.push("cloze-token--punct");
    if (isBeforePunct) classes.push("cloze-token--before-punct");
    span.className = classes.join(" ");
    span.setAttribute("data-token-index", String(tok.index));
    if (span.dataset) span.dataset.tokenIndex = String(tok.index);


    if (tok.prefix) {
      const pfx = doc.createElement("span");
      pfx.className = "cloze-token__prefix";
      pfx.textContent = tok.prefix;
      span.appendChild(pfx);
    }

    if (tok.isTarget) {
      const input = doc.createElement("input");
      input.className = "cloze-input";
      input.type = "text";
      input.autocomplete = "off";
      input.autocorrect = "off";
      input.autocapitalize = "off";
      input.spellcheck = false;
      input.setAttribute("aria-label", tok.hint ? `Cloze target: ${tok.hint}` : "Cloze target");

      const isCjk = isCJK(clozeStructure.target || tok.text) || Boolean(clozeStructure.lang && (clozeStructure.lang.startsWith("zh") || clozeStructure.lang.startsWith("ja") || clozeStructure.lang.startsWith("ko")));
      input.setAttribute("data-script", isCjk ? "cjk" : "latin");
      input.classList.add(isCjk ? "cloze-input--cjk" : "cloze-input--latin");
      input.style.width = calculateInputWidth(clozeStructure.target || tok.text, { lang: clozeStructure.lang });
      input.style.boxSizing = "border-box";
      input.style.display = "inline-block";
      input.style.verticalAlign = "baseline";
      input.style.textAlign = "center";

      if (options.inputAttributes) {
        for (const [k, v] of Object.entries(options.inputAttributes)) {
          if (k === "class") input.classList.add(v);
          else input.setAttribute(k, v);
        }
      }

      if (typeof options.onInput === "function") {
        input.addEventListener("input", (e) => options.onInput(e, input.value));
      }

      span.appendChild(input);
      inlineInput = input;
    } else {
      const txt = doc.createElement("span");
      txt.className = "cloze-token__text";
      txt.textContent = tok.text;
      span.appendChild(txt);
    }

    if (tok.suffix) {
      const sfx = doc.createElement("span");
      sfx.className = "cloze-token__suffix";
      sfx.textContent = tok.suffix;
      span.appendChild(sfx);
    }

    container.appendChild(span);
    tokenElements.push(span);
  }

  function setViewMode(newMode) {
    viewMode = newMode;
    container.classList.remove("cloze-view-segmented", "cloze-view-native");
    container.classList.add(`cloze-view-${newMode}`);
  }

  return {
    container,
    input: inlineInput,
    tokenElements,
    setViewMode,
    getViewMode: () => viewMode
  };
}
