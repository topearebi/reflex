import { test } from "node:test";
import assert from "node:assert/strict";
import { Routes, RouteController, ROUTE_LABELS, isNativeTypingCompatible, routesForDeck } from "../js/routes.js";
import { Store } from "../js/state.js";
import { generateCloze } from "../js/cloze.js";

function createMockCards(count = 8) {
  return Array.from({ length: count }, (_, i) => ({
    id: `card-${i}`,
    prompt: `Prompt ${i}`,
    answer: `answer${i}`,
    answers: [`answer${i}`],
    script: `漢字${i}`,
    subtitle: `Hint ${i}`,
    group: "General",
    unit: "Unit 1"
  }));
}

// Mock Audio
class MockAudio {
  constructor() {
    this.stopped = false;
    this.history = [];
    this.played = [];
  }
  stopAll() {
    this.stopped = true;
    this.history.push("stop");
  }
  playCurrent(card) {
    this.stopped = false;
    this.history.push(`play-${card?.id}`);
    if (card?.id) this.played.push(card.id);
    return Promise.resolve({ status: "finished" });
  }
  preloadQueue() {}
  retainStumbled() {}
  clearStumbled() {}
}

// Mock Input Element
function createMockInput() {
  return {
    focused: false,
    blurred: false,
    value: "",
    focus() {
      this.focused = true;
      this.blurred = false;
    },
    blur() {
      this.focused = false;
      this.blurred = true;
    }
  };
}

/* =========================================================================
   A. Lifecycle & Route Switching Tests
   ========================================================================= */

test("A1. Clean Unmount & Teardown: navigating away from Route 1/2 blurs active inputs for Route 4", () => {
  const ghostInput = createMockInput();
  const mockAudio = new MockAudio();
  const cards = createMockCards(5);

  const controller = new RouteController({
    defaultRoute: Routes.REFLEX,
    audio: mockAudio,
    elements: { ghostInput },
    queue: cards
  });

  controller.mountCard(cards[0]);
  assert.equal(ghostInput.focused, true, "Ghost input must be auto-focused in Route 1");

  // Switch to Route 4 (Kid / Sensory Flash)
  controller.switchRoute(Routes.SENSORY_FLASH);

  assert.equal(ghostInput.blurred, true, "Active input elements must be blurred when entering Route 4");
  assert.equal(controller.activeRoute, Routes.SENSORY_FLASH);
});

test("A2. Timer Cancellation on Transition: skipping card in Route 4 cancels pacing timer and audio", async () => {
  const mockAudio = new MockAudio();
  const cards = createMockCards(5);

  const controller = new RouteController({
    defaultRoute: Routes.SENSORY_FLASH,
    audio: mockAudio,
    queue: cards
  });

  controller.mountCard(cards[0]);
  const timerCard0 = controller._pacingTimer;
  assert.ok(timerCard0 !== null, "Pacing timer must be active for card 0");
  assert.deepEqual(mockAudio.history, ["play-card-0"]);

  // Rapidly advance / skip to next card before pacing timer completes
  controller.advanceCard(true, "tap");

  // Assert stopAll was executed on card-0 transition
  assert.ok(mockAudio.history.includes("stop"), "Active audio buffers must be terminated on transition");
  assert.equal(mockAudio.history[1], "stop", "Stop must precede next card playback");
  assert.notEqual(controller._pacingTimer, timerCard0, "Previous card pacing timer must be cancelled and replaced");
});


test("A3. Focus Restoration: switching from Route 4 back to Route 1 immediately re-focuses ghost input", () => {
  const ghostInput = createMockInput();
  const cards = createMockCards(5);

  const controller = new RouteController({
    defaultRoute: Routes.SENSORY_FLASH,
    elements: { ghostInput },
    queue: cards
  });

  controller.mountCard(cards[0]);
  assert.equal(ghostInput.focused, false, "Input must not be focused in Route 4");

  // Switch back to Route 1
  controller.switchRoute(Routes.REFLEX);

  assert.equal(controller.activeRoute, Routes.REFLEX);
  assert.equal(ghostInput.focused, true, "Ghost input must be immediately re-focused without screen click");
});

/* =========================================================================
   B. Input Modality & IME Handling Tests
   ========================================================================= */

test("B1. IME Composition Shielding: compositionstart prevents auto-advance until compositionend", () => {
  const cards = [{ id: "c1", prompt: "猫", answer: "cat", answers: ["cat"] }];
  let advanceCount = 0;

  const controller = new RouteController({
    defaultRoute: Routes.REFLEX,
    queue: cards
  });

  controller.addEventListener("advance", () => advanceCount++);
  controller.mountCard(cards[0]);

  // Dispatch compositionstart (user typing in IME)
  controller.handleCompositionStart({ type: "compositionstart" });
  assert.equal(controller.isComposing, true);

  // User input matching target during active composition
  controller.handleInput("cat");
  assert.equal(advanceCount, 0, "Must NOT auto-advance while composition is in flight");

  // Composition update
  controller.handleCompositionUpdate({ type: "compositionupdate", data: "cat" });
  controller.handleInput("cat");
  assert.equal(advanceCount, 0, "Must NOT auto-advance during compositionupdate");

  // Composition end
  controller.handleCompositionEnd({ type: "compositionend", data: "cat" });
  assert.equal(controller.isComposing, false);

  // Once composition ends, input evaluation advances
  controller.handleInput("cat");
  assert.equal(advanceCount, 1, "Must advance after compositionend is finalized");
});

test("B2. Explicit Submission in Route 5: matching script does NOT advance until explicit Enter keydown", () => {
  const cards = [{ id: "c1", prompt: "dog", script: "犬", answer: "犬", answers: ["犬"] }];
  let advanceCount = 0;

  const controller = new RouteController({
    defaultRoute: Routes.STRICT_PRODUCTION,
    queue: cards
  });

  controller.addEventListener("advance", () => advanceCount++);
  controller.mountCard(cards[0]);

  // Type exact matching script string without Enter
  controller.handleInput("犬");
  assert.equal(advanceCount, 0, "Route 5 must NOT advance on raw input event");

  // Press arbitrary non-Enter key
  controller.handleKeyDown({ key: "a", value: "犬" });
  assert.equal(advanceCount, 0, "Route 5 must NOT advance on non-Enter key");

  // Press Enter key to submit
  controller.handleKeyDown({ key: "Enter", value: "犬" });
  assert.equal(advanceCount, 1, "Route 5 must advance on explicit Enter keydown");
});

test("B3. Instant Advance in Route 1 & 2: typing final character advances synchronously without Enter", () => {
  const cards = [
    { id: "c1", prompt: "sun", answer: "soleil", answers: ["soleil"] },
    { id: "c2", prompt: "The {{c1::quick}} brown fox", answer: "quick", answers: ["quick"] }
  ];

  // Route 1 test
  let advanceCountR1 = 0;
  const ctrl1 = new RouteController({ defaultRoute: Routes.REFLEX, queue: [cards[0]] });
  ctrl1.addEventListener("advance", () => advanceCountR1++);
  ctrl1.mountCard(cards[0]);

  ctrl1.handleInput("solei");
  assert.equal(advanceCountR1, 0);
  ctrl1.handleInput("soleil"); // Final char typed
  assert.equal(advanceCountR1, 1, "Route 1 must advance synchronously without Enter");

  // Route 2 test
  let advanceCountR2 = 0;
  const ctrl2 = new RouteController({ defaultRoute: Routes.CONTEXT_CLOZE, queue: [cards[1]] });
  ctrl2.addEventListener("advance", () => advanceCountR2++);
  ctrl2.mountCard(cards[1]);

  ctrl2.handleInput("quic");
  assert.equal(advanceCountR2, 0);
  ctrl2.handleInput("quick"); // Final char typed
  assert.equal(advanceCountR2, 1, "Route 2 must advance synchronously without Enter");
});

/* =========================================================================
   C. Staging & Inline Cloze Integrity Tests
   ========================================================================= */

test("C1. Dynamic Hole Alignment: inline input occupies exact array position of target token in sentence stream", () => {
  const sentence = "She decided to study Spanish before traveling";
  // Target "study" is index 3 in ["She", "decided", "to", "study", "Spanish", "before", "traveling"]
  const cloze = generateCloze(sentence, { target: "study" });

  assert.equal(cloze.target, "study");
  assert.equal(cloze.targetIndex, 3);
  assert.equal(cloze.tokens[3].text, "study");
  assert.equal(cloze.tokens[3].isTarget, true);
  assert.equal(cloze.tokens[0].isTarget, false);
  assert.equal(cloze.tokens[1].isTarget, false);
  assert.equal(cloze.tokens[2].isTarget, false);
  assert.equal(cloze.tokens[4].isTarget, false);
});

test("C2. Whitespace Integrity in Surrounding Context: Chinese preserves native collapsed spacing, Latin preserves spaces", () => {
  // Latin / French sentence: segmented view mode
  const latinSentence = "Le soleil brille toujours";
  const clozeLatin = generateCloze(latinSentence, { target: "soleil" });
  assert.equal(clozeLatin.viewMode, "segmented", "Latin sentence must use segmented spacing");

  // Chinese sentence: native view mode (unbroken characters, collapsed spacing)
  const cjkSentence = "今天天气很好";
  const clozeCjk = generateCloze(cjkSentence, { target: "天气" });
  assert.equal(clozeCjk.viewMode, "native", "Chinese sentence must preserve native collapsed script spacing");
});

/* =========================================================================
   D. Queue Management & Failure Routing Tests
   ========================================================================= */

test("D1. Reflex Stumble Re-insertion: incorrect input or timeout in Route 1 splices failed card 3 to 4 positions ahead", () => {
  const cards = createMockCards(8);
  const controller = new RouteController({
    defaultRoute: Routes.REFLEX,
    queue: cards
  });

  // Mount card-0 at index 0
  controller.mountCard(cards[0]);

  // Simulate stumble / hesitation timeout on card-0
  controller.giveUp("hesitation-timeout");

  const queue = controller.getQueue();
  // Queue had 8 cards [card-0, card-1, card-2, card-3, card-4, card-5, card-6, card-7]
  // card-0 was spliced 3 positions ahead of currentIndex (0 + 3 = index 3)
  assert.equal(queue[3].id, "card-0", "Failed card must be spliced exactly 3 slots ahead in review queue");
  assert.equal(queue[3]._stumbled, true);
});

test("D2. Sensory Stage Pacing Expiration: timer hitting zero transitions prompt to reveal without unhandled rejection", async () => {
  const cards = createMockCards(3);
  const mockAudio = new MockAudio();

  const controller = new RouteController({
    defaultRoute: Routes.SENSORY_FLASH,
    audio: mockAudio,
    queue: cards
  });

  let revealedMode = null;
  controller.addEventListener("card-revealed", (e) => {
    revealedMode = e.detail.mode;
  });

  controller.mountCard(cards[0]);
  assert.equal(controller.phase, "answering");

  // Trigger pacing timeout directly
  controller.handlePacingTimeout();

  assert.equal(controller.phase, "revealed");
  assert.equal(revealedMode, "pacing-timeout");
  assert.equal(mockAudio.played.includes("card-0"), true, "Audio should replay softly on reveal");
});

/* =========================================================================
   E. Pedagogical Mode Humanization & Deck Compatibility Tests
   ========================================================================= */

test("E1. Humanized Route Identifiers: user-facing labels eliminate developer jargon", () => {
  assert.equal(ROUTE_LABELS[Routes.REFLEX], "Speed Sprint");
  assert.equal(ROUTE_LABELS[Routes.CONTEXT_CLOZE], "Sentence Cloze");
  assert.equal(ROUTE_LABELS[Routes.VARIABLE_CLOZE], "Grammar Gym");
  assert.equal(ROUTE_LABELS[Routes.SENSORY_FLASH], "Audio Flashcards");
  assert.equal(ROUTE_LABELS[Routes.STRICT_PRODUCTION], "Native Typing");
});

test("E2. Deck Archetype Compatibility: identifies decks requiring / supporting Native Typing (IME)", () => {
  // Non-Latin / Ideographic / Pinyin decks -> Compatible
  assert.equal(isNativeTypingCompatible({ lang: "zh", romanization: "pinyin" }), true, "Chinese HSK should support Native Typing");
  assert.equal(isNativeTypingCompatible({ lang: "ja", name: "Japanese" }), true, "Japanese Kana/Kanji should support Native Typing");
  assert.equal(isNativeTypingCompatible({ lang: "ko" }), true, "Korean Hangul should support Native Typing");
  assert.equal(isNativeTypingCompatible({ lang: "ar" }), true, "Arabic should support Native Typing");
  assert.equal(isNativeTypingCompatible({ lang: "ru" }), true, "Russian Cyrillic should support Native Typing");
  assert.equal(isNativeTypingCompatible({ cards: [{ script: "漢字" }] }), true, "Deck with script cards should support Native Typing");

  // Latin / Romanized decks -> Incompatible (no OS composition buffer needed)
  assert.equal(isNativeTypingCompatible({ lang: "fr", name: "French Verbs" }), false, "French must NOT allow Native Typing (IME)");
  assert.equal(isNativeTypingCompatible({ lang: "yo", name: "Yoruba Core" }), false, "Yoruba must NOT allow Native Typing (IME)");
  assert.equal(isNativeTypingCompatible({ lang: "es", name: "Spanish" }), false, "Spanish must NOT allow Native Typing (IME)");
  assert.equal(isNativeTypingCompatible({ lang: "en", name: "English" }), false, "English must NOT allow Native Typing (IME)");
  assert.equal(isNativeTypingCompatible(null), false);
});

test("E3. Mode Selection Constraint: routesForDeck constrains available options by deck archetype", () => {
  const frenchDeck = { lang: "fr", name: "French Top 500" };
  const frenchRoutes = routesForDeck(frenchDeck);
  assert.equal(frenchRoutes.length, 4, "Latin decks must have exactly 4 routes (excluding Native Typing)");
  assert.ok(!frenchRoutes.some((r) => r.value === Routes.STRICT_PRODUCTION), "French deck must exclude Native Typing");
  assert.deepEqual(
    frenchRoutes.map((r) => r.label),
    ["Speed Sprint", "Sentence Cloze", "Grammar Gym", "Audio Flashcards"]
  );

  const chineseDeck = { lang: "zh", romanization: "pinyin", name: "Chinese HSK 1" };
  const chineseRoutes = routesForDeck(chineseDeck);
  assert.equal(chineseRoutes.length, 5, "Chinese deck must have all 5 routes");
  assert.ok(chineseRoutes.some((r) => r.value === Routes.STRICT_PRODUCTION), "Chinese deck must include Native Typing");
  assert.deepEqual(
    chineseRoutes.map((r) => r.label),
    ["Speed Sprint", "Sentence Cloze", "Grammar Gym", "Audio Flashcards", "Native Typing"]
  );
});

test("E4. Incompatible Route Switching Resilience: fallback to Speed Sprint on Latin deck selection", async () => {
  const cards = createMockCards(3);
  const controller = new RouteController({
    defaultRoute: Routes.STRICT_PRODUCTION,
    queue: cards
  });

  assert.equal(controller.activeRoute, Routes.STRICT_PRODUCTION);

  // Simulate user switching to French deck while in Strict Production mode
  const latinDeck = { lang: "fr", name: "French" };
  if (!isNativeTypingCompatible(latinDeck) && controller.activeRoute === Routes.STRICT_PRODUCTION) {
    await controller.switchRoute(Routes.REFLEX);
  }

  assert.equal(controller.activeRoute, Routes.REFLEX, "Active route must fall back to Speed Sprint");
});
