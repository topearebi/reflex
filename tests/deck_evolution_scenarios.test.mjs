// Automated tests for Deck Evolution Scenarios & Modular Deck Management
// Validates:
// Scenario 1: External deck growth & typo fixes preserves progress via content hash fallback
// Scenario 2: Modular per-deck export contains content only (zero private progress)
// Scenario 3: Card ID renumbering preserves mastery and spaced repetition weights
// Scenario 4: Manifest and modular deck loading
// Scenario 5: Tombstone resolution across sync merges

import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, cardContentHash, normalizeCard } from "../js/state.js";

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

test("Scenario 1: External deck growth & typo fixes preserve user mastery and weights", async () => {
  globalThis.localStorage.clear();
  const store = new Store();
  await store.init();

  // 1. User has an active custom deck "es-verbs" with Unit 1 (3 cards)
  const initialDeck = {
    id: "es-verbs",
    name: "Spanish Verbs",
    lang: "es",
    units: ["Unit 1: Basics"],
    cards: [
      { id: "c-1", unit: "Unit 1: Basics", prompt: "hablar", answers: ["to speak"], subtitle: "ar-verb" },
      { id: "c-2", unit: "Unit 1: Basics", prompt: "comer", answers: ["to eat"], subtitle: "er-verb" },
      { id: "c-3", unit: "Unit 1: Basics", prompt: "vivir", answers: ["to live"], subtitle: "ir-verb" }
    ]
  };
  store.importSingleDeck(initialDeck);
  store.state.prefs.currentDeckId = "es-verbs";

  const deck = store.getDeck("es-verbs");
  assert.equal(deck.cards.length, 3);

  // 2. User practices: masters hablar and comer (multiple correct answers)
  const card1 = deck.cards.find((c) => c.prompt === "hablar");
  const card2 = deck.cards.find((c) => c.prompt === "comer");
  const card3 = deck.cards.find((c) => c.prompt === "vivir");

  store.record(card1, true);
  store.record(card1, true);
  store.record(card1, true);
  store.record(card2, true);
  store.record(card2, true);
  store.record(card3, false); // missed vivir

  const hablarMasteryBefore = store.mastery(card1);
  const hablarWeightBefore = store.weight(card1);
  assert.ok(hablarMasteryBefore > 0.5, "Mastery should be high after 3 correct answers");
  assert.ok(hablarWeightBefore < 0.5, "Weight should be low (learned)");

  // 3. Deck author updates deck externally:
  //    - Adds Unit 2 with 2 new cards
  //    - Re-indexes all card IDs ("sp-01", "sp-02", "sp-03")
  //    - Prompts & answers for hablar and comer are unchanged
  const updatedDeck = {
    id: "es-verbs",
    name: "Spanish Verbs Expanded",
    lang: "es",
    units: ["Unit 1: Basics", "Unit 2: Irregular"],
    cards: [
      { id: "sp-01", unit: "Unit 1: Basics", prompt: "hablar", answers: ["to speak"], subtitle: "ar-verb" },
      { id: "sp-02", unit: "Unit 1: Basics", prompt: "comer", answers: ["to eat"], subtitle: "er-verb" },
      { id: "sp-03", unit: "Unit 1: Basics", prompt: "vivir", answers: ["to live"], subtitle: "ir-verb" },
      { id: "sp-04", unit: "Unit 2: Irregular", prompt: "ir", answers: ["to go"], subtitle: "irregular" },
      { id: "sp-05", unit: "Unit 2: Irregular", prompt: "ser", answers: ["to be"], subtitle: "irregular" }
    ]
  };

  store.importSingleDeck(updatedDeck);
  const updatedLoaded = store.getDeck("es-verbs");
  assert.equal(updatedLoaded.cards.length, 5, "Deck should now have 5 cards");

  // 4. Verify progress survived despite card ID re-indexing!
  const newCard1 = updatedLoaded.cards.find((c) => c.prompt === "hablar");
  const newCard4 = updatedLoaded.cards.find((c) => c.prompt === "ir");

  const hablarMasteryAfter = store.mastery(newCard1);
  const hablarWeightAfter = store.weight(newCard1);

  assert.equal(
    hablarMasteryAfter.toFixed(3),
    hablarMasteryBefore.toFixed(3),
    "Hablar mastery must survive external card ID re-indexing via content hash"
  );
  assert.equal(
    hablarWeightAfter.toFixed(3),
    hablarWeightBefore.toFixed(3),
    "Hablar weight must survive external card ID re-indexing"
  );

  // New card starts with neutral unpracticed stats
  assert.equal(store.mastery(newCard4), 0, "New card should have 0 mastery");
  assert.equal(store.weight(newCard4), 1.0, "New card should have 1.0 neutral weight");
});

test("Scenario 2: Modular per-deck export contains content only (no private progress)", async () => {
  globalThis.localStorage.clear();
  const store = new Store();
  await store.init();

  const deck = {
    id: "fr-vocab",
    name: "French Food",
    lang: "fr",
    cards: [
      { id: "f-1", prompt: "pain", answers: ["bread"], subtitle: "noun" },
      { id: "f-2", prompt: "pomme", answers: ["apple"], subtitle: "noun" }
    ]
  };
  store.importSingleDeck(deck);
  store.record(store.getDeck("fr-vocab").cards[0], true);
  store.record(store.getDeck("fr-vocab").cards[0], true);

  // Export single deck
  const exported = store.exportDeck("fr-vocab");

  // Assert deck has content fields
  assert.equal(exported.id, "fr-vocab");
  assert.equal(exported.name, "French Food");
  assert.equal(exported.cards.length, 2);
  assert.equal(exported.cards[0].prompt, "pain");

  // Assert NO private user study progress is in the file
  assert.equal(exported.progress, undefined, "exportDeck must not contain progress records");
  assert.equal(exported.attempts, undefined);
  assert.equal(exported.weight, undefined);

  // Test importing into another clean store
  const store2 = new Store();
  await store2.init();
  store2.importSingleDeck(exported);

  const importedDeck = store2.getDeck("fr-vocab");
  assert.ok(importedDeck, "Second store must have imported deck");
  assert.equal(store2.mastery(importedDeck.cards[0]), 0, "Second store starts with 0 mastery");
});

test("Scenario 3: Card ID renumbering preserves mastery & spaced repetition weights", () => {
  const cardA = normalizeCard({ id: "old-101", prompt: "merci", answers: ["thank you"], subtitle: "polite" });
  const cardB = normalizeCard({ id: "new-999", prompt: "merci", answers: ["thank you"], subtitle: "polite" });

  assert.equal(cardA.hash, cardB.hash, "Cards with identical content must share identical hash");
  assert.notEqual(cardA.id, cardB.id, "Cards have different IDs");
});

test("Scenario 4: Manifest indexing and decoupled progress export", async () => {
  globalThis.localStorage.clear();
  const store = new Store();
  await store.init();

  store.importSingleDeck({
    id: "deck-a",
    name: "Deck Alpha",
    cards: [{ id: "a1", prompt: "one", answers: ["1"] }]
  });
  store.importSingleDeck({
    id: "deck-b",
    name: "Deck Beta",
    cards: [{ id: "b1", prompt: "two", answers: ["2"] }]
  });

  const progressExport = store.exportProgress();
  assert.equal(progressExport.type, "progress");
  assert.ok(progressExport.progress);

  const fullArchive = store.exportData();
  assert.ok(fullArchive.manifest);
  assert.ok(Array.isArray(fullArchive.manifest.decks));
  assert.equal(fullArchive.manifest.decks.length, store.deckIds().length);
});

test("Scenario 5: Tombstone resolution across sync merges", async () => {
  globalThis.localStorage.clear();
  const store = new Store();
  await store.init();

  store.importSingleDeck({
    id: "deck-to-delete",
    name: "Temp Deck",
    cards: [{ id: "t1", prompt: "temp", answers: ["temp"] }]
  });

  assert.ok(store.decksExists("deck-to-delete"));
  store.deleteDeck("deck-to-delete");
  assert.equal(store.decksExists("deck-to-delete"), false);

  // Simulating an incoming sync from another device that still had the old deck
  const incomingSync = {
    schema: 4,
    customDecks: {
      "deck-to-delete": {
        name: "Temp Deck",
        updated: Date.now() - 50000, // older than deletion tombstone
        cards: [{ id: "t1", prompt: "temp", answers: ["temp"] }]
      }
    },
    deletedDecks: {},
    progress: {}
  };

  store.mergeData(incomingSync);
  assert.equal(store.decksExists("deck-to-delete"), false, "Deleted deck with older update must not resurrect");
});
