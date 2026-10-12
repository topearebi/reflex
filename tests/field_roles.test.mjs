// Tests for front/back field roles, card adaptation, Hanzi typing, and bilingual cloze deck
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { adaptCardRoles } from "../js/engine.js";
import { getDeckFieldOptions, normalizeCard } from "../js/state.js";
import { isMatch, Modes } from "../js/normalizer.js";
import { expandClozeCard } from "../js/cloze.js";

test("getDeckFieldOptions returns standardized Target Language, Native Language, Hint options", () => {
  const pinyinDeck = { id: "zh-hsk1", romanization: "pinyin" };
  const pinyinOpts = getDeckFieldOptions(pinyinDeck);
  assert.equal(pinyinOpts.length, 3);
  assert.equal(pinyinOpts[0].value, "prompt");
  assert.equal(pinyinOpts[0].label, "Target Language (Hanzi)");
  assert.equal(pinyinOpts[1].value, "answer");
  assert.equal(pinyinOpts[1].label, "Hint / Romanization (Pinyin)");
  assert.equal(pinyinOpts[2].value, "subtitle");
  assert.equal(pinyinOpts[2].label, "Native Language (English)");

  const standardDeck = { id: "fr-top500", cards: [{ prompt: "bonjour", answers: ["hello"] }] };
  const standardOpts = getDeckFieldOptions(standardDeck);
  assert.equal(standardOpts.length, 2);
  assert.equal(standardOpts[0].value, "prompt");
  assert.equal(standardOpts[0].label, "Target Language");
  assert.equal(standardOpts[1].value, "answer");
  assert.equal(standardOpts[1].label, "Native Language");

  const deckWithHint = { id: "custom", cards: [{ prompt: "chat", answers: ["cat"], subtitle: "animal" }] };
  const hintOpts = getDeckFieldOptions(deckWithHint);
  assert.equal(hintOpts.length, 3);
  assert.equal(hintOpts[2].value, "subtitle");
  assert.equal(hintOpts[2].label, "Hint / Notes");
});

test("adaptCardRoles for Mandarin HSK 1: English (Front) -> Hanzi (Back)", () => {
  const card = {
    id: "hsk1-001",
    prompt: "我",
    subtitle: "I",
    answers: ["wo3"]
  };

  // Front: Meaning (subtitle), Back: Hanzi (prompt)
  const adapted = adaptCardRoles(card, "subtitle", "prompt", true);
  assert.equal(adapted.prompt, "I");
  assert.deepEqual(adapted.answers, ["我"]);
  assert.equal(adapted.subtitle, "wo3"); // Remaining field (Pinyin) becomes the hint!

  // Typing the Chinese character "我" matches
  assert.ok(isMatch("我", adapted.answers, Modes.STANDARD, { romanization: "pinyin" }));
  // Trimming / whitespace forgiveness
  assert.ok(isMatch(" 我 ", adapted.answers, Modes.STANDARD, { romanization: "pinyin" }));

  // When hints are turned off:
  const noHint = adaptCardRoles(card, "subtitle", "prompt", false);
  assert.equal(noHint.subtitle, "");
});

test("adaptCardRoles for standard vocab: reverse mode (French -> English reversed to English -> French)", () => {
  const card = {
    id: "fr-01",
    prompt: "bonjour",
    answers: ["hello"],
    subtitle: "greeting"
  };

  // Front: answer, Back: prompt
  const reversed = adaptCardRoles(card, "answer", "prompt", true);
  assert.equal(reversed.prompt, "hello");
  assert.deepEqual(reversed.answers, ["bonjour"]);
  assert.equal(reversed.subtitle, "greeting");

  assert.ok(isMatch("bonjour", reversed.answers, Modes.STANDARD, { lang: "fr" }));
});

test("adaptCardRoles handles cloze cards and hint visibility correctly", () => {
  const clozeCard = {
    id: "cloze-01",
    prompt: "Je {{suis}} fatigué.",
    answers: ["suis"],
    subtitle: "I am tired",
    isCloze: true
  };

  // Prompt and answers stay intact for cloze drill
  const withHint = adaptCardRoles(clozeCard, "prompt", "answer", true);
  assert.equal(withHint.prompt, "Je {{suis}} fatigué.");
  assert.equal(withHint.subtitle, "I am tired");

  const withoutHint = adaptCardRoles(clozeCard, "prompt", "answer", false);
  assert.equal(withoutHint.prompt, "Je {{suis}} fatigué.");
  assert.equal(withoutHint.subtitle, "");
});

test("bilingual-cloze deck has spoiler-free subtitles in both French and Mandarin", () => {
  const file = JSON.parse(readFileSync(new URL("../data/bilingual-cloze.json", import.meta.url)));
  assert.ok(file.cards.length >= 20, "Should have substantial test cards");

  // Verify none of the subtitles leak words like "to be ·", "to work ·", "good ·"
  for (const c of file.cards) {
    if (c.subtitle) {
      assert.ok(!c.subtitle.includes("to be ·"), `Card ${c.id} should not leak 'to be ·'`);
      assert.ok(!c.subtitle.includes("to work ·"), `Card ${c.id} should not leak 'to work ·'`);
      assert.ok(!c.subtitle.includes("to buy ·"), `Card ${c.id} should not leak 'to buy ·'`);
      assert.ok(!c.subtitle.includes("your ·"), `Card ${c.id} should not leak 'your ·'`);
    }
  }

  for (const c of file.cards) {
    const expanded = expandClozeCard(c);
    for (const exp of expanded) {
      assert.ok(exp.answers.length > 0, `Card ${exp.id} has answers`);
      assert.ok(isMatch(exp.answers[0], exp.answers, Modes.STANDARD, file), `Card ${exp.id} matches its own answer`);
    }
  }
});
