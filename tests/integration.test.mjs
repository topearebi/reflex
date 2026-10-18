import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../js/state.js";
import { RecallEngine } from "../js/engine.js";
import { GitHubSync } from "../js/github-sync.js";

test("state immutability and sync isolation during a 50-card drill sprint", async () => {
  // Load bilingual cloze deck
  const bilingualData = JSON.parse(
    readFileSync(new URL("../data/bilingual-cloze.json", import.meta.url), "utf-8")
  );

  const store = new Store();

  // Create a custom deck based on bilingualData
  const customCards = bilingualData.cards.map((c) => ({
    id: c.id,
    group: c.group || "General",
    unit: c.unit || "Unit 1",
    prompt: c.prompt,
    subtitle: c.subtitle || "",
    answers: [c.answer],
    aliases: c.aliases || []
  }));

  const deckId = store.createDeck(
    { name: "Bilingual Sprint", lang: "en", answerLang: "en" },
    customCards
  );

  // Deep-freeze every card in the deck and the cards array to ensure strict immutability
  const deck = store.getDeck(deckId);
  Object.freeze(deck.cards);
  for (const card of deck.cards) {
    Object.freeze(card);
    if (card.answers) Object.freeze(card.answers);
  }

  // Create RecallEngine
  const engine = new RecallEngine(store);
  engine.next();

  // Create GitHubSync instance
  const sync = new GitHubSync(store);
  sync.saveConfig({ token: "test_token", repo: "test/repo", filePath: "speedrecall-data.json" });

  // Snapshot exported data before drill
  const exportBefore = store.exportData();

  // Execute a 50-card sprint with dynamic cloze generation, input matching, and stumbling
  for (let i = 0; i < 50; i++) {
    assert.ok(engine.card, `Engine must yield an active card at step ${i}`);
    const activeCard = engine.card;

    // Verify activeCard has target and answers
    assert.ok(activeCard.answers && activeCard.answers.length > 0);
    const targetAnswer = activeCard.answers[0];

    // Every 5th card, simulate a stumble (miss)
    if (i % 5 === 0) {
      engine.giveUp("wrong answer");
      assert.equal(engine.phase, "correcting");
      // Now correct it
      engine.input(targetAnswer);
      assert.equal(engine.phase, "advancing");
    } else {
      // Type correct answer
      engine.input(targetAnswer);
      assert.equal(engine.phase, "advancing");
    }

    // Step to next card
    engine.next();
  }

  // Verify that the original source deck cards in store were not mutated
  for (const origCard of deck.cards) {
    assert.equal(Object.isFrozen(origCard), true, "Original card definition must remain frozen");
    assert.equal(origCard.cloze, undefined, "Original card must not have cloze metadata attached");
    assert.equal(origCard._dueAfter, undefined, "Original card must not have stumble scheduling metadata");
    assert.equal(origCard._stumbleId, undefined, "Original card must not have stumble id");
  }

  // Verify that GitHub sync payload is isolated and does not contain transient session metrics
  const exportAfter = store.exportData();
  assert.equal(exportAfter.stumbleQueue, undefined, "Sync payload must not contain stumbleQueue");
  assert.equal(exportAfter.tokenLedger, undefined, "Sync payload must not contain tokenLedger");
  assert.equal(exportAfter.session, undefined, "Sync payload must not contain session statistics");
  assert.equal(exportAfter.audio, undefined, "Sync payload must not contain audio buffers");

  // Verify progress was recorded properly in exportAfter
  assert.ok(Object.keys(exportAfter.progress).length > 0, "Progress should be recorded");

  // Verify TokenExposureLedger recorded exposures
  const quickStats = store.tokenLedger.getTokenStats("quick");
  const studyStats = store.tokenLedger.getTokenStats("study");
  assert.ok(
    quickStats.reviews > 0 || studyStats.reviews > 0,
    "Token ledger should have recorded token exposures during sprint"
  );
});

