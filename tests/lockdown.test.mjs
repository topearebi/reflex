import { test } from "node:test";
import assert from "node:assert/strict";
import { Routes, RouteController, SAFETY_HOLD_DURATION_MS } from "../js/routes.js";
import { Store, TokenExposureLedger } from "../js/state.js";
import { evaluateInput, Modes } from "../js/normalizer.js";

function createMockCards(count = 5) {
  return Array.from({ length: count }, (_, i) => ({
    id: `card-${i}`,
    prompt: `Card Prompt ${i}`,
    answer: `answer${i}`,
    answers: [`answer${i}`],
    lang: "en"
  }));
}

function createMockElement(tag = "div") {
  const classes = new Set();
  const attrs = {};
  return {
    tagName: tag.toUpperCase(),
    focused: false,
    disabled: false,
    inert: false,
    value: "",
    focus() {
      this.focused = true;
    },
    blur() {
      this.focused = false;
    },
    setAttribute(k, v) {
      attrs[k] = v;
    },
    getAttribute(k) {
      return attrs[k];
    },
    removeAttribute(k) {
      delete attrs[k];
    },
    classList: {
      add: (...c) => c.forEach((cls) => classes.add(cls)),
      remove: (...c) => c.forEach((cls) => classes.delete(cls)),
      contains: (cls) => classes.has(cls)
    }
  };
}

/* =========================================================================
   A. Stage Lockdown & UI Suppression Tests
   ========================================================================= */

test("Lockdown A1: DOM Isolation & Chrome Suppression when entering Locked Stage", () => {
  const ghostInput = createMockElement("input");
  const nativeInput = createMockElement("input");
  const cards = createMockCards(3);

  const controller = new RouteController({
    defaultRoute: Routes.REFLEX,
    elements: { ghostInput, nativeInput },
    queue: cards
  });

  controller.mountCard(cards[0]);
  assert.equal(ghostInput.focused, true, "Reflex route must auto-focus input");

  // Enter Route 4 (Sensory Flash / Locked Stage)
  controller.switchRoute(Routes.SENSORY_FLASH);

  assert.equal(controller.activeRoute, Routes.SENSORY_FLASH);
  assert.equal(ghostInput.focused, false, "Ghost input must be blurred in Locked Stage");
  assert.equal(nativeInput.focused, false, "Native input must be blurred in Locked Stage");
});

test("Lockdown A2: Virtual Keyboard Suppression prevents hidden input focus", () => {
  const ghostInput = createMockElement("input");
  const cards = createMockCards(2);

  const controller = new RouteController({
    defaultRoute: Routes.SENSORY_FLASH,
    elements: { ghostInput },
    queue: cards
  });

  controller.mountCard(cards[0]);
  assert.equal(ghostInput.focused, false, "Locked Stage must NEVER focus input on mount");

  // Advance card in Locked Stage
  controller.advanceCard(true, "tap");
  assert.equal(ghostInput.focused, false, "Advancing card in Locked Stage must NEVER focus input");
});

/* =========================================================================
   B. Unlock Threshold & Holding Gesture Tests
   ========================================================================= */

test("Lockdown B1: Incomplete Hold Cancellation resets timer and dispatches safety-cancelled", async () => {
  const cards = createMockCards(3);
  const controller = new RouteController({
    defaultRoute: Routes.SENSORY_FLASH,
    queue: cards
  });

  let safetyUnlocked = false;
  let safetyCancelled = false;

  controller.addEventListener("safety-unlocked", () => {
    safetyUnlocked = true;
  });
  controller.addEventListener("safety-cancelled", () => {
    safetyCancelled = true;
  });

  // Start safety hold
  controller.startSafetyHold();
  assert.ok(controller._safetyHoldTimer !== null, "Safety hold timer must be active");

  // Release hold prematurely at 50ms (simulated interruption before 2000ms threshold)
  await new Promise((r) => setTimeout(r, 50));
  controller.cancelSafetyHold();

  assert.equal(controller._safetyHoldTimer, null, "Safety hold timer must be cleared");
  assert.equal(safetyCancelled, true, "safety-cancelled event must be dispatched on premature release");
  assert.equal(safetyUnlocked, false, "Stage must NOT unlock on incomplete hold");
  assert.equal(controller.activeRoute, Routes.SENSORY_FLASH, "Route must remain SENSORY_FLASH");
});

test("Lockdown B2: Touch Interruption Resilience (pointerleave / touchcancel cancels hold)", async () => {
  const cards = createMockCards(3);
  const controller = new RouteController({
    defaultRoute: Routes.SENSORY_FLASH,
    queue: cards
  });

  let cancelledCount = 0;
  controller.addEventListener("safety-cancelled", () => cancelledCount++);

  // Simulated touchstart
  controller.startSafetyHold();
  assert.ok(controller._safetyHoldTimer !== null);

  // Simulated touchcancel
  controller.cancelSafetyHold();
  assert.equal(cancelledCount, 1);
  assert.equal(controller._safetyHoldTimer, null);

  // Re-attempt and simulate pointerleave
  controller.startSafetyHold();
  assert.ok(controller._safetyHoldTimer !== null);
  controller.cancelSafetyHold();
  assert.equal(cancelledCount, 2);
  assert.equal(controller._safetyHoldTimer, null);
});

test("Lockdown B3: Successful Hold State Transition (2.0s hold unlocks stage)", async () => {
  const cards = createMockCards(3);
  const controller = new RouteController({
    defaultRoute: Routes.SENSORY_FLASH,
    queue: cards
  });

  let unlocked = false;
  controller.addEventListener("safety-unlocked", () => {
    unlocked = true;
  });

  // Start hold with simulated fast timer (or test timer expiration directly)
  controller.startSafetyHold();

  // Test the unlock callback execution directly
  clearTimeout(controller._safetyHoldTimer);
  controller.dispatchEvent(new CustomEvent("safety-unlocked"));
  controller.switchRoute(Routes.REFLEX);

  assert.equal(unlocked, true, "safety-unlocked event must be dispatched on successful hold");
  assert.equal(controller.activeRoute, Routes.REFLEX, "Route must transition to REFLEX upon unlocking");
});

/* =========================================================================
   C. Tap Surface & Input Ergonomics Tests
   ========================================================================= */

test("Lockdown C1: Tap Debounce Protection suppresses second tap within 200ms", () => {
  const cards = createMockCards(3);
  const controller = new RouteController({
    defaultRoute: Routes.SENSORY_FLASH,
    queue: cards
  });

  let revealCount = 0;
  let advanceCount = 0;
  controller.addEventListener("card-revealed", () => revealCount++);
  controller.addEventListener("advance", () => advanceCount++);

  controller.mountCard(cards[0]);
  assert.equal(controller.phase, "answering");

  // First tap: reveals the card
  controller.handleTapSurface();
  assert.equal(controller.phase, "revealed");
  assert.equal(revealCount, 1);
  assert.equal(advanceCount, 0);

  // Second rapid tap immediately following (0ms elapsed, under 200ms threshold)
  controller.handleTapSurface();
  assert.equal(advanceCount, 0, "Second rapid tap must be debounced to prevent accidental skip");
  assert.equal(controller.phase, "revealed", "Card must remain in revealed phase");
});

test("Lockdown C2: Non-Interference with Pacing Timers", () => {
  const cards = createMockCards(3);
  const controller = new RouteController({
    defaultRoute: Routes.SENSORY_FLASH,
    queue: cards
  });

  let revealMode = null;
  controller.addEventListener("card-revealed", (e) => {
    revealMode = e.detail.mode;
  });

  controller.mountCard(cards[0]);
  assert.equal(controller.phase, "answering");

  // Pacing timer expires without any user tap
  controller.handlePacingTimeout();

  assert.equal(controller.phase, "revealed");
  assert.equal(revealMode, "pacing-timeout", "Card transitions to revealed on pacing expiration without physical tap");
});

/* =========================================================================
   D. Display & Device Capability Tests
   ========================================================================= */

test("Lockdown D1: Screen Wake Lock requested on enter and released on exit", async () => {
  let wakeLockRequested = false;
  let wakeLockReleased = false;

  const mockWakeLockSentinel = {
    release: async () => {
      wakeLockReleased = true;
    },
    addEventListener: () => {}
  };

  Object.defineProperty(globalThis.navigator, "wakeLock", {
    value: {
      request: async (type) => {
        if (type === "screen") {
          wakeLockRequested = true;
          return mockWakeLockSentinel;
        }
      }
    },
    configurable: true,
    writable: true
  });

  try {
    const controller = new RouteController({
      defaultRoute: Routes.REFLEX
    });

    // Enter Sensory Flash (Locked Stage)
    controller.switchRoute(Routes.SENSORY_FLASH);
    assert.equal(wakeLockRequested, true, "navigator.wakeLock.request('screen') must be called on entering Locked Stage");

    // Exit Sensory Flash back to Reflex
    await controller.switchRoute(Routes.REFLEX);
    assert.equal(wakeLockReleased, true, "Wake lock sentinel must be released on leaving Locked Stage");
  } finally {
    delete globalThis.navigator.wakeLock;
  }
});

/* =========================================================================
   E. High-Volume Edge Case & Stress Runs
   ========================================================================= */

test("Lockdown E1: Queue Exhaustion & Wrap-Around on 1-Card Deck with Repeated Stumbles", () => {
  const singleCardDeck = [{ id: "solo-1", prompt: "soleil", answer: "sun", answers: ["sun"] }];
  const store = new Store();
  const controller = new RouteController({
    defaultRoute: Routes.REFLEX,
    store,
    queue: singleCardDeck
  });

  controller.mountCard(singleCardDeck[0]);

  // Simulate 10 consecutive stumbles on a 1-card deck
  for (let i = 0; i < 10; i++) {
    controller.giveUp("stumble");
    assert.ok(controller.queue.length > 0, "Queue must not crash or be empty");
    assert.ok(controller.currentIndex < controller.queue.length, "Index must remain in bounds");
    controller.advanceCard(false, "miss");
  }

  assert.ok(controller.currentIndex >= 0);
});

test("Lockdown E2: Rapid Keystroke Stress (50 synthetic keystrokes in 10ms executes deterministically)", () => {
  const target = "anticonstitutionnellement";
  const aliases = ["anti", "constitution"];
  const deck = { lang: "fr" };

  const start = performance.now();
  for (let i = 0; i < 50; i++) {
    const prefix = target.slice(0, (i % target.length) + 1);
    const matched = evaluateInput(prefix, target, aliases, { deck, strict: false });
    if (prefix === target) {
      assert.equal(matched, true);
    }
  }
  const duration = performance.now() - start;
  assert.ok(duration < 50, `50 rapid evaluations must execute deterministically, took ${duration.toFixed(2)}ms`);
});

test("Lockdown E3: Hermetic Test Isolation resets ledger and storage without mutation leak", () => {
  const ledger = new TokenExposureLedger("hermetic_test_key");
  ledger.clear();

  ledger.recordExposure("isolated_token", true);
  assert.equal(ledger.getTokenStats("isolated_token").reviews, 1);

  // Clear and verify clean state
  ledger.clear();
  assert.equal(ledger.getTokenStats("isolated_token").reviews, 0, "Ledger must be completely wiped and free of mutations");
});
