import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  tokenizeSentence,
  generateCloze,
  parseLegacyCloze,
  splitPunctuation,
  calculateInputWidth,
  hasLegacyCloze,
  renderCloze,
  replaceTokenWithBlank,
  renderNativeText,
  renderNative
} from "../js/cloze.js";

const bilingualDeck = JSON.parse(
  readFileSync(new URL("../data/bilingual-cloze.json", import.meta.url), "utf-8")
);

test("cloze.js: parses legacy {{c1::...}} cards from bilingual-cloze.json alongside space-delimited cards", () => {
  // Test legacy cards from bilingual-cloze.json
  const legacyCard1 = bilingualDeck.cards[0];
  assert.ok(hasLegacyCloze(legacyCard1.prompt));
  const cloze1 = generateCloze(legacyCard1);
  assert.equal(cloze1.isLegacy, true);
  assert.equal(cloze1.target, "quick");
  const targetToken1 = cloze1.tokens.find((t) => t.isTarget);
  assert.ok(targetToken1, "Must find target token");
  assert.equal(targetToken1.text, "quick");

  // Test legacy card with hint
  const legacyCard2 = bilingualDeck.cards[1];
  assert.ok(hasLegacyCloze(legacyCard2.prompt));
  const cloze2 = generateCloze(legacyCard2);
  assert.equal(cloze2.target, "study");
  assert.equal(cloze2.hint, "learn");

  // Test space-delimited card without {{c1::...}}
  const spaceCard1 = bilingualDeck.cards[3];
  assert.equal(hasLegacyCloze(spaceCard1.prompt), false);
  const cloze3 = generateCloze(spaceCard1);
  assert.equal(cloze3.isLegacy, false);
  assert.equal(cloze3.target, "sol");
  const targetToken3 = cloze3.tokens.find((t) => t.isTarget);
  assert.ok(targetToken3, "Must find target token for space-delimited sentence");
  assert.equal(targetToken3.text, "sol");

  const spaceCard2 = bilingualDeck.cards[4];
  const cloze4 = generateCloze(spaceCard2);
  assert.equal(cloze4.target, "langue");
  const targetToken4 = cloze4.tokens.find((t) => t.isTarget);
  assert.equal(targetToken4.text, "langue");
});

test("cloze.js: deterministic token splitting and punctuation separation", () => {
  const sentence = '“Knowledge,” said the scholar, “is power!”';
  const tokens = tokenizeSentence(sentence);

  assert.equal(tokens.length, 6);
  assert.equal(tokens[0].text, "Knowledge");
  assert.equal(tokens[0].prefix, "“");
  assert.equal(tokens[0].suffix, ",”");
  assert.equal(tokens[0].isTargetable, true);

  assert.equal(tokens[1].text, "said");
  assert.equal(tokens[1].suffix, "");

  assert.equal(tokens[5].text, "power");
  assert.equal(tokens[5].suffix, "!”");
});

test("cloze.js: selects least-drilled token when un-targeted with ledger", () => {
  const sentence = "cats chase mice across gardens";
  const mockLedger = {
    stats: {
      cats: { reviews: 10, errors: 0 },
      chase: { reviews: 5, errors: 1 },
      mice: { reviews: 1, errors: 0 },
      across: { reviews: 7, errors: 0 },
      gardens: { reviews: 3, errors: 0 }
    },
    getLeastDrilledToken(candidates) {
      return [...candidates].sort((a, b) => {
        const rA = this.stats[a]?.reviews || 0;
        const rB = this.stats[b]?.reviews || 0;
        return rA - rB;
      })[0];
    }
  };

  const cloze = generateCloze(sentence, { ledger: mockLedger });
  assert.equal(cloze.target, "mice", "Least-drilled token should be chosen as target");
  assert.equal(cloze.tokens.find((t) => t.isTarget).text, "mice");
});

test("cloze.js: input width calculation ensures rigid bounds for Latin and CJK", () => {
  // Latin
  const w1 = calculateInputWidth("cat");
  const w2 = calculateInputWidth("hippopotamus");
  assert.ok(w1.endsWith("ch"), "Latin width should use ch units");
  assert.ok(parseFloat(w2) > parseFloat(w1));

  // CJK
  const wCjk1 = calculateInputWidth("你");
  const wCjk2 = calculateInputWidth("你好世界");
  assert.ok(wCjk1.endsWith("em"), "CJK width should use em units");
  assert.ok(parseFloat(wCjk2) > parseFloat(wCjk1));
});

test("cloze.js: DOM rendering and view mode toggling (Segmented vs Native)", () => {
  // Mock lightweight DOM
  function createMockElement(tag) {
    const classes = new Set();
    const el = {
      tagName: tag.toUpperCase(),
      get className() {
        return [...classes].join(" ");
      },
      set className(v) {
        classes.clear();
        String(v || "").split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
      },
      classList: {
        add(...cls) {
          cls.forEach((c) => classes.add(c));
        },
        remove(...cls) {
          cls.forEach((c) => classes.delete(c));
        },
        contains(c) {
          return classes.has(c);
        }
      },
      style: {},
      attributes: {},
      setAttribute(k, v) {
        this.attributes[k] = v;
      },
      appendChild(child) {
        this.children.push(child);
      },
      children: [],
      textContent: ""
    };
    return el;
  }


  const mockDocument = {
    createElement: (tag) => createMockElement(tag)
  };

  const cloze = generateCloze("Hello world", { target: "world" });
  const rendered = renderCloze(cloze, { document: mockDocument, viewMode: "segmented" });

  assert.ok(rendered.container.classList.contains("cloze-view-segmented"));
  assert.ok(rendered.input !== null);
  assert.equal(rendered.input.tagName, "INPUT");
  assert.ok(rendered.input.style.width.endsWith("ch"));

  // Toggle to native
  rendered.setViewMode("native");
  assert.ok(rendered.container.classList.contains("cloze-view-native"));
  assert.ok(!rendered.container.classList.contains("cloze-view-segmented"));
});

/* =========================================================================
   A. Tokenizer & Segmentation Tests
   ========================================================================= */

test("cloze.js A1. Whitespace Splitting: multi-word string with irregular spaces splits cleanly into isolated tokens without empty elements", () => {
  const sentenceWithIrregularSpaces = "  This   is  a \t sentence   with   irregular   spaces  ";
  const tokens = tokenizeSentence(sentenceWithIrregularSpaces);

  // Splits into clean array of 7 isolated tokens
  assert.equal(tokens.length, 7);
  assert.deepEqual(
    tokens.map((t) => t.text),
    ["This", "is", "a", "sentence", "with", "irregular", "spaces"]
  );

  // Verify no empty string elements exist
  for (const token of tokens) {
    assert.ok(token.text.length > 0, "Token text must never be empty");
    assert.ok(!/^\s*$/.test(token.text), "Token text must never be pure whitespace");
    assert.ok(token.raw.length > 0, "Token raw representation must never be empty");
  }

  // Verify deterministic sequential indexing
  tokens.forEach((t, i) => {
    assert.equal(t.index, i, `Token index must strictly match array index ${i}`);
  });
});

test("cloze.js A2. Punctuation Isolation: trailing and isolated punctuation tokens are recognized as non-targetable elements and cannot be selected as cloze blanks", () => {
  // 1. Trailing punctuation attached to words
  const trailing1 = splitPunctuation("scholar,");
  assert.equal(trailing1.text, "scholar");
  assert.equal(trailing1.suffix, ",");
  assert.equal(trailing1.isTargetable, true);

  const trailing2 = splitPunctuation("“wisdom”");
  assert.equal(trailing2.prefix, "“");
  assert.equal(trailing2.text, "wisdom");
  assert.equal(trailing2.suffix, "”");
  assert.equal(trailing2.isTargetable, true);

  // 2. Isolated punctuation tokens
  const isolatedFullStop = splitPunctuation("。");
  assert.equal(isolatedFullStop.text, "。");
  assert.equal(isolatedFullStop.isTargetable, false, "Isolated Chinese full stop must be non-targetable");

  const isolatedComma = splitPunctuation(",");
  assert.equal(isolatedComma.isTargetable, false, "Isolated comma must be non-targetable");

  const isolatedEllipsis = splitPunctuation("...");
  assert.equal(isolatedEllipsis.isTargetable, false, "Isolated ellipsis must be non-targetable");

  // 3. Sentence containing isolated punctuation
  const sentence = "我 是 老师 。";
  const tokens = tokenizeSentence(sentence);
  assert.equal(tokens.length, 4);
  assert.equal(tokens[3].text, "。");
  assert.equal(tokens[3].isTargetable, false);

  // 4. Cloze generation: isolated punctuation cannot be selected as cloze blank
  const cloze = generateCloze(sentence);
  assert.notEqual(cloze.target, "。", "Isolated punctuation must never be selected as cloze blank");
  assert.ok(["我", "是", "老师"].includes(cloze.target));

  // 5. Explicitly passing targetIndex pointing to non-targetable punctuation is rejected
  const clozeWithInvalidIndex = generateCloze(sentence, { targetIndex: 3 });
  assert.notEqual(clozeWithInvalidIndex.target, "。", "Passing targetIndex of punctuation must not select it");
  assert.notEqual(clozeWithInvalidIndex.targetIndex, 3);
});

test("cloze.js A3. Native vs. Spaced Rendering: Chinese returns unbroken character sequence with spaces removed, while French/English preserves inter-word spacing", () => {
  // 1. Chinese sentence with authored inter-token spacing
  const chineseSentence = "我 是 老师 。";
  const renderedChinese = renderNativeText(chineseSentence);
  assert.equal(renderedChinese, "我是老师。", "Native render of Chinese sentence must return unbroken character sequence with spaces removed");

  // Multi-space Chinese sentence
  const multiSpaceChinese = "今天    天气   很好  。";
  assert.equal(renderNativeText(multiSpaceChinese), "今天天气很好。");

  // 2. French sentence: inter-word spacing MUST be preserved
  const frenchSentence = "Je veux prendre un café .";
  const renderedFrench = renderNativeText(frenchSentence);
  assert.equal(renderedFrench, "Je veux prendre un café .", "Native render of French sentence must preserve inter-word spacing");

  // 3. English sentence: inter-word spacing MUST be preserved
  const englishSentence = "The quick brown fox jumps";
  const renderedEnglish = renderNativeText(englishSentence);
  assert.equal(renderedEnglish, "The quick brown fox jumps", "Native render of English sentence must preserve inter-word spacing");

  // 4. Verify alias renderNative works identically
  assert.equal(renderNative(chineseSentence), "我是老师。");
  assert.equal(renderNative(frenchSentence), "Je veux prendre un café .");

  // 5. Segmented viewMode override keeps spaced tokens
  assert.equal(renderNativeText(chineseSentence, { viewMode: "segmented" }), "我 是 老师 。");

  // 6. ClozeStructure object input
  const cloze = generateCloze(chineseSentence, { target: "老师" });
  assert.equal(renderNativeText(cloze), "我是老师。");
});

/* =========================================================================
   D. Dynamic Cloze Substitution Tests
   ========================================================================= */

test("cloze.js D1. Target Hole Replacement: replacing an index with a blank correctly retains all preceding and following tokens in their original order", () => {
  const sentence = "The quick brown fox jumps over the lazy dog";
  const tokens = tokenizeSentence(sentence);

  // Target index 3 is "fox"
  const blanked = replaceTokenWithBlank(tokens, 3);

  assert.equal(blanked.length, tokens.length, "Token count must remain identical");

  // Preceding tokens: retain original order, text, and isTarget === false
  assert.equal(blanked[0].text, "The");
  assert.equal(blanked[0].isTarget, false);
  assert.equal(blanked[1].text, "quick");
  assert.equal(blanked[1].isTarget, false);
  assert.equal(blanked[2].text, "brown");
  assert.equal(blanked[2].isTarget, false);

  // Target token: isTarget === true
  assert.equal(blanked[3].text, "fox");
  assert.equal(blanked[3].isTarget, true);

  // Following tokens: retain original order, text, and isTarget === false
  assert.equal(blanked[4].text, "jumps");
  assert.equal(blanked[4].isTarget, false);
  assert.equal(blanked[5].text, "over");
  assert.equal(blanked[5].isTarget, false);
  assert.equal(blanked[6].text, "the");
  assert.equal(blanked[6].isTarget, false);
  assert.equal(blanked[7].text, "lazy");
  assert.equal(blanked[7].isTarget, false);
  assert.equal(blanked[8].text, "dog");
  assert.equal(blanked[8].isTarget, false);
});

test("cloze.js D2. Multi-Word Boundary Integrity: multi-character token (e.g., 老师) is replaced by blank entirely rather than character by character", () => {
  const sentence = "我 是 老师 。";
  const cloze = generateCloze(sentence, { target: "老师" });

  assert.equal(cloze.target, "老师", "Target must be the full multi-character token");
  assert.equal(cloze.tokens.length, 4);

  // Token 2 is the multi-character word "老师"
  const targetTok = cloze.tokens[2];
  assert.equal(targetTok.text, "老师");
  assert.equal(targetTok.isTarget, true);

  // Verify preceding and following tokens are intact
  assert.equal(cloze.tokens[0].text, "我");
  assert.equal(cloze.tokens[0].isTarget, false);
  assert.equal(cloze.tokens[1].text, "是");
  assert.equal(cloze.tokens[1].isTarget, false);
  assert.equal(cloze.tokens[3].text, "。");
  assert.equal(cloze.tokens[3].isTarget, false);

  // Input width calculation accounts for the entire multi-character word
  const inputWidth = calculateInputWidth("老师");
  assert.ok(inputWidth.endsWith("em"));
  assert.ok(parseFloat(inputWidth) > 2.0);
});

test("cloze.js D3. Punctuation Gap Elimination: trailing punctuation receives cloze-token--punct and preceding token receives cloze-token--before-punct", () => {
  function createMockElement(tag) {
    const classes = new Set();
    return {
      tagName: tag.toUpperCase(),
      get className() {
        return [...classes].join(" ");
      },
      set className(v) {
        classes.clear();
        String(v || "").split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
      },
      classList: {
        add: (...cls) => cls.forEach((c) => classes.add(c)),
        remove: (...cls) => cls.forEach((c) => classes.delete(c)),
        contains: (c) => classes.has(c)
      },
      style: {},
      attributes: {},
      setAttribute(k, v) { this.attributes[k] = v; },
      appendChild(c) { this.children.push(c); },
      children: []
    };
  }

  const mockDoc = { createElement: (tag) => createMockElement(tag) };

  const sentence = "Nous allons à l'école .";
  const cloze = generateCloze(sentence, { target: "allons" });
  const rendered = renderCloze(cloze, { document: mockDoc });

  // Last token is punctuation "."
  const punctToken = cloze.tokens[cloze.tokens.length - 1];
  assert.equal(punctToken.text, ".");
  assert.equal(punctToken.isPunct, true, "Punctuation token must have isPunct: true");

  const punctElement = rendered.tokenElements[rendered.tokenElements.length - 1];
  assert.ok(punctElement.classList.contains("cloze-token--punct"), "Punctuation token DOM element must have cloze-token--punct class");

  // Preceding token is "l'école"
  const prePunctElement = rendered.tokenElements[rendered.tokenElements.length - 2];
  assert.ok(prePunctElement.classList.contains("cloze-token--before-punct"), "Pre-punctuation token must have cloze-token--before-punct class");

  // Verify CSS zero-margin rules
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf-8");
  assert.ok(
    css.includes(".cloze-token--punct") && css.includes("margin-left: 0 !important"),
    "CSS must eliminate left margin on punctuation token"
  );
  assert.ok(
    css.includes(".cloze-token--before-punct") && css.includes("margin-right: 0 !important"),
    "CSS must eliminate right margin on token preceding punctuation"
  );
});

test("cloze.js D4. Cloze Input Interface Consolidation: answer-row is completely hidden and cloze typography is scoped", () => {
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf-8");

  // Verify answer-row and help-line are completely suppressed in cloze modes
  assert.ok(
    css.includes('body[data-route="contextual-cloze"] .answer-row') &&
    css.includes('body.has-cloze .answer-row') &&
    css.includes("display: none !important"),
    "CSS must suppress bottom answer-row in Cloze modes"
  );
  assert.ok(
    css.includes('body[data-route="contextual-cloze"] .help-line') &&
    css.includes('body.has-cloze .help-line') &&
    css.includes("display: none !important"),
    "CSS must suppress help-line in Cloze modes"
  );

  // Verify scoped cloze typography
  assert.ok(
    css.includes('.card__prompt[data-size="cloze"]'),
    "CSS must declare dedicated .card__prompt[data-size=\"cloze\"] rule"
  );
  assert.ok(
    css.includes("line-height: 2.2") || css.includes("line-height: 2.0"),
    "Cloze typography must maintain generous line-height (>=2.0) for inline blanks"
  );
  assert.ok(
    css.includes("max-width: 820px"),
    "Cloze prompt must constrain max-width to prevent line-wrap thrashing"
  );
});
