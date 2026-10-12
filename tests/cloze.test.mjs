// Tests for cloze parsing, card expansion, Anki compatibility, and unit chunking
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanAnkiHtml,
  hasCloze,
  parseClozeGaps,
  expandClozeCard,
  autoExtractCloze,
  chunkCardsIntoUnits
} from "../js/cloze.js";
import { isMatch, Modes } from "../js/normalizer.js";
import { parseTSV, parseRowsForEditor } from "../js/importer.js";

test("cleanAnkiHtml strips tags, sound tokens, and decodes entities", () => {
  assert.equal(cleanAnkiHtml("<b>Bonjour</b><br>[sound:test.mp3]"), "Bonjour");
  assert.equal(cleanAnkiHtml("<div>Hier&nbsp;j&#39;ai</div>"), "Hier j'ai");
  assert.equal(cleanAnkiHtml("Paris &amp; London"), "Paris & London");
});

test("hasCloze detects unnumbered and numbered Anki cloze", () => {
  assert.ok(hasCloze("Je {{suis}} fatigué."));
  assert.ok(hasCloze("Hier, j'{{c1::ai}} mangé."));
  assert.ok(hasCloze("{{c2::Paris::capital}}"));
  assert.ok(!hasCloze("No cloze markers here."));
});

test("parseClozeGaps extracts answers and hints", () => {
  const gaps = parseClozeGaps("Hier, j'{{c1::ai}} {{c2::mangé::manger}} une pomme.");
  assert.equal(gaps.length, 2);
  assert.equal(gaps[0].answer, "ai");
  assert.equal(gaps[0].ankiNum, 1);
  assert.equal(gaps[0].hint, "");
  assert.equal(gaps[1].answer, "mangé");
  assert.equal(gaps[1].ankiNum, 2);
  assert.equal(gaps[1].hint, "manger");
});

test("expandClozeCard splits multi-gap sentence into one card per gap with other gaps filled in", () => {
  const card = {
    id: "sent-01",
    group: "Grammar",
    unit: "Unit 1",
    prompt: "Hier, j'{{ai}} {{mangé::manger}} une pomme.",
    subtitle: "Yesterday I ate an apple."
  };

  const expanded = expandClozeCard(card);
  assert.equal(expanded.length, 2);

  // First card: target is 'ai', 'mangé' is filled in
  assert.equal(expanded[0].id, "sent-01-c1");
  assert.equal(expanded[0].answers[0], "ai");
  assert.equal(expanded[0].prompt, "Hier, j'{{ai}} mangé une pomme.");
  assert.equal(expanded[0].clozeData.prefix, "Hier, j'");
  assert.equal(expanded[0].clozeData.suffix, " mangé une pomme.");

  // Second card: target is 'mangé', 'ai' is filled in
  assert.equal(expanded[1].id, "sent-01-c2");
  assert.equal(expanded[1].answers[0], "mangé");
  assert.equal(expanded[1].prompt, "Hier, j'ai {{mangé::manger}} une pomme.");
  assert.equal(expanded[1].clozeData.prefix, "Hier, j'ai ");
  assert.equal(expanded[1].clozeData.suffix, " une pomme.");
  assert.ok(expanded[1].subtitle.includes("manger"));
});

test("autoExtractCloze extracts primary answer and hint for editor", () => {
  const res = autoExtractCloze("Je {{suis::être}} fatigué.");
  assert.equal(res.primaryAnswer, "suis");
  assert.equal(res.primaryHint, "être");
});

test("chunkCardsIntoUnits partitions cards into groups of 10", () => {
  const cards = Array.from({ length: 25 }, (_, i) => ({ id: `c-${i}`, prompt: `p-${i}`, unit: "raw" }));
  const chunked = chunkCardsIntoUnits(cards, 10);
  assert.equal(chunked[0].unit, "1–10");
  assert.equal(chunked[9].unit, "1–10");
  assert.equal(chunked[10].unit, "11–20");
  assert.equal(chunked[19].unit, "11–20");
  assert.equal(chunked[20].unit, "21–30");
});

test("parseTSV handles single-line Anki cloze imports", () => {
  const tsv = "#separator:tab\nJe {{c1::suis}} fatigué.\tI am tired.";
  const { cards, errors } = parseTSV(tsv);
  assert.equal(errors.length, 0);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].prompt, "Je {{c1::suis}} fatigué.");
  assert.equal(cards[0].answers[0], "suis");
  assert.equal(cards[0].subtitle, "I am tired.");
});

test("parseRowsForEditor handles Anki text exports", () => {
  const tsv = "Je {{c1::vais::aller}} à Paris.\tI go to Paris.\tA1";
  const rows = parseRowsForEditor(tsv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prompt, "Je {{c1::vais::aller}} à Paris.");
  assert.equal(rows[0].answer, "vais");
  assert.equal(rows[0].hint, "I go to Paris.");
  assert.equal(rows[0].unit, "A1");
});

test("CJK character cloze matching in pinyin deck", () => {
  const zhDeck = { lang: "zh-CN", romanization: "pinyin" };
  // Target answer is a Chinese character (e.g. 是)
  assert.ok(isMatch("是", ["是"], Modes.STANDARD, zhDeck));
  assert.ok(isMatch(" 学生 ", ["学生"], Modes.STANDARD, zhDeck));
});

test("reverse mode transformation rules: vocab reverses, cloze remains target-sentence fill-in", () => {
  const vocabCard = { id: "v1", prompt: "bonjour", answers: ["hello"], subtitle: "greeting" };
  const clozeCard = { id: "c1", prompt: "Je {{suis}} fatigué.", isCloze: true, answers: ["suis"], subtitle: "" };

  // Helper simulating engine pick reverse transformation
  function prepareCard(card, reverseMode) {
    if (reverseMode && card && !card.isCloze) {
      return {
        ...card,
        isReversed: true,
        prompt: card.answers[0],
        answers: [card.prompt],
        subtitle: card.subtitle || ""
      };
    }
    return card;
  }

  const reversedVocab = prepareCard(vocabCard, true);
  assert.equal(reversedVocab.prompt, "hello");
  assert.deepEqual(reversedVocab.answers, ["bonjour"]);
  assert.ok(isMatch("bonjour", reversedVocab.answers, Modes.STANDARD, { lang: "fr" }));

  const nonReversedCloze = prepareCard(clozeCard, true);
  assert.equal(nonReversedCloze.prompt, "Je {{suis}} fatigué.");
  assert.deepEqual(nonReversedCloze.answers, ["suis"]);
});

