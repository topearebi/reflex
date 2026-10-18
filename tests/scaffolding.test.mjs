import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateInput, Modes } from "../js/normalizer.js";
import { generateCloze, STOP_WORDS } from "../js/cloze.js";
import { AudioController, AutoplaySettings } from "../js/audio.js";
import { TokenExposureLedger, Store } from "../js/state.js";
import { RecallEngine } from "../js/engine.js";
import { Routes, RouteController } from "../js/routes.js";

/* =========================================================================
   A. Alias & Synonym Evaluation Tests
   ========================================================================= */

test("5.A1. Primary vs. Secondary Equivalence: alias returns identical success verdict as primary target", () => {
  const target = "commencer";
  const aliases = ["débuter", "entamer"];

  // Primary target matches
  assert.equal(evaluateInput("commencer", target, aliases, false), true);
  // Aliases match with identical success
  assert.equal(evaluateInput("débuter", target, aliases, false), true);
  assert.equal(evaluateInput("entamer", target, aliases, false), true);
  // Non-matching input fails
  assert.equal(evaluateInput("finir", target, aliases, false), false);

  // Array of primary targets
  const multiTargets = ["start", "begin"];
  const multiAliases = ["commence", "initiate"];
  assert.equal(evaluateInput("start", multiTargets, multiAliases, false), true);
  assert.equal(evaluateInput("begin", multiTargets, multiAliases, false), true);
  assert.equal(evaluateInput("commence", multiTargets, multiAliases, false), true);
  assert.equal(evaluateInput("initiate", multiTargets, multiAliases, false), true);
});

test("5.A2. Empty and Missing Alias Resilience: cards evaluate normally without runtime errors", () => {
  const target = "pomme";

  // Card without aliases property (undefined)
  assert.equal(evaluateInput("pomme", target), true);
  assert.equal(evaluateInput("poire", target), false);

  // Card with null aliases
  assert.equal(evaluateInput("pomme", target, null), true);
  assert.equal(evaluateInput("poire", target, null), false);

  // Card with empty alias array
  assert.equal(evaluateInput("pomme", target, []), true);
  assert.equal(evaluateInput("poire", target, []), false);

  // Card with sparse / malformed alias array
  assert.equal(evaluateInput("pomme", target, [null, undefined, "", "  "]), true);
  assert.equal(evaluateInput("poire", target, [null, undefined, "", "  "]), false);

  // Null input resilience
  assert.equal(evaluateInput(null, target, []), false);
  assert.equal(evaluateInput("", target, []), false);
  assert.equal(evaluateInput("   ", target, []), false);
});

test("5.A3. Whitespace & Case Robustness in Aliases: mixed casing and surrounding whitespace are sanitized", () => {
  const target = "cœur";
  const aliases = ["  COEUR  ", "\tLe Cœur\n", "  heART  "];

  // Clean user inputs matching messy aliases
  assert.equal(evaluateInput("coeur", target, aliases, false), true);
  assert.equal(evaluateInput("le cœur", target, aliases, false), true);
  assert.equal(evaluateInput("heart", target, aliases, false), true);

  // User input with its own whitespace & casing
  assert.equal(evaluateInput("  COEUR  ", target, aliases, false), true);
  assert.equal(evaluateInput("  HeArT  ", target, aliases, false), true);

  // Mismatch
  assert.equal(evaluateInput("poumon", target, aliases, false), false);
});

/* =========================================================================
   B. Diacritic Evaluation & Visual Reinforcement Tests
   ========================================================================= */

test("5.B1. Speed Mode NFD Equivalence: unaccented Latin string matches combining diacritics", () => {
  const target = "crème brûlée";
  const aliases = ["à la mode"];

  // Under Speed Mode (strict: false)
  assert.equal(evaluateInput("creme brulee", target, aliases, false), true);
  assert.equal(evaluateInput("a la mode", target, aliases, false), true);
  assert.equal(evaluateInput("CREME BRULEE", target, aliases, false), true);

  // Spanish diacritics
  assert.equal(evaluateInput("nino", "niño", [], false), true);
  assert.equal(evaluateInput("espanol", "español", [], false), true);

  // German umlauts & French accents
  assert.equal(evaluateInput("uber", "über", [], false), true);
  assert.equal(evaluateInput("fenetre", "fenêtre", [], false), true);
});

test("5.B2. Strict Mode Accent Enforcement: unaccented input fails and exact accented string succeeds", () => {
  const target = "crème brûlée";

  // Strict mode: unaccented input MUST fail
  assert.equal(evaluateInput("creme brulee", target, [], true), false);
  assert.equal(evaluateInput("creme brûlée", target, [], true), false);

  // Exact accents MUST succeed
  assert.equal(evaluateInput("crème brûlée", target, [], true), true);
  assert.equal(evaluateInput("Crème Brûlée", target, [], true), true); // case-insensitive

  // French distinction: été
  assert.equal(evaluateInput("ete", "été", [], true), false);
  assert.equal(evaluateInput("été", "été", [], true), true);
  assert.equal(evaluateInput("Été", "été", [], true), true);
});

test("5.B3. Tone Suffix Parsing: numerical tone markers match accented tonal representations", () => {
  const zhDeck = { romanization: "pinyin" };

  // Tone numbers vs tone marks
  assert.equal(evaluateInput("hao3", "hǎo", [], { deck: zhDeck, strict: false }), true);
  assert.equal(evaluateInput("ni3hao3", "nǐhǎo", [], { deck: zhDeck, strict: false }), true);
  assert.equal(evaluateInput("wo3men", "wǒmen", [], { deck: zhDeck, strict: false }), true);

  // Tone marks vs tone numbers
  assert.equal(evaluateInput("nǐhǎo", "ni3hao3", [], { deck: zhDeck, strict: false }), true);

  // Neutral tone optional
  assert.equal(evaluateInput("ba4ba", "bàba", [], { deck: zhDeck, strict: false }), true);
  assert.equal(evaluateInput("ba4ba5", "bàba", [], { deck: zhDeck, strict: false }), true);

  // Pinyin ü/v mappings
  assert.equal(evaluateInput("nv3", "nǚ", [], { deck: zhDeck, strict: false }), true);
  assert.equal(evaluateInput("lv4", "lù", [], { deck: zhDeck, strict: false }), false);
  assert.equal(evaluateInput("lv4", "lǜ", [], { deck: zhDeck, strict: false }), true);
});

test("5.B4. Visual Reinforcement Trigger: Speed Mode dispatches visual-reinforcement state event", () => {
  const mockCard = {
    id: "card-reinforce",
    prompt: "fenêtre",
    answer: "fenêtre",
    answers: ["fenêtre"]
  };

  // 1. RecallEngine test
  const store = new Store();
  store.setMode(Modes.STANDARD); // Speed / diacritics optional
  const engine = new RecallEngine(store);
  engine.card = mockCard;
  engine.phase = "answering";

  let engineEventDispatched = false;
  let engineEventDetail = null;

  engine.addEventListener("visual-reinforcement", (e) => {
    engineEventDispatched = true;
    engineEventDetail = e.detail;
  });

  // User types unaccented input in Speed Mode
  engine.input("fenetre");

  assert.equal(engineEventDispatched, true, "visual-reinforcement event must be dispatched on match in Speed Mode");
  assert.equal(engineEventDetail.canonical, "fenêtre", "Canonical accented orthography must be included in event detail");
  assert.ok(engineEventDetail.duration >= 200 && engineEventDetail.duration <= 300);

  // 2. RouteController test
  const routeCtrl = new RouteController({
    defaultRoute: Routes.REFLEX,
    store,
    queue: [mockCard]
  });
  routeCtrl.mountCard(mockCard);

  let routeEventDispatched = false;
  let routeEventDetail = null;

  routeCtrl.addEventListener("visual-reinforcement", (e) => {
    routeEventDispatched = true;
    routeEventDetail = e.detail;
  });

  // User types unaccented input in Reflex route
  routeCtrl.handleInput("fenetre");

  assert.equal(routeEventDispatched, true, "RouteController must dispatch visual-reinforcement in Speed Mode");
  assert.equal(routeEventDetail.canonical, "fenêtre");
});

/* =========================================================================
   C. Audio Pre-Fetch & Cascade Tests
   ========================================================================= */

function createMockAudioCards(count = 6) {
  return Array.from({ length: count }, (_, i) => ({
    id: `card-${i}`,
    prompt: `Prompt ${i}`,
    answer: `Answer ${i}`,
    lang: "fr-FR",
    audio: `https://example.com/audio-${i}.mp3`
  }));
}

class MockAudioContext {
  constructor() {
    this.state = "running";
    this.destination = {};
  }
  async resume() {
    this.state = "running";
  }
  createBufferSource() {
    const src = {
      buffer: null,
      connect() {},
      disconnect() {},
      start() {
        setTimeout(() => {
          if (typeof this.onended === "function") this.onended();
        }, 1);
      },
      stop() {
        if (typeof this.onended === "function") this.onended();
      },
      onended: null
    };
    return src;
  }
}

test("5.C1. Lookahead Queue Population: staging card N triggers pre-fetch for N+1, N+2, and N+3", async () => {
  const cards = createMockAudioCards(6);
  const fetchedIds = [];

  const controller = new AudioController({
    audioContext: new MockAudioContext(),
    fetchAudio: async (c) => {
      fetchedIds.push(c.id);
      return { id: c.id, duration: 1.0 };
    },
    autoUnlock: false
  });

  // Stage card index 1 (N = 1)
  await controller.preloadQueue(cards, 1);

  // Lookahead queue must hold exactly cards N+1 (2), N+2 (3), N+3 (4)
  assert.deepEqual(controller.getLookaheadQueue(), ["card-2", "card-3", "card-4"]);
  assert.ok(fetchedIds.includes("card-2"));
  assert.ok(fetchedIds.includes("card-3"));
  assert.ok(fetchedIds.includes("card-4"));
  assert.ok(!fetchedIds.includes("card-5"));
  assert.ok(!fetchedIds.includes("card-0"));
});

test("5.C2. Cascade Fallback Progression: Tier 1 -> Tier 2 -> Tier 3", async () => {
  // Mock Speech Synthesis
  class MockSpeechSynthesisUtterance {
    constructor(text) {
      this.text = text;
      this.lang = "";
    }
  }

  const speechHistory = [];
  const mockSpeechSynthesis = {
    speak(utterance) {
      speechHistory.push({ text: utterance.text, lang: utterance.lang });
      setTimeout(() => {
        if (typeof utterance.onend === "function") utterance.onend();
      }, 5);
    },
    cancel() {}
  };

  // --- Tier 1: Valid Audio Asset Supplied ---
  const controllerT1 = new AudioController({
    audioContext: new MockAudioContext(),
    fetchAudio: async (c) => ({ id: c.id, duration: 1.0 }),
    SpeechSynthesisUtterance: MockSpeechSynthesisUtterance,
    speechSynthesis: mockSpeechSynthesis,
    autoUnlock: false
  });

  const cardWithAudio = { id: "c1", prompt: "bonjour", answer: "bonjour", audio: "https://example.com/bonjour.mp3", lang: "fr" };
  const resT1 = await controllerT1.playCurrent(cardWithAudio);
  assert.equal(resT1.mode, "webaudio", "Tier 1 must invoke Web Audio buffer playback");
  assert.equal(resT1.status, "finished");
  assert.equal(speechHistory.length, 0, "Speech synthesis should NOT be called when audio asset succeeds");

  // --- Tier 2: Audio Asset is Null / Fails to Load -> Falls back to Speech Synthesis ---
  const controllerT2 = new AudioController({
    audioContext: new MockAudioContext(),
    fetchAudio: async () => {
      throw new Error("Network 404");
    },
    SpeechSynthesisUtterance: MockSpeechSynthesisUtterance,
    speechSynthesis: mockSpeechSynthesis,
    autoUnlock: false
  });

  const cardNoAudio = { id: "c2", prompt: "soleil", answer: "soleil", audio: null, lang: "fr-FR" };
  const resT2 = await controllerT2.playCurrent(cardNoAudio);
  assert.equal(resT2.mode, "speech", "Tier 2 must fall back to native speech synthesis");
  assert.equal(resT2.lang, "fr-FR", "Matching BCP-47 language tag must be applied");
  assert.equal(speechHistory.length, 1);
  assert.equal(speechHistory[0].text, "soleil");
  assert.equal(speechHistory[0].lang, "fr-FR");

  // --- Tier 3: Speech Synthesis Unsupported / Fails -> Graceful Silence ---
  const controllerT3 = new AudioController({
    audioContext: null,
    fetchAudio: async () => null,
    speechSynthesis: null, // unsupported
    autoUnlock: false
  });

  const cardSilent = { id: "c3", prompt: "étoile", answer: "étoile", audio: null, lang: "fr" };
  const resT3 = await controllerT3.playCurrent(cardSilent);
  assert.equal(resT3.mode, "fallback", "Tier 3 must proceed silently");
  assert.equal(resT3.status, "silence", "Must return silence without unhandled exceptions");
});

test("5.C3. Autoplay Preference Settings: Mute Audio, Audio on Reveal, Audio on Mount", async () => {
  const mockCtx = new MockAudioContext();
  const card = { id: "c-pref", prompt: "test", answer: "test", audio: "https://example.com/t.mp3" };

  const controller = new AudioController({
    audioContext: mockCtx,
    fetchAudio: async (c) => ({ id: c.id }),
    autoplay: AutoplaySettings.MOUNT,
    autoUnlock: false
  });

  // Default: Audio on Mount
  const resMount = await controller.playCurrent(card, "mount");
  assert.equal(resMount.status, "finished");

  // Setting: Mute Audio
  controller.setAutoplaySetting(AutoplaySettings.MUTE);
  const resMuted = await controller.playCurrent(card, "mount");
  assert.equal(resMuted.status, "muted", "Mute setting must skip audio output");

  // Setting: Audio on Reveal
  controller.setAutoplaySetting(AutoplaySettings.REVEAL);
  // Mount event -> skipped
  const resSkippedOnMount = await controller.playCurrent(card, "mount");
  assert.equal(resSkippedOnMount.status, "skipped", "Audio on Reveal must not trigger on mount");
  // Reveal event -> played
  const resPlayedOnReveal = await controller.playCurrent(card, "reveal");
  assert.equal(resPlayedOnReveal.status, "finished", "Audio on Reveal must trigger on reveal");
});

test("5.C4. Buffer Cleanup: completed cards release decoded audio buffers to prevent memory leaks", async () => {
  const cards = createMockAudioCards(8);
  const controller = new AudioController({
    audioContext: new MockAudioContext(),
    fetchAudio: async (c) => ({ id: c.id, size: 1024 }),
    autoUnlock: false
  });

  // Stage card 0
  await controller.preloadQueue(cards, 0);
  assert.ok(controller.isBuffered("card-1"));
  assert.ok(controller.isBuffered("card-2"));
  assert.ok(controller.isBuffered("card-3"));

  // Advance to card 3: cards 0, 1, 2 are completed and unneeded
  await controller.preloadQueue(cards, 3);
  assert.ok(!controller.isBuffered("card-0"), "Card 0 buffer must be evicted");
  assert.ok(!controller.isBuffered("card-1"), "Card 1 buffer must be evicted");
  assert.ok(!controller.isBuffered("card-2"), "Card 2 buffer must be evicted");
  assert.ok(controller.isBuffered("card-4"));
  assert.ok(controller.isBuffered("card-5"));
  assert.ok(controller.isBuffered("card-6"));

  // Explicit evictBuffer method
  controller.evictBuffer("card-4");
  assert.ok(!controller.isBuffered("card-4"));
});

/* =========================================================================
   D. Dynamic Ledger & Target Selection Tests
   ========================================================================= */

test("5.D1. Frequency-Capped Selection: unmastered word is selected over frequently drilled particle", () => {
  const ledger = new TokenExposureLedger("test_ledger_freq_cap");
  ledger.clear();

  // "le", "chat", "mange", "la", "pomme"
  // Simulate frequent particle drilling: "le" drilled 20 times, "la" drilled 20 times
  for (let i = 0; i < 20; i++) {
    ledger.recordExposure("le", true);
    ledger.recordExposure("la", true);
  }
  // "chat" drilled 8 times (saturated >= 5)
  for (let i = 0; i < 8; i++) {
    ledger.recordExposure("chat", true);
  }
  // "pomme" drilled 1 time (unsaturated < 5)
  ledger.recordExposure("pomme", true);
  // "mange" drilled 0 times (unmastered)

  const sentence = "Le chat mange la pomme";
  const cloze = generateCloze(sentence, { ledger, lang: "fr" });

  assert.equal(cloze.target, "mange", "Unmastered word 'mange' (0 reviews) must be chosen over particles and saturated tokens");
  assert.equal(cloze.tokens.find((t) => t.isTarget).text, "mange");
  ledger.clear();
});

test("5.D2. Fallback on Full Saturation: selects token with oldest last-reviewed timestamp", () => {
  const ledger = new TokenExposureLedger("test_ledger_full_sat");
  ledger.clear();

  const now = Date.now();
  // Simulate all tokens in sentence saturated (reviews >= saturationLimit 5)
  // Token "alpha" reviewed 8 times, last seen 5000ms ago (oldest)
  ledger.tokens.set("alpha", { text: "alpha", reviews: 8, errors: 0, lastSeen: now - 5000 });
  // Token "beta" reviewed 6 times, last seen 2000ms ago
  ledger.tokens.set("beta", { text: "beta", reviews: 6, errors: 0, lastSeen: now - 2000 });
  // Token "gamma" reviewed 10 times, last seen 1000ms ago (newest)
  ledger.tokens.set("gamma", { text: "gamma", reviews: 10, errors: 0, lastSeen: now - 1000 });

  const sentence = "alpha beta gamma";
  const cloze = generateCloze(sentence, { ledger, saturationLimit: 5 });

  // Must fall back to "alpha" because its lastSeen is the oldest (smallest timestamp)
  assert.equal(cloze.target, "alpha", "On full saturation, the token with the oldest last-reviewed timestamp must be selected");
  assert.ok(cloze.tokens.find((t) => t.isTarget).text === "alpha");
  ledger.clear();
});

test("5.D3. Stop-Words Fallback: sentence entirely made of stop words still generates a target blank", () => {
  const ledger = new TokenExposureLedger("test_ledger_all_stopwords");
  ledger.clear();

  // Sentence with only stop words: "It is what it is"
  const sentence = "It is that";
  const cloze = generateCloze(sentence, { ledger });

  assert.ok(cloze.target !== "", "A cloze target blank must always be generated even if sentence has only stop words");
  assert.ok(cloze.tokens.some((t) => t.isTarget), "At least one token must be marked as target");
  ledger.clear();
});

