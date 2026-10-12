// Checks every built-in card can be answered by typing its own answer, with or without accents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isMatch, answerKey, Modes } from "../js/normalizer.js";

const manifest = JSON.parse(readFileSync(new URL("../data/manifest.json", import.meta.url)));
for (const entry of manifest.decks) {
  const deck = JSON.parse(readFileSync(new URL(`../${entry.file}`, import.meta.url)));
  test(`${entry.id}: every card is answerable`, () => {
    const ids = new Set();
    for (const c of deck.cards) {
      assert.ok(c.id && !ids.has(c.id), `duplicate or missing id ${c.id}`);
      ids.add(c.id);
      assert.equal(typeof c.answer, "string", `${c.id} needs a single answer`);
      for (const mode of [Modes.STANDARD, Modes.STRICT]) {
        assert.ok(answerKey(c.answer, mode, deck).replace("|", ""), `${c.id} empty key`);
        assert.ok(isMatch(c.answer, [c.answer], mode, deck), `${c.id} can't match itself (${mode})`);
      }
      if (!deck.romanization) {
        const plain = c.answer.normalize("NFD").replace(/[̀-ͯ]/g, "");
        assert.ok(isMatch(plain, [c.answer], Modes.STANDARD, deck), `${c.id}: unaccented "${plain}" rejected`);
      }
    }
  });
}
