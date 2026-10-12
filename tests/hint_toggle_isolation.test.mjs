// Comprehensive automated tests for Hint Toggle isolation
// Verifies that toggling hints/subtitles:
// 1. Strictly toggles subtitle visibility without altering front/back field roles or flipping prompt/answers
// 2. Preserves typed input and does not emit card reset events
// 3. Functions identically with swapped fields (Target <-> Native)
// 4. Maintains cloze mode sentence slots and missing blanks without interference
// 5. Preserves reverse card orientation and answering/correcting engine phases

import { test } from "node:test";
import assert from "node:assert/strict";
import { adaptCardRoles, RecallEngine } from "../js/engine.js";
import { Store } from "../js/state.js";
import { expandClozeCard } from "../js/cloze.js";

// Helper mock storage to simulate localStorage in tests
function createMockStorage() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    clear: () => { Object.keys(data).forEach((k) => delete data[k]); }
  };
}

globalThis.localStorage = createMockStorage();

test("adaptCardRoles idempotency: repeatedly toggling hints never flips prompt or answer", () => {
  const card = {
    id: "vocab-1",
    prompt: "bonjour",
    answers: ["hello"],
    subtitle: "greeting"
  };

  // 1. Normal forward orientation (Target on front, Native on back)
  let adapted = adaptCardRoles(card, "prompt", "answer", true);
  assert.equal(adapted.prompt, "bonjour");
  assert.deepEqual(adapted.answers, ["hello"]);
  assert.equal(adapted.subtitle, "greeting");

  // Toggle hints off
  adapted = adaptCardRoles(adapted, "prompt", "answer", false);
  assert.equal(adapted.prompt, "bonjour", "Prompt must remain untouched when hint is turned off");
  assert.deepEqual(adapted.answers, ["hello"], "Answer must remain untouched when hint is turned off");
  assert.equal(adapted.subtitle, "", "Subtitle must be empty when hint is off");

  // Toggle hints on again
  adapted = adaptCardRoles(adapted, "prompt", "answer", true);
  assert.equal(adapted.prompt, "bonjour", "Prompt must not flip after toggling hint back on");
  assert.deepEqual(adapted.answers, ["hello"], "Answer must not flip after toggling hint back on");
  assert.equal(adapted.subtitle, "greeting", "Canonical subtitle must be restored");

  // 10 consecutive toggles
  for (let i = 0; i < 10; i++) {
    const show = i % 2 === 0;
    adapted = adaptCardRoles(adapted, "prompt", "answer", show);
    assert.equal(adapted.prompt, "bonjour", `Prompt flipped on toggle iteration ${i}`);
    assert.deepEqual(adapted.answers, ["hello"], `Answer flipped on toggle iteration ${i}`);
    assert.equal(adapted.subtitle, show ? "greeting" : "");
  }
});

test("adaptCardRoles with swapped fields: toggling hints never reverses the swapped roles", () => {
  const card = {
    id: "zh-101",
    prompt: "你好",
    answers: ["hello"],
    subtitle: "nǐ hǎo"
  };

  // Swapped fields: Native (answer) on Front, Target (prompt) on Back
  let swapped = adaptCardRoles(card, "answer", "prompt", true);
  assert.equal(swapped.prompt, "hello", "Front must be Native language");
  assert.deepEqual(swapped.answers, ["你好"], "Back must be Target language");
  assert.equal(swapped.subtitle, "nǐ hǎo", "Hint is the romanization");

  // Turn off hint
  swapped = adaptCardRoles(swapped, "answer", "prompt", false);
  assert.equal(swapped.prompt, "hello", "Front must NOT flip back to Target when hint is hidden");
  assert.deepEqual(swapped.answers, ["你好"], "Back must NOT flip back to Native when hint is hidden");
  assert.equal(swapped.subtitle, "");

  // Turn on hint again
  swapped = adaptCardRoles(swapped, "answer", "prompt", true);
  assert.equal(swapped.prompt, "hello", "Front must still be Native");
  assert.deepEqual(swapped.answers, ["你好"], "Back must still be Target");
  assert.equal(swapped.subtitle, "nǐ hǎo", "Romanization hint restored");

  // Multi-toggle test
  for (let i = 0; i < 6; i++) {
    const show = i % 2 === 1;
    swapped = adaptCardRoles(swapped, "answer", "prompt", show);
    assert.equal(swapped.prompt, "hello", `Prompt changed on iteration ${i}`);
    assert.deepEqual(swapped.answers, ["你好"], `Answer changed on iteration ${i}`);
  }
});

test("Cloze mode: toggling hints preserves sentence text, cloze slot, and answers", () => {
  const rawCloze = {
    id: "cloze-demo-1",
    prompt: "Je {{suis}} fatigué.",
    subtitle: "I am tired",
    isCloze: true
  };

  const expanded = expandClozeCard(rawCloze);
  assert.equal(expanded.length, 1);
  const card = expanded[0];

  assert.equal(card.prompt, "Je {{suis}} fatigué.");
  assert.deepEqual(card.answers, ["suis"]);
  assert.equal(card.clozeData.prefix, "Je ");
  assert.equal(card.clozeData.suffix, " fatigué.");

  // Toggle hints off
  let clozeWithNoHint = adaptCardRoles(card, "prompt", "answer", false);
  assert.equal(clozeWithNoHint.prompt, "Je {{suis}} fatigué.");
  assert.deepEqual(clozeWithNoHint.answers, ["suis"]);
  assert.equal(clozeWithNoHint.clozeData.prefix, "Je ");
  assert.equal(clozeWithNoHint.clozeData.suffix, " fatigué.");
  assert.equal(clozeWithNoHint.subtitle, "");

  // Toggle hints on
  let clozeWithHint = adaptCardRoles(clozeWithNoHint, "prompt", "answer", true);
  assert.equal(clozeWithHint.prompt, "Je {{suis}} fatigué.");
  assert.deepEqual(clozeWithHint.answers, ["suis"]);
  assert.equal(clozeWithHint.clozeData.prefix, "Je ");
  assert.equal(clozeWithHint.clozeData.suffix, " fatigué.");
  assert.equal(clozeWithHint.subtitle, "I am tired");
});

test("Reverse card objects: retain reverse direction during hint toggles", () => {
  const reverseCard = {
    id: "rev-1",
    prompt: "thank you",
    answers: ["merci"],
    subtitle: "polite expression",
    isReversed: true
  };

  // Even if adaptCardRoles is called with standard prompt/answer or swapped
  const toggledOff = adaptCardRoles(reverseCard, "prompt", "answer", false);
  assert.equal(toggledOff.prompt, "thank you");
  assert.deepEqual(toggledOff.answers, ["merci"]);
  assert.equal(toggledOff.subtitle, "");

  const toggledOn = adaptCardRoles(toggledOff, "prompt", "answer", true);
  assert.equal(toggledOn.prompt, "thank you");
  assert.deepEqual(toggledOn.answers, ["merci"]);
  assert.equal(toggledOn.subtitle, "polite expression");
});

test("RecallEngine: hints-changed event updates subtitle without emitting card reset or altering active card", () => {
  const store = new Store();
  const testDeck = {
    id: "test-deck-1",
    name: "Test Deck",
    cards: [
      { id: "c1", prompt: "Target Word", answers: ["Native Meaning"], subtitle: "Helpful Hint", group: "G1", unit: "U1" }
    ]
  };

  store.builtIn[testDeck.id] = testDeck;
  store.setDeck("test-deck-1");
  store.setUnits(["G1::U1"]);

  const engine = new RecallEngine(store);
  engine.next();

  assert.ok(engine.card, "Engine must have picked a card");
  const originalPrompt = engine.card.prompt;
  const originalAnswer = engine.card.answers[0];

  let cardEventCount = 0;
  let hintEventCount = 0;
  engine.addEventListener("card", () => { cardEventCount++; });
  engine.addEventListener("hint", () => { hintEventCount++; });

  // Simulate user mid-typing: toggle hints
  store.toggleHints();

  assert.equal(cardEventCount, 0, "Engine must NOT emit 'card' event on hint toggle (which would wipe typed input)");
  assert.equal(hintEventCount, 1, "Engine must emit 'hint' event");
  assert.equal(engine.card.prompt, originalPrompt, "Card prompt must remain identical");
  assert.deepEqual(engine.card.answers[0], originalAnswer, "Card answer must remain identical");
  assert.equal(engine.phase, "answering", "Engine phase must remain 'answering'");

  // Toggle hints back
  store.toggleHints();
  assert.equal(cardEventCount, 0, "Still no card reset event");
  assert.equal(hintEventCount, 2);
  assert.equal(engine.card.prompt, originalPrompt);
  assert.deepEqual(engine.card.answers[0], originalAnswer);
});

test("Mid-typing and correcting phase preservation during hint toggle", () => {
  const store = new Store();
  const testDeck = {
    id: "test-deck-2",
    name: "Test Deck 2",
    cards: [
      { id: "c2", prompt: "eau", answers: ["water"], subtitle: "noun", group: "G1", unit: "U1" }
    ]
  };

  store.builtIn[testDeck.id] = testDeck;
  store.setDeck("test-deck-2");
  store.setUnits(["G1::U1"]);

  const engine = new RecallEngine(store);
  engine.next();

  // User makes a miss and enters 'correcting' phase
  engine.giveUp("juice");
  assert.equal(engine.phase, "correcting", "Engine should be in correcting phase");

  // User toggles hints while in correcting phase
  store.toggleHints();

  // Engine must stay in 'correcting' phase, NOT revert or reset
  assert.equal(engine.phase, "correcting", "Engine must remain in correcting phase after hint toggle");
  assert.equal(engine.card.prompt, "eau");
  assert.deepEqual(engine.card.answers, ["water"]);
});

test("Independent controls: swapping fields vs toggling hints", () => {
  const store = new Store();
  const testDeck = {
    id: "test-deck-3",
    name: "Test Deck 3",
    cards: [
      { id: "c3", prompt: "chat", answers: ["cat"], subtitle: "feline", group: "G1", unit: "U1" }
    ]
  };

  store.builtIn[testDeck.id] = testDeck;
  store.setDeck("test-deck-3");
  store.setUnits(["G1::U1"]);

  const engine = new RecallEngine(store);
  engine.next();

  // Initial: Target (chat) -> Native (cat)
  assert.equal(engine.card.prompt, "chat");
  assert.deepEqual(engine.card.answers, ["cat"]);

  // Swap fields deliberately
  store.swapDeckFields();
  // swapDeckFields dispatches fields-changed, which calls engine.next()
  assert.equal(engine.card.prompt, "cat", "Deliberate swap sets Native on front");
  assert.deepEqual(engine.card.answers, ["chat"], "Deliberate swap sets Target on back");

  // Now toggle hints multiple times
  store.setShowHints(false);
  assert.equal(engine.card.prompt, "cat", "Hint toggle does not undo swap");
  assert.deepEqual(engine.card.answers, ["chat"], "Hint toggle does not undo swap");
  assert.equal(engine.card.subtitle, "");

  store.setShowHints(true);
  assert.equal(engine.card.prompt, "cat", "Hint toggle does not undo swap");
  assert.deepEqual(engine.card.answers, ["chat"], "Hint toggle does not undo swap");
  assert.equal(engine.card.subtitle, "feline", "Hint is feline");
});
