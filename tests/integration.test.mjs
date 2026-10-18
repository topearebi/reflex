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

test("service worker cache busting, lifecycle claim, and asset versioning", () => {
  const swContent = readFileSync(new URL("../sw.js", import.meta.url), "utf-8");
  const htmlContent = readFileSync(new URL("../index.html", import.meta.url), "utf-8");

  // 1. Verify cache name in sw.js is updated to speedrecall-v3
  assert.match(
    swContent,
    /const\s+CACHE_NAME\s*=\s*["']speedrecall-v3["']/,
    "sw.js must define CACHE_NAME as speedrecall-v3"
  );

  // 2. Verify new modules are included in pre-cache list
  assert.ok(swContent.includes('"./js/routes.js"'), "CORE cache must include routes.js");
  assert.ok(swContent.includes('"./js/audio.js"'), "CORE cache must include audio.js");
  assert.ok(swContent.includes('"./js/cloze.js"'), "CORE cache must include cloze.js");
  assert.ok(swContent.includes('"./css/app.css"'), "CORE cache must include app.css");

  // 3. Verify self.skipWaiting() in install phase
  assert.ok(
    swContent.includes("self.skipWaiting()"),
    "sw.js install event must invoke self.skipWaiting()"
  );

  // 4. Verify stale cache purging in activate phase
  assert.ok(
    swContent.includes("caches.keys()") && swContent.includes("caches.delete"),
    "sw.js activate event must purge stale caches"
  );
  assert.ok(
    swContent.includes("key !== CACHE_NAME"),
    "sw.js activate event must delete all caches not matching CACHE_NAME"
  );

  // 5. Verify self.clients.claim() in activate phase
  assert.ok(
    swContent.includes("self.clients.claim()"),
    "sw.js activate event must invoke self.clients.claim()"
  );

  // 6. Verify index.html cache-busted entry points
  assert.match(
    htmlContent,
    /<link[^>]+href=["']css\/app\.css\?v=3["']/,
    "index.html must reference css/app.css?v=3"
  );
  assert.match(
    htmlContent,
    /<script[^>]+src=["']js\/app\.js\?v=3["']/,
    "index.html must reference js/app.js?v=3"
  );
  assert.match(
    htmlContent,
    /navigator\.serviceWorker\.register\(["']\.\/sw\.js\?v=3["']\)/,
    "index.html must register sw.js with ?v=3 query parameter"
  );

  // 7. Verify js/app.js handles controllerchange lifecycle updates
  const appContent = readFileSync(new URL("../js/app.js", import.meta.url), "utf-8");
  assert.ok(
    appContent.includes("bindServiceWorker"),
    "js/app.js must declare and initialize bindServiceWorker()"
  );
  assert.match(
    appContent,
    /navigator\.serviceWorker\.register\(["']\.\/sw\.js\?v=3["']\)/,
    "js/app.js must register sw.js with ?v=3 query parameter"
  );
  assert.match(
    appContent,
    /navigator\.serviceWorker\.addEventListener\(\s*["']controllerchange["']/,
    "js/app.js must listen for controllerchange event"
  );
  assert.ok(
    appContent.includes("this.toast") && appContent.includes("this.store.init"),
    "js/app.js controllerchange handler must notify UI and refresh active data references"
  );
});

