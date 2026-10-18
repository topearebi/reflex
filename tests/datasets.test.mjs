import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { evaluateInput, Modes } from "../js/normalizer.js";
import {
  tokenizeSentence,
  renderNativeText,
  generateCloze,
  hasLegacyCloze,
  STOP_WORDS
} from "../js/cloze.js";
import { AudioController } from "../js/audio.js";
import { TokenExposureLedger, normalizeCard } from "../js/state.js";

const TEST_DECK_FILES = [
  "data/test-zh-sprint.json",
  "data/test-zh-cloze.json",
  "data/test-yo-tonal.json",
  "data/test-fr-elision.json",
  "data/test-audio-cascade.json",
  "data/test-legacy-cloze.json"
];

function loadDeck(relPath) {
  return JSON.parse(readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8"));
}

/* =========================================================================
   A. Dataset Schema Validation & Linting Tests
   ========================================================================= */

test("A1. Schema Conformance: mandatory fields (id, phonetic, gloss, lang, aliases) with valid types", () => {
  for (const relPath of TEST_DECK_FILES) {
    const deck = loadDeck(relPath);
    assert.ok(deck.name, `${relPath} must have a name`);
    assert.ok(Array.isArray(deck.cards) && deck.cards.length > 0, `${relPath} must contain cards`);

    for (const c of deck.cards) {
      assert.equal(typeof c.id, "string", `${relPath} card ID must be string`);
      assert.ok(c.id.length > 0, `${relPath} card ID cannot be empty`);

      assert.equal(typeof c.phonetic, "string", `${c.id} in ${relPath} must have a phonetic string`);
      assert.ok(c.phonetic.trim().length > 0, `${c.id} phonetic cannot be blank`);

      assert.equal(typeof c.gloss, "string", `${c.id} in ${relPath} must have a gloss string`);
      assert.ok(c.gloss.trim().length > 0, `${c.id} gloss cannot be blank`);

      assert.equal(typeof c.lang, "string", `${c.id} in ${relPath} must have a BCP-47 lang tag`);
      assert.ok(c.lang.trim().length > 0, `${c.id} lang cannot be empty`);

      assert.ok(Array.isArray(c.aliases), `${c.id} in ${relPath} must have an aliases array`);

      // Script is populated for non-Latin orthographies; null for Latin-based languages
      if (c.script !== null && c.script !== undefined) {
        assert.equal(typeof c.script, "string", `${c.id} script must be string if non-null`);
      }

      // Audio is string (Data URI / path) or null/undefined
      if (c.audio !== null && c.audio !== undefined) {
        assert.equal(typeof c.audio, "string", `${c.id} audio must be string if non-null`);
      }

      // Verify that normalizeCard cleanly accepts the card
      const normalized = normalizeCard(c, c.id);
      assert.ok(normalized, `${c.id} failed normalizeCard`);
      assert.equal(normalized.id, c.id);
      assert.ok(normalized.answers.length > 0);
      assert.ok(normalized.prompt.length > 0);
    }
  }
});

test("A2. Unique Identifier Integrity: card IDs across all test decks and built-ins are globally unique", () => {
  const seenTestIds = new Map();
  for (const relPath of TEST_DECK_FILES) {
    const deck = loadDeck(relPath);
    for (const c of deck.cards) {
      assert.ok(c.id, `Card in ${relPath} missing id`);
      assert.ok(
        !seenTestIds.has(c.id),
        `Duplicate card ID "${c.id}" in ${relPath} (previously seen in ${seenTestIds.get(c.id)})`
      );
      seenTestIds.set(c.id, relPath);
    }
  }

  // Also verify that test deck card IDs do not collide with built-in decks
  const manifest = loadDeck("data/manifest.json");
  for (const entry of manifest.decks) {
    if (TEST_DECK_FILES.some((f) => entry.file.endsWith(f))) continue;
    const deck = loadDeck(entry.file);
    for (const c of deck.cards) {
      assert.ok(
        !seenTestIds.has(c.id),
        `Collision between test card ID "${c.id}" and built-in deck ${entry.file}`
      );
    }
  }
});

test("A3. Unicode Normalization: all strings across sample decks are strictly NFC normalized", () => {
  for (const relPath of TEST_DECK_FILES) {
    const deck = loadDeck(relPath);
    for (const c of deck.cards) {
      for (const field of ["phonetic", "gloss", "prompt", "answer"]) {
        if (typeof c[field] === "string") {
          assert.equal(
            c[field],
            c[field].normalize("NFC"),
            `${c.id} field ${field} in ${relPath} is not normalized to Unicode NFC`
          );
        }
      }
      if (typeof c.script === "string") {
        assert.equal(
          c.script,
          c.script.normalize("NFC"),
          `${c.id} script in ${relPath} is not normalized to Unicode NFC`
        );
      }
      for (const alias of c.aliases || []) {
        if (typeof alias === "string") {
          assert.equal(
            alias,
            alias.normalize("NFC"),
            `${c.id} alias "${alias}" in ${relPath} is not normalized to Unicode NFC`
          );
        }
      }
    }
  }
});

test("A4. Alias Population: at least 30% of cards in every sample deck contain aliases", () => {
  for (const relPath of TEST_DECK_FILES) {
    const deck = loadDeck(relPath);
    const total = deck.cards.length;
    const withAliases = deck.cards.filter((c) => Array.isArray(c.aliases) && c.aliases.length > 0).length;
    const percentage = (withAliases / total) * 100;

    assert.ok(
      percentage >= 30,
      `${relPath} has only ${percentage.toFixed(1)}% cards with aliases (minimum 30% required)`
    );
  }
});

/* =========================================================================
   B. Language & Orthography Processing Tests
   ========================================================================= */

test("B1. Chinese Segmentation: test-zh-cloze.json splits cleanly on whitespace and isolates punctuation", () => {
  const deck = loadDeck("data/test-zh-cloze.json");
  for (const card of deck.cards) {
    const tokens = tokenizeSentence(card.prompt);
    assert.ok(tokens.length >= 3, `${card.id} should produce at least 3 tokens`);

    // Verify trailing punctuation token is separated and marked non-targetable
    const lastToken = tokens[tokens.length - 1];
    assert.equal(
      lastToken.isTargetable,
      false,
      `${card.id} trailing punctuation token "${lastToken.raw}" must be non-targetable`
    );

    // Verify there are multiple targetable words in each sentence
    const targetable = tokens.filter((t) => t.isTargetable);
    assert.ok(targetable.length >= 2, `${card.id} must have at least 2 targetable lexical items`);
  }
});

test("B2. Chinese Space-Collapsing: Native Render pipeline produces unbroken Chinese text without interstitial spaces", () => {
  const deck = loadDeck("data/test-zh-cloze.json");
  const card1 = deck.cards.find((c) => c.id === "test-zh-cloze-001");
  assert.ok(card1);

  // Space-delimited prompt: "我 是 老师 。"
  assert.equal(card1.prompt, "我 是 老师 。");

  // Native Render should collapse interstitial spaces: "我是老师。"
  const nativeText = renderNativeText(card1.prompt, "zh-CN");
  assert.equal(nativeText, "我是老师。");
  assert.ok(!nativeText.includes(" "), "Native Chinese rendering must not contain spaces");
});

test("B3. Yorùbá Diacritic Scaffolding: Speed Mode fuzzy matches unaccented input (oluko -> olùkọ́)", () => {
  const deck = loadDeck("data/test-yo-tonal.json");
  const oluko = deck.cards.find((c) => c.id === "test-yo-001");
  const ewa = deck.cards.find((c) => c.id === "test-yo-002");
  const ore = deck.cards.find((c) => c.id === "test-yo-003");

  assert.ok(oluko && ewa && ore);

  // Speed Mode (Standard) allows typing unaccented Latin characters
  assert.equal(evaluateInput("oluko", oluko.answer, oluko.aliases, { mode: Modes.STANDARD, deck }), true);
  assert.equal(evaluateInput("ewa", ewa.answer, ewa.aliases, { mode: Modes.STANDARD, deck }), true);
  assert.equal(evaluateInput("ore", ore.answer, ore.aliases, { mode: Modes.STANDARD, deck }), true);
});

test("B4. Yorùbá Diacritic Enforcement: Strict Mode rejects unaccented input and requires exact tones", () => {
  const deck = loadDeck("data/test-yo-tonal.json");
  const oluko = deck.cards.find((c) => c.id === "test-yo-001");
  const ewa = deck.cards.find((c) => c.id === "test-yo-002");

  assert.ok(oluko && ewa);

  // Strict Mode rejects unaccented input
  assert.equal(evaluateInput("oluko", oluko.answer, oluko.aliases, { mode: Modes.STRICT, deck }), false);
  assert.equal(evaluateInput("ewa", ewa.answer, ewa.aliases, { mode: Modes.STRICT, deck }), false);

  // Strict Mode accepts exact accented orthography
  assert.equal(evaluateInput("olùkọ́", oluko.answer, oluko.aliases, { mode: Modes.STRICT, deck }), true);
  assert.equal(evaluateInput("ẹwà", ewa.answer, ewa.aliases, { mode: Modes.STRICT, deck }), true);
});

test("B5. French Contraction & Elision: apostrophes (c'est, l'eau, j'ai) parse without dropping punctuation", () => {
  const deck = loadDeck("data/test-fr-elision.json");
  const card1 = deck.cards.find((c) => c.id === "test-fr-001");
  const card2 = deck.cards.find((c) => c.id === "test-fr-002");
  assert.ok(card1 && card2);

  // "C'est l'eau fraîche de la source ."
  const tokens1 = tokenizeSentence(card1.prompt);
  const rawTokens1 = tokens1.map((t) => t.text);
  assert.ok(rawTokens1.includes("C'est"), "Should recognize C'est without stripping apostrophe");
  assert.ok(rawTokens1.includes("l'eau"), "Should recognize l'eau without stripping apostrophe");

  // "J'ai un rendez-vous très important ."
  const tokens2 = tokenizeSentence(card2.prompt);
  const rawTokens2 = tokens2.map((t) => t.text);
  assert.ok(rawTokens2.includes("J'ai"), "Should recognize J'ai with apostrophe intact");
  assert.ok(rawTokens2.includes("rendez-vous"), "Should recognize hyphenated compound rendez-vous intact");
});

test("B6. French Synonym & Alias Interchangeability: multi-verb/noun aliases accept either option", () => {
  const deck = loadDeck("data/test-fr-elision.json");
  const cardBoire = deck.cards.find((c) => c.id === "test-fr-005");
  const cardTravail = deck.cards.find((c) => c.id === "test-fr-004");
  const cardCommence = deck.cards.find((c) => c.id === "test-fr-006");

  assert.ok(cardBoire && cardTravail && cardCommence);

  // Primary targets pass
  assert.equal(evaluateInput("boire", cardBoire.answer, cardBoire.aliases, { mode: Modes.STANDARD, deck }), true);
  assert.equal(evaluateInput("travail", cardTravail.answer, cardTravail.aliases, { mode: Modes.STANDARD, deck }), true);
  assert.equal(evaluateInput("commence", cardCommence.answer, cardCommence.aliases, { mode: Modes.STANDARD, deck }), true);

  // Synonyms in aliases pass with identical verdict
  assert.equal(evaluateInput("prendre", cardBoire.answer, cardBoire.aliases, { mode: Modes.STANDARD, deck }), true);
  assert.equal(evaluateInput("boulot", cardTravail.answer, cardTravail.aliases, { mode: Modes.STANDARD, deck }), true);
  assert.equal(evaluateInput("emploi", cardTravail.answer, cardTravail.aliases, { mode: Modes.STANDARD, deck }), true);
  assert.equal(evaluateInput("débute", cardCommence.answer, cardCommence.aliases, { mode: Modes.STANDARD, deck }), true);
  assert.equal(evaluateInput("entame", cardCommence.answer, cardCommence.aliases, { mode: Modes.STANDARD, deck }), true);

  // Unrelated words fail
  assert.equal(evaluateInput("manger", cardBoire.answer, cardBoire.aliases, { mode: Modes.STANDARD, deck }), false);
});

/* =========================================================================
   C. Audio Pipeline & Cascade Boundary Tests
   ========================================================================= */

test("C1. Base64 Audio Decoding: test-audio-cascade.json Card A inline Base64 decodes into valid AudioBuffer", async () => {
  const deck = loadDeck("data/test-audio-cascade.json");
  const cardA = deck.cards.find((c) => c.id === "test-aud-001");
  assert.ok(cardA && cardA.audio.startsWith("data:audio/wav;base64,"));

  let decodedBuffer = null;
  class MockAudioContext {
    constructor() {
      this.state = "running";
      this.destination = {};
    }
    async resume() {}
    createBufferSource() {
      return {
        buffer: null,
        connect() {},
        disconnect() {},
        start() {
          setTimeout(() => this.onended?.(), 5);
        },
        stop() {},
        onended: null
      };
    }
    async decodeAudioData(arrayBuffer) {
      const buf = Buffer.from(arrayBuffer);
      assert.equal(buf.toString("utf8", 0, 4), "RIFF", "Decoded data must have RIFF header");
      assert.equal(buf.toString("utf8", 8, 12), "WAVE", "Decoded data must be WAVE");
      decodedBuffer = {
        duration: 0.05,
        numberOfChannels: 1,
        sampleRate: 8000,
        length: (buf.length - 44) / 2
      };
      return decodedBuffer;
    }
  }

  const audioController = new AudioController({
    audioContext: new MockAudioContext(),
    autoUnlock: false
  });

  const res = await audioController.playCurrent(cardA);
  assert.equal(res.status, "finished");
  assert.equal(res.mode, "webaudio");
  assert.ok(decodedBuffer, "AudioBuffer must be successfully instantiated in memory");
});

test("C2. Speech Synthesis Cascade: Card C (audio: null, lang: fr-FR) triggers SpeechSynthesis fallback cleanly", async () => {
  const deck = loadDeck("data/test-audio-cascade.json");
  const cardC = deck.cards.find((c) => c.id === "test-aud-003");
  assert.ok(cardC && cardC.audio === null && cardC.lang === "fr-FR");

  const spokenUtterances = [];
  class MockSpeechSynthesis {
    speak(utterance) {
      spokenUtterances.push(utterance);
      setTimeout(() => utterance.onend?.(), 5);
    }
    cancel() {}
  }
  class MockUtterance {
    constructor(text) {
      this.text = text;
      this.lang = "";
      this.onend = null;
      this.onerror = null;
    }
  }

  const audioController = new AudioController({
    speechSynthesis: new MockSpeechSynthesis(),
    SpeechSynthesisUtterance: MockUtterance,
    autoUnlock: false
  });

  const res = await audioController.playCurrent(cardC);
  assert.equal(res.status, "finished");
  assert.equal(res.mode, "speech");
  assert.equal(res.lang, "fr-FR");
  assert.equal(spokenUtterances.length, 1);
  assert.equal(spokenUtterances[0].text, cardC.answer);
  assert.equal(spokenUtterances[0].lang, "fr-FR");
});

test("C3. Silent Fallback Gracefulness: Card D (unsupported lang: xx-ZZ) bypasses audio without freezing or throwing", async () => {
  const deck = loadDeck("data/test-audio-cascade.json");
  const cardD = deck.cards.find((c) => c.id === "test-aud-004");
  assert.ok(cardD && cardD.audio === null && cardD.lang === "xx-ZZ");

  class MockSpeechSynthesis {
    speak(utterance) {
      // Simulate unsupported speech engine error callback
      setTimeout(() => utterance.onerror?.({ error: "language-unavailable" }), 5);
    }
    cancel() {}
  }
  class MockUtterance {
    constructor(text) {
      this.text = text;
      this.lang = "";
      this.onend = null;
      this.onerror = null;
    }
  }

  const audioController = new AudioController({
    speechSynthesis: new MockSpeechSynthesis(),
    SpeechSynthesisUtterance: MockUtterance,
    autoUnlock: false
  });

  const res = await audioController.playCurrent(cardD);
  assert.equal(res.status, "silence");
  assert.equal(res.mode, "fallback");
});

/* =========================================================================
   D. Dynamic Cloze & Session Ledger Tests
   ========================================================================= */

test("D1. Rotating Blank Generation: 10 simulated reviews rotate targets without repeatedly targeting particles like 是", () => {
  const deck = loadDeck("data/test-zh-cloze.json");
  const sentenceCard = deck.cards.find((c) => c.id === "test-zh-cloze-002");
  assert.ok(sentenceCard);

  // "我们 在 学校 学习 汉语 。"
  // Stop words: 我们, 在. Content candidates: 学校, 学习, 汉语.
  const ledger = new TokenExposureLedger();
  const targets = [];

  for (let review = 0; review < 10; review++) {
    const cloze = generateCloze(sentenceCard, { ledger, saturationLimit: 2 });
    assert.ok(cloze.target, `Review ${review} must have a selected target`);
    targets.push(cloze.target);
    ledger.recordExposure(cloze.target, true);
  }

  // Saturated particles like "在" should never be targeted over content words
  assert.ok(!targets.includes("在"), 'Grammatical particle "在" must not be targeted when content words are available');

  // Verify rotation across multiple distinct tokens
  const uniqueTargets = new Set(targets);
  assert.ok(
    uniqueTargets.size >= 2,
    `Should rotate across multiple distinct tokens over 10 reviews (got: ${[...uniqueTargets].join(", ")})`
  );
  assert.ok(uniqueTargets.has("学校"));
  assert.ok(uniqueTargets.has("学习") || uniqueTargets.has("汉语"));
});

test("D2. Backward Compatibility Pass: test-legacy-cloze.json with {{c1::...}} renders seamlessly alongside space-delimited cards", () => {
  const legacyDeck = loadDeck("data/test-legacy-cloze.json");
  const clozeDeck = loadDeck("data/test-zh-cloze.json");

  // Verify all cards in test-legacy-cloze.json are recognized as legacy cloze
  for (const card of legacyDeck.cards) {
    assert.ok(hasLegacyCloze(card.prompt), `${card.id} must be recognized as legacy cloze`);
    const cloze = generateCloze(card);
    assert.ok(cloze.target, `${card.id} must extract target`);
    assert.ok(cloze.isLegacy, `${card.id} must be flagged as legacy cloze`);
    assert.ok(!cloze.tokens.some((t) => t.text.includes("{{c1::")), "Tokens must be stripped of cloze brackets");
  }

  // Interleave legacy cards with space-delimited cards to simulate a mixed review session
  const mixedPool = [legacyDeck.cards[0], clozeDeck.cards[0], legacyDeck.cards[1], clozeDeck.cards[1]];
  for (const card of mixedPool) {
    const cloze = generateCloze(card);
    assert.ok(cloze && cloze.target, `Card ${card.id} failed mixed cloze generation`);
  }
});

test("A5. HTML Document Encoding: web application document declares UTF-8 encoding as its initial head parameter", () => {
  const rootDir = resolve(new URL(".", import.meta.url).pathname, "..");
  const htmlPath = join(rootDir, "index.html");
  const html = readFileSync(htmlPath, "utf8");

  // Verify declaration appears within first 1024 bytes (HTML5 specification)
  const headPrefix = html.slice(0, 1024);
  assert.ok(
    /<head>[\s\r\n]*<meta\s+charset=["']?utf-8["']?\s*\/?>/i.test(headPrefix),
    "Initial parameter inside <head> must be <meta charset=\"utf-8\"> within first 1024 bytes"
  );
});

test("A6. Unicode Enforcement & Canonical Fixtures: sample datasets assert against actual canonical Unicode strings without double-encoded Mojibake", () => {
  const rootDir = resolve(new URL(".", import.meta.url).pathname, "..");
  const dataDir = join(rootDir, "data");

  const docFiles = [
    join(rootDir, "README.md"),
    join(rootDir, "DESIGN_NOTES.md")
  ];

  const deckFiles = readdirSync(dataDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => join(dataDir, file));

  function isDoubleEncoded(str) {
    if (typeof str !== "string" || !str) return false;
    try {
      const buf = Buffer.from(str, "latin1");
      const decoded = buf.toString("utf8");
      return decoded !== str && !decoded.includes("\uFFFD") && /[^\x00-\x7F]/.test(decoded);
    } catch {
      return false;
    }
  }

  // 1. Check all documentation and deck files for BOM, replacement chars, and NFC normalization
  for (const filePath of [...docFiles, ...deckFiles]) {
    const rawBuffer = readFileSync(filePath);

    // Assert no UTF-8 Byte Order Mark (BOM: EF BB BF)
    assert.ok(
      rawBuffer.length < 3 || rawBuffer[0] !== 0xef || rawBuffer[1] !== 0xbb || rawBuffer[2] !== 0xbf,
      `BOM header found in ${filePath}`
    );

    const content = rawBuffer.toString("utf8");

    // Assert no replacement character U+FFFD (Mojibake artifact)
    assert.ok(!content.includes("\uFFFD"), `U+FFFD replacement character found in ${filePath}`);

    // Assert Unicode NFC normalization
    assert.equal(content, content.normalize("NFC"), `${filePath} is not normalized to Unicode NFC`);
  }

  // 2. Algorithmic double-encoded detection across all deck cards
  for (const filePath of deckFiles) {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    for (const card of data.cards || []) {
      for (const [k, v] of Object.entries(card)) {
        if (typeof v === "string") {
          assert.equal(
            isDoubleEncoded(v),
            false,
            `Double-encoded string found in ${filePath} card ${card.id} field ${k}: ${v}`
          );
        }
        if (Array.isArray(v)) {
          for (const item of v) {
            if (typeof item === "string") {
              assert.equal(
                isDoubleEncoded(item),
                false,
                `Double-encoded string found in ${filePath} card ${card.id} field ${k}: ${item}`
              );
            }
          }
        }
      }
    }
  }

  // 3. Assert canonical Unicode strings in sample datasets (not double-encoded)
  const zhSprint = loadDeck("data/test-zh-sprint.json");
  assert.equal(zhSprint.cards[0].script, "老师");
  assert.ok(zhSprint.cards[0].aliases.includes("lǎoshī"));
  assert.equal(zhSprint.cards[2].script, "中国");
  assert.ok(zhSprint.cards[2].aliases.includes("zhōngguó"));
  assert.equal(zhSprint.cards[6].script, "你好");
  assert.ok(zhSprint.cards[6].aliases.includes("nǐhǎo"));
  assert.equal(zhSprint.cards[7].script, "再见");
  assert.ok(zhSprint.cards[7].aliases.includes("zàijiàn"));

  const zhCloze = loadDeck("data/test-zh-cloze.json");
  assert.equal(zhCloze.cards[0].prompt, "我 是 老师 。");
  assert.equal(zhCloze.cards[0].answer, "老师");
  assert.ok(zhCloze.cards[0].aliases.includes("lǎoshī"));
  assert.equal(zhCloze.cards[1].prompt, "我们 在 学校 学习 汉语 。");
  assert.equal(zhCloze.cards[1].answer, "学校");
  assert.ok(zhCloze.cards[1].aliases.includes("xuéxiào"));

  const yoTonal = loadDeck("data/test-yo-tonal.json");
  assert.equal(yoTonal.cards[0].phonetic, "olùkọ́");
  assert.equal(yoTonal.cards[0].answer, "olùkọ́");
  assert.equal(yoTonal.cards[1].phonetic, "ẹwà");
  assert.equal(yoTonal.cards[1].answer, "ẹwà");
  assert.equal(yoTonal.cards[2].phonetic, "ọ̀rẹ́");
  assert.equal(yoTonal.cards[2].answer, "ọ̀rẹ́");
  assert.equal(yoTonal.cards[3].phonetic, "àlàáfíà");
  assert.equal(yoTonal.cards[3].answer, "àlàáfíà");
  assert.equal(yoTonal.cards[6].phonetic, "ṣàngó");
  assert.equal(yoTonal.cards[6].answer, "ṣàngó");

  const frElision = loadDeck("data/test-fr-elision.json");
  assert.equal(frElision.cards[0].prompt, "C'est l'eau fraîche de la source .");
  assert.equal(frElision.cards[0].answer, "l'eau");
  assert.equal(frElision.cards[2].answer, "peut-être");
  assert.ok(frElision.cards[5].aliases.includes("débute"));
  assert.ok(frElision.cards[5].aliases.includes("entame"));
  assert.equal(frElision.cards[8].answer, "fenêtre");
  assert.equal(frElision.cards[9].answer, "forêt");
});
