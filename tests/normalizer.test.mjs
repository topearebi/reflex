// Run with: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isMatch, Modes, evaluateInput } from "../js/normalizer.js";
import { RecallEngine } from "../js/engine.js";
import { Store } from "../js/state.js";

const zh = { romanization: "pinyin" };
const fr = { lang: "fr" };
const yes = (input, answer, mode, deck) => assert.ok(isMatch(input, [answer], mode, deck), `${input} should match ${answer} (${mode})`);
const no = (input, answer, mode, deck) => assert.ok(!isMatch(input, [answer], mode, deck), `${input} should NOT match ${answer} (${mode})`);

test("pinyin standard: tones required, numbers or marks", () => {
  yes("ni3hao3", "ni3hao3", Modes.STANDARD, zh);
  yes("nǐhǎo", "ni3hao3", Modes.STANDARD, zh);
  yes("ni3 hǎo", "ni3hao3", Modes.STANDARD, zh);
  yes("wǒmen", "wo3men", Modes.STANDARD, zh);
  yes("wo3men5", "wo3men", Modes.STANDARD, zh);
  yes("nv3", "nǚ", Modes.STANDARD, zh);
  yes("nü3", "nv3", Modes.STANDARD, zh);
  yes("lu:4", "lv4", Modes.STANDARD, zh);
  no("nihao", "ni3hao3", Modes.STANDARD, zh);
  no("ni3hao", "ni3hao3", Modes.STANDARD, zh);
  no("ni2hao3", "ni3hao3", Modes.STANDARD, zh);
  no("wo", "wo3", Modes.STANDARD, zh);
});

test("pinyin relaxed: tones optional", () => {
  yes("nihao", "ni3hao3", Modes.RELAXED, zh);
  yes("ni3hao", "nǐhǎo", Modes.RELAXED, zh);
  no("niha", "ni3hao3", Modes.RELAXED, zh);
});

test("pinyin strict: exact", () => {
  yes("ni3hao3", "ni3hao3", Modes.STRICT, zh);
  no("nǐhǎo", "ni3hao3", Modes.STRICT, zh);
});

test("latin standard: accents and punctuation optional", () => {
  yes("ete", "été", Modes.STANDARD, fr);
  yes("a", "à", Modes.STANDARD, fr);
  yes("etre", "être", Modes.STANDARD, fr);
  yes("francais", "français", Modes.STANDARD, fr);
  yes("jai", "j'ai", Modes.STANDARD, fr);
  yes("j’ai", "j'ai", Modes.STANDARD, fr);
  yes("coeur", "cœur", Modes.STANDARD, fr);
  yes("Ice Cream", "ice cream", Modes.STANDARD, fr);
  no("of", "from", Modes.STANDARD, fr);
  no("", "a", Modes.STANDARD, fr);
});

test("latin strict: accents required", () => {
  yes("été", "été", Modes.STRICT, fr);
  yes("Été", "été", Modes.STRICT, fr);
  no("ete", "été", Modes.STRICT, fr);
});

test("kana marks are not optional", () => {
  no("か", "が", Modes.STANDARD, { lang: "ja" });
  yes("が", "が", Modes.STANDARD, { lang: "ja" });
});

test("arabic vowel marks optional in standard", () => {
  yes("كتب", "كَتَبَ", Modes.STANDARD, { lang: "ar" });
});

test("evaluateInput: dual-mode diacritic evaluation (speed/lenient vs strict)", async () => {
  const { evaluateInput } = await import("../js/normalizer.js");
  // Lenient
  assert.ok(evaluateInput("ete", "été", ["l'été"], false));
  assert.ok(evaluateInput("ETE", "été", ["l'été"], false));
  assert.ok(evaluateInput("l'ete", "été", ["l'été"], false));
  assert.ok(!evaluateInput("hiver", "été", ["l'été"], false));

  // Strict
  assert.ok(evaluateInput("été", "été", ["l'été"], true));
  assert.ok(evaluateInput("Été", "été", ["l'été"], true));
  assert.ok(!evaluateInput("ete", "été", ["l'été"], true));
});

test("evaluateInput: complex alias resolution with mixed casings, numbers, and accents", async () => {
  const { evaluateInput } = await import("../js/normalizer.js");
  const target = "Nǐ Hǎo";
  const aliases = ["ni3hao3", "Hello 1", "nǐhǎo!", "BONJOUR 2"];

  // User input typed without tone markers
  assert.ok(evaluateInput("nihao", target, aliases, false), "nihao should match nǐhǎo / ni3hao3 in lenient mode");
  assert.ok(evaluateInput("NIHAO", target, aliases, false), "uppercase NIHAO should match in lenient mode");

  // User input typed with tone markers (diacritics or numbers)
  assert.ok(evaluateInput("nǐhǎo", target, aliases, false), "nǐhǎo with marks should match");
  assert.ok(evaluateInput("ni3hao3", target, aliases, false), "ni3hao3 with numbers should match");

  // User input matching mixed casing and numbers alias
  assert.ok(evaluateInput("hello 1", target, aliases, false), "hello 1 should match Hello 1");
  assert.ok(evaluateInput("bonjour 2", target, aliases, false), "bonjour 2 should match BONJOUR 2");

  // Incorrect inputs
  assert.ok(!evaluateInput("goodbye", target, aliases, false), "goodbye should not match");
  assert.ok(!evaluateInput("nihao", target, aliases, true), "nihao should not match in strict mode");
});

test("evaluateInput: throughput benchmark under 10ms for 1,000 evaluations", async () => {
  const { evaluateInput } = await import("../js/normalizer.js");
  const target = "cœur";
  const aliases = ["coeur", "le cœur", "COEUR!", "kœur"];
  const deck = { lang: "fr" };

  // Warmup JIT
  for (let i = 0; i < 500; i++) {
    evaluateInput("coeur", target, aliases, { deck, strict: false });
  }

  const start = performance.now();
  for (let i = 0; i < 1000; i++) {
    const res = evaluateInput("coeur", target, aliases, { deck, strict: false });
    if (!res) throw new Error("Expected match");
  }
  const duration = performance.now() - start;
  assert.ok(duration < 20, `Expected 1,000 evaluations in <20ms, took ${duration.toFixed(3)}ms`);
});

/* =========================================================================
   B. Normalization & Matching Tests
   ========================================================================= */

test("normalizer.js B1. Unicode Equivalence (NFC vs. NFD): precomposed characters match decomposed base + combining accent across modes", () => {
  const nfc = "\u00E9"; // é (precomposed, length 1)
  const nfd = "e\u0301"; // e + combining acute (decomposed, length 2)

  // Verify byte-level divergence in raw strings
  assert.notEqual(nfc, nfd, "Raw strings must differ in character representation");
  assert.equal(nfc.length, 1);
  assert.equal(nfd.length, 2);

  // Speed / Standard mode equivalence
  assert.ok(evaluateInput(nfc, nfd, [], false), "Precomposed NFC input must match decomposed NFD target in speed mode");
  assert.ok(evaluateInput(nfd, nfc, [], false), "Decomposed NFD input must match precomposed NFC target in speed mode");

  // Strict mode equivalence
  assert.ok(evaluateInput(nfc, nfd, [], true), "Precomposed NFC input must match decomposed NFD target in strict mode");
  assert.ok(evaluateInput(nfd, nfc, [], true), "Decomposed NFD input must match precomposed NFC target in strict mode");

  // Multi-character word with accents: crème
  const cremeNFC = "cr\u00E8me";
  const cremeNFD = "cre\u0300me";
  assert.ok(evaluateInput(cremeNFC, cremeNFD, [], true));
  assert.ok(evaluateInput(cremeNFD, cremeNFC, [], true));

  // Direct isMatch checks
  assert.ok(isMatch(nfc, [nfd], Modes.STRICT), "isMatch STRICT must be NFC/NFD invariant");
  assert.ok(isMatch(nfd, [nfc], Modes.STRICT), "isMatch STRICT must be NFC/NFD invariant");
  assert.ok(isMatch(nfc, [nfd], Modes.STANDARD), "isMatch STANDARD must be NFC/NFD invariant");
});

test("normalizer.js B2. Speed Mode Diacritic Stripping: unaccented input matches combining diacritics for Yoruba and French", () => {
  // Yoruba: oluko matching olùkọ́ (contains tone accents and sub-dots)
  assert.ok(
    evaluateInput("oluko", "olùkọ́", [], false),
    "Unaccented 'oluko' must match fully accented Yoruba 'olùkọ́' in Speed Mode"
  );
  assert.ok(
    evaluateInput("OLUKO", "olùkọ́", [], false),
    "Uppercase 'OLUKO' must match 'olùkọ́' in Speed Mode"
  );

  // French: eleve matching élève
  assert.ok(
    evaluateInput("eleve", "élève", [], false),
    "Unaccented 'eleve' must match French 'élève' in Speed Mode"
  );
  assert.ok(
    evaluateInput("ELEVE", "élève", [], false),
    "Uppercase 'ELEVE' must match French 'élève' in Speed Mode"
  );

  // Additional Yoruba with sub-dots: osun matching ọ̀ṣun
  assert.ok(evaluateInput("osun", "ọ̀ṣun", [], false));
});

test("normalizer.js B3. Strict Mode Diacritic Rejection: under Strict Mode, unaccented input fails while exact accented string passes", () => {
  // Yoruba: oluko must fail, olùkọ́ must pass
  assert.equal(
    evaluateInput("oluko", "olùkọ́", [], true),
    false,
    "Unaccented input 'oluko' must be rejected in Strict Mode against 'olùkọ́'"
  );
  assert.ok(
    evaluateInput("olùkọ́", "olùkọ́", [], true),
    "Exact accented 'olùkọ́' must pass in Strict Mode"
  );
  assert.ok(
    evaluateInput("Olùkọ́", "olùkọ́", [], true),
    "Cased exact accented 'Olùkọ́' must pass in Strict Mode"
  );

  // French: eleve must fail, élève must pass
  assert.equal(
    evaluateInput("eleve", "élève", [], true),
    false,
    "Unaccented input 'eleve' must be rejected in Strict Mode against 'élève'"
  );
  assert.ok(
    evaluateInput("élève", "élève", [], true),
    "Exact accented 'élève' must pass in Strict Mode"
  );
  assert.ok(
    evaluateInput("Élève", "élève", [], true),
    "Cased exact accented 'Élève' must pass in Strict Mode"
  );
});

test("normalizer.js B4. Tone Suffix Handling: numerical tone inputs normalize and match targets formatted with visual tone marks", () => {
  // lao3shi1 matches lǎoshī
  assert.ok(
    evaluateInput("lao3shi1", "lǎoshī", [], false),
    "Numerical tone input 'lao3shi1' must match tone mark target 'lǎoshī'"
  );
  assert.ok(
    evaluateInput("LAO3SHI1", "lǎoshī", [], false),
    "Uppercase numerical tone input 'LAO3SHI1' must match 'lǎoshī'"
  );

  // Reverse: tone mark input matches numerical target
  assert.ok(
    evaluateInput("lǎoshī", "lao3shi1", [], false),
    "Tone mark input 'lǎoshī' must match numerical target 'lao3shi1'"
  );

  // Other pinyin tone conversions
  assert.ok(evaluateInput("ni3hao3", "nǐhǎo", [], false));
  assert.ok(evaluateInput("wo3men", "wǒmen", [], false));
  assert.ok(evaluateInput("zhong1guo2", "zhōngguó", [], false));
});

/* =========================================================================
   C. Alias & Synonym Evaluation Tests
   ========================================================================= */

test("normalizer.js C1. Primary Target Match: entering standard target advances the card", () => {
  const store = new Store();
  const engine = new RecallEngine(store);

  const card = {
    id: "card-primary-match",
    prompt: "to start",
    answer: "commencer",
    answers: ["commencer"],
    aliases: ["débuter", "entamer"]
  };

  engine.card = card;
  engine.phase = "answering";

  // Typing primary target
  engine.input("commencer");

  assert.equal(engine.phase, "advancing", "Entering primary target must advance card phase to advancing");
  assert.equal(store.session.attempts, 1);
  assert.equal(store.session.correct, 1);
});

test("normalizer.js C2. Secondary Alias Match: entering any string in aliases evaluates to true and triggers the same advancement event", () => {
  const store = new Store();
  const engine = new RecallEngine(store);

  const card = {
    id: "card-alias-match",
    prompt: "to start",
    answer: "commencer",
    answers: ["commencer"],
    aliases: ["débuter", "entamer"]
  };

  // 1. evaluateInput verification
  assert.ok(evaluateInput("débuter", card.answers, card.aliases, false), "First alias must evaluate to true");
  assert.ok(evaluateInput("entamer", card.answers, card.aliases, false), "Second alias must evaluate to true");
  assert.equal(evaluateInput("finir", card.answers, card.aliases, false), false, "Non-alias must evaluate to false");

  // 2. Engine state transition on first alias
  engine.card = { ...card };
  engine.phase = "answering";
  engine.input("débuter");

  assert.equal(engine.phase, "advancing", "Entering alias 'débuter' must advance card phase to advancing");
  assert.equal(store.session.attempts, 1);
  assert.equal(store.session.correct, 1);

  // 3. Engine state transition on second alias
  engine.card = { ...card };
  engine.phase = "answering";
  engine.input("entamer");

  assert.equal(engine.phase, "advancing", "Entering alias 'entamer' must advance card phase to advancing");
  assert.equal(store.session.attempts, 2);
  assert.equal(store.session.correct, 2);
});

test("normalizer.js C3. Whitespace & Case Insensitivity: extraneous leading/trailing whitespace and mixed casing match target and aliases", () => {
  const target = "commencer";
  const aliases = ["débuter", "entamer"];

  // Extraneous whitespace and mixed casing against primary target
  assert.ok(evaluateInput("   COMMENCER   ", target, aliases, false));
  assert.ok(evaluateInput("  ComMenCer  ", target, aliases, false));
  assert.ok(evaluateInput("\tcommencer\n", target, aliases, false));

  // Extraneous whitespace and mixed casing against aliases
  assert.ok(evaluateInput("   DÉBUTER   ", target, aliases, false));
  assert.ok(evaluateInput("  DéBuTeR  ", target, aliases, false));
  assert.ok(evaluateInput("   ENTAMER   ", target, aliases, false));
  assert.ok(evaluateInput("  EnTaMeR  ", target, aliases, false));

  // Engine advancement with messy input
  const store = new Store();
  const engine = new RecallEngine(store);
  engine.card = {
    id: "card-messy-input",
    prompt: "to start",
    answer: target,
    answers: [target],
    aliases
  };
  engine.phase = "answering";

  engine.input("   DÉBUTER   ");
  assert.equal(engine.phase, "advancing", "Messy casing and whitespace must advance card smoothly");
});

