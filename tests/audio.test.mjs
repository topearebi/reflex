import { test } from "node:test";
import assert from "node:assert/strict";
import { AudioController } from "../js/audio.js";

// Helper to create mock cards
function createMockCards(count = 10) {
  return Array.from({ length: count }, (_, i) => ({
    id: `card-${i}`,
    prompt: `Word ${i}`,
    answer: `answer ${i}`,
    audio: `https://example.com/audio-${i}.mp3`
  }));
}

// Mock Web Audio Context
class MockAudioContext {
  constructor(initialState = "suspended") {
    this.state = initialState;
    this.destination = {};
  }

  async resume() {
    this.state = "running";
    return undefined;
  }

  createBufferSource() {
    const source = {
      buffer: null,
      connect() {},
      disconnect() {},
      start() {},
      stop() {
        if (typeof this.onended === "function") {
          this.onended();
        }
      },
      onended: null
    };
    return source;
  }
}

test("audio.js: lookahead queue accuracy loads exactly cards N+1, N+2, and N+3", async () => {
  const cards = createMockCards(10);
  const mockFetchAudio = async (card) => ({ id: card.id, duration: 1.0 });

  const controller = new AudioController({
    audioContext: new MockAudioContext("running"),
    fetchAudio: mockFetchAudio,
    autoUnlock: false
  });

  // Mount card index 2 (card-2)
  await controller.preloadQueue(cards, 2);

  // Lookahead queue should contain exactly card-3, card-4, card-5
  const lookahead = controller.getLookaheadQueue();
  assert.deepEqual(lookahead, ["card-3", "card-4", "card-5"]);

  assert.ok(controller.isBuffered("card-3"));
  assert.ok(controller.isBuffered("card-4"));
  assert.ok(controller.isBuffered("card-5"));
  assert.ok(!controller.isBuffered("card-6"));
  assert.ok(!controller.isBuffered("card-1"));

  // Now advance to card index 3 (card-3)
  await controller.preloadQueue(cards, 3);
  assert.deepEqual(controller.getLookaheadQueue(), ["card-4", "card-5", "card-6"]);
  assert.ok(controller.isBuffered("card-4"));
  assert.ok(controller.isBuffered("card-5"));
  assert.ok(controller.isBuffered("card-6"));
  // card-2 should be evicted from bufferMap to prevent memory leaks
  assert.ok(!controller.isBuffered("card-2"), "card-2 should be evicted to prevent memory leak");
});

test("audio.js: early cutoff termination cleanly aborts audio playback without unhandled rejection", async () => {
  const cards = createMockCards(5);
  const mockCtx = new MockAudioContext("running");
  const controller = new AudioController({
    audioContext: mockCtx,
    fetchAudio: async (c) => ({ id: c.id, duration: 2.0 }),
    autoUnlock: false
  });

  await controller.preloadQueue(cards, 0);

  // Trigger playCurrent() on card-0
  let playPromiseFinished = false;
  let playResult = null;

  const playPromise = controller.playCurrent(cards[0]).then((res) => {
    playPromiseFinished = true;
    playResult = res;
    return res;
  });

  // Immediately advance within 50ms (simulated at 20ms)
  await new Promise((r) => setTimeout(r, 20));
  controller.stopAll();

  // Await play promise to verify clean resolution and no unhandled rejections
  const res = await playPromise;
  assert.ok(playPromiseFinished, "Playback promise should resolve when aborted early");
  assert.equal(res.status, "aborted", "Status should be aborted");
});

test("audio.js: autoplay policy recovery transitions suspended context to running on interaction", async () => {
  const mockCtx = new MockAudioContext("suspended");

  // Mock EventTarget for simulated interaction
  const listeners = new Map();
  const mockEventTarget = {
    addEventListener(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(fn);
    },
    removeEventListener(evt, fn) {
      if (listeners.has(evt)) {
        listeners.set(
          evt,
          listeners.get(evt).filter((f) => f !== fn)
        );
      }
    },
    async dispatchSimulatedEvent(evt) {
      const fns = listeners.get(evt) || [];
      for (const fn of fns) {
        await fn();
      }
    }
  };

  const controller = new AudioController({
    audioContext: mockCtx,
    eventTarget: mockEventTarget,
    autoUnlock: true
  });

  assert.equal(mockCtx.state, "suspended", "Should begin in suspended state");

  // Dispatch a simulated touch/click event
  await mockEventTarget.dispatchSimulatedEvent("click");

  assert.equal(mockCtx.state, "running", "Context state should transition to running");
});

test("audio.js: audio buffer retention keeps stumble-recycled cards in memory until cleared", async () => {
  const cards = createMockCards(10);
  const mockFetchAudio = async (card) => ({ id: card.id, duration: 1.0 });

  const controller = new AudioController({
    audioContext: new MockAudioContext("running"),
    fetchAudio: mockFetchAudio,
    autoUnlock: false
  });

  // Stage card index 0 -> preloads lookahead [card-1, card-2, card-3]
  await controller.preloadQueue(cards, 0);
  assert.ok(controller.isBuffered("card-1"));
  assert.ok(controller.isBuffered("card-2"));
  assert.ok(controller.isBuffered("card-3"));

  // Simulate card-1 stumbling: mark it retained in stumble queue
  controller.retainStumbled(cards[1]);
  assert.equal(controller.isStumbledRetained("card-1"), true);

  // Advance far beyond the 3-card lookahead window to index 5 (lookahead: card-6, card-7, card-8)
  await controller.preloadQueue(cards, 5);

  // Verify normal cards (card-0, card-2, card-3, card-4) are evicted
  assert.ok(!controller.isBuffered("card-0"), "card-0 should be evicted");
  assert.ok(!controller.isBuffered("card-2"), "card-2 should be evicted");
  assert.ok(!controller.isBuffered("card-3"), "card-3 should be evicted");

  // Verify stumbled card-1 REMAINS buffered despite being far outside the lookahead window
  assert.ok(controller.isBuffered("card-1"), "Stumbled card-1 must remain buffered until cleared");

  // Stumbled card in options.stumbleQueue is automatically retained and pre-decoded
  const externalStumbleCard = { id: "stumble-card-99", audio: "https://example.com/stumble.mp3" };
  await controller.preloadQueue(cards, 5, { stumbleQueue: [externalStumbleCard] });
  assert.ok(controller.isBuffered("stumble-card-99"), "Card in stumbleQueue must be preloaded and retained");

  // Now clear stumble retention on card-1 and external stumble card (e.g. answered correctly)
  controller.clearStumbled("card-1");
  controller.clearStumbled("stumble-card-99");
  assert.equal(controller.isStumbledRetained("card-1"), false);
  assert.equal(controller.isStumbledRetained("stumble-card-99"), false);

  // Trigger preloadQueue again: cleared cards must now be cleanly evicted
  await controller.preloadQueue(cards, 5);
  assert.ok(!controller.isBuffered("card-1"), "card-1 should be evicted after being cleared");
  assert.ok(!controller.isBuffered("stumble-card-99"), "stumble-card-99 should be evicted after being cleared");
});

