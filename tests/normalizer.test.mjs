// Run with: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isMatch, Modes } from "../js/normalizer.js";

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
