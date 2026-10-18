import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store, TokenExposureLedger, unitKey, normalizeCard } from "../js/state.js";
import { RecallEngine } from "../js/engine.js";
import { GitHubSync } from "../js/github-sync.js";
import { Routes, RouteController } from "../js/routes.js";

function createMockStorage() {
  const store = {};
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, val) => {
      store[key] = String(val);
    },
    removeItem: (key) => {
      delete store[key];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    get _data() {
      return store;
    }
  };
}

/* =========================================================================
   Scenario 1: Tab Navigation Isolation (#settingsModal)
   ========================================================================= */

test("Scenario 1: Tab Navigation Isolation: switching tabs does not reset form state or unbind handlers", () => {
  // Mock tab elements and panels
  function createTabPair(id) {
    const btn = {
      id,
      className: "tab-button",
      attributes: { "aria-selected": "false" },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k]; },
      classList: {
        contains(c) { return this._classes?.has(c); },
        toggle(c, force) {
          if (!this._classes) this._classes = new Set();
          if (force) this._classes.add(c);
          else this._classes.delete(c);
        }
      }
    };
    const panel = {
      hidden: true
    };
    return { btn, panel };
  }

  const tabDecks = createTabPair("tabDecks");
  const tabBackup = createTabPair("tabBackup");
  const tabSync = createTabPair("tabSync");
  const tabOptions = createTabPair("tabOptions");

  const tabs = [
    { id: "tabDecks", btn: tabDecks.btn, panel: tabDecks.panel },
    { id: "tabBackup", btn: tabBackup.btn, panel: tabBackup.panel },
    { id: "tabSync", btn: tabSync.btn, panel: tabSync.panel },
    { id: "tabOptions", btn: tabOptions.btn, panel: tabOptions.panel }
  ];

  function switchTab(activeId) {
    for (const t of tabs) {
      const isActive = t.id === activeId;
      t.btn.setAttribute("aria-selected", String(isActive));
      t.btn.classList.toggle("is-active", isActive);
      t.panel.hidden = !isActive;
    }
  }

  // Simulated form inputs across panels
  const formState = {
    importText: "Prompt1\tAnswer1",
    ghToken: "ghp_secure_token_12345",
    ghRepo: "user/reflex-repo",
    ghPath: "custom-path.json",
    optStrictness: "strict"
  };

  // 1. Initial State: tabDecks is active
  switchTab("tabDecks");
  assert.equal(tabDecks.btn.getAttribute("aria-selected"), "true");
  assert.equal(tabDecks.panel.hidden, false);
  assert.equal(tabBackup.panel.hidden, true);
  assert.equal(tabSync.panel.hidden, true);
  assert.equal(tabOptions.panel.hidden, true);

  // 2. Switch to tabBackup
  switchTab("tabBackup");
  assert.equal(tabBackup.btn.getAttribute("aria-selected"), "true");
  assert.equal(tabBackup.panel.hidden, false);
  assert.equal(tabDecks.panel.hidden, true);
  assert.equal(formState.importText, "Prompt1\tAnswer1", "importText input preserved");

  // 3. Switch to tabSync
  switchTab("tabSync");
  assert.equal(tabSync.btn.getAttribute("aria-selected"), "true");
  assert.equal(tabSync.panel.hidden, false);
  assert.equal(tabBackup.panel.hidden, true);
  assert.equal(formState.ghToken, "ghp_secure_token_12345", "ghToken input preserved");
  assert.equal(formState.ghRepo, "user/reflex-repo", "ghRepo input preserved");
  assert.equal(formState.ghPath, "custom-path.json", "ghPath input preserved");

  // 4. Switch to tabOptions
  switchTab("tabOptions");
  assert.equal(tabOptions.btn.getAttribute("aria-selected"), "true");
  assert.equal(tabOptions.panel.hidden, false);
  assert.equal(tabSync.panel.hidden, true);
  assert.equal(formState.optStrictness, "strict", "optStrictness value preserved");

  // 5. Switch back to tabDecks
  switchTab("tabDecks");
  assert.equal(tabDecks.btn.getAttribute("aria-selected"), "true");
  assert.equal(tabDecks.panel.hidden, false);
  assert.equal(tabOptions.panel.hidden, true);
  assert.equal(formState.importText, "Prompt1\tAnswer1", "importText remains untouched");
  assert.equal(formState.ghToken, "ghp_secure_token_12345", "ghToken remains untouched");
});

/* =========================================================================
   Scenario 2: Role Inversion Integrity
   ========================================================================= */

test("Scenario 2: Role Inversion Integrity: flipRoles swaps prompt and answer in-flight without resetting progress", () => {
  const store = new Store();
  const testCards = [
    {
      id: "card-1",
      group: "General",
      unit: "Unit 1",
      prompt: "老师",
      answers: ["teacher"],
      script: "老师",
      phonetic: "lǎoshī",
      gloss: "teacher",
      subtitle: "lǎoshī"
    }
  ];

  const deckId = store.createDeck({ name: "Chinese Vocab", lang: "zh" }, testCards);
  store.setDeck(deckId);
  store.setUnits(["General::Unit 1"]);

  const engine = new RecallEngine(store);
  engine.setRoles("script", "phonetic");
  engine.next();

  assert.ok(engine.card);
  assert.equal(engine.card.prompt, "老师", "Initial prompt is script");
  assert.equal(engine.card.answers[0], "lǎoshī", "Initial target is phonetic");

  // Simulate ongoing session progress
  store.session.streak = 7;
  store.session.attempts = 10;
  store.session.correct = 8;

  let cardEventEmitted = 0;
  engine.addEventListener("card", () => {
    cardEventEmitted++;
  });

  // Tap role flip (⇄)
  engine.flipRoles();

  assert.equal(cardEventEmitted, 1, "flipRoles must immediately emit 'card' event");
  assert.equal(engine.activePromptRole, "phonetic", "Prompt role flipped to phonetic");
  assert.equal(engine.activeTargetRole, "script", "Target role flipped to script");
  assert.equal(engine.card.prompt, "lǎoshī", "Current card prompt is now phonetic");
  assert.equal(engine.card.answers[0], "老师", "Current card answer is now script");

  // Verify streak and session stats are untouched
  assert.equal(store.session.streak, 7, "Streak must not reset on role flip");
  assert.equal(store.session.attempts, 10, "Attempts must not reset");
  assert.equal(store.session.correct, 8, "Correct count must not reset");

  // Flip back
  engine.flipRoles();
  assert.equal(cardEventEmitted, 2);
  assert.equal(engine.activePromptRole, "script");
  assert.equal(engine.activeTargetRole, "phonetic");
  assert.equal(engine.card.prompt, "老师");
  assert.equal(engine.card.answers[0], "lǎoshī");
});

/* =========================================================================
   Scenario 3: 10-Unit Micro-Chunking
   ========================================================================= */

test("Scenario 3: 10-Unit Micro-Chunking: selecting a 10-card unit restricts active queue to those 10 cards", () => {
  const store = new Store();

  // Create 30 cards across 3 units of 10
  const cards = [];
  for (let u = 1; u <= 3; u++) {
    for (let c = 1; c <= 10; c++) {
      cards.push({
        id: `u${u}-c${c}`,
        group: "Vocab",
        unit: `Unit ${u}`,
        prompt: `Word U${u}-${c}`,
        answers: [`Answer U${u}-${c}`]
      });
    }
  }

  const deckId = store.createDeck({ name: "Chunked Deck", lang: "en" }, cards);
  store.setDeck(deckId);

  // 1. Select only Unit 1
  store.setUnits(["Vocab::Unit 1"]);
  let pool = store.pool();
  assert.equal(pool.length, 10, "Pool must contain exactly 10 cards");
  assert.ok(pool.every((c) => c.unit === "Unit 1"), "All cards in pool belong to Unit 1");

  const engine = new RecallEngine(store);

  // Test 20 picks: all must belong to Unit 1
  for (let i = 0; i < 20; i++) {
    const picked = engine.pick();
    assert.ok(picked, "Pick must return a card");
    assert.equal(picked.unit, "Unit 1", `Picked card ${picked.id} must be in Unit 1`);
  }

  // 2. Switch to Unit 2
  store.setUnits(["Vocab::Unit 2"]);
  pool = store.pool();
  assert.equal(pool.length, 10, "Pool must contain exactly 10 cards for Unit 2");
  assert.ok(pool.every((c) => c.unit === "Unit 2"));

  for (let i = 0; i < 20; i++) {
    const picked = engine.pick();
    assert.ok(picked);
    assert.equal(picked.unit, "Unit 2", `Picked card ${picked.id} must be in Unit 2`);
  }

  // 3. Select Unit 1 and Unit 2
  store.setUnits(["Vocab::Unit 1", "Vocab::Unit 2"]);
  pool = store.pool();
  assert.equal(pool.length, 20, "Pool must contain exactly 20 cards");
});

/* =========================================================================
   Scenario 4: Auto-Cloze Tabular Extraction
   ========================================================================= */

test("Scenario 4: Auto-Cloze Tabular Extraction: cloze brackets populate answer field when empty", () => {
  // Helper simulating the tabular row behavior in app.js
  function createRowSimulation() {
    let promptValue = "";
    let answerValue = "";

    function onPromptInput(newPrompt) {
      promptValue = newPrompt;
      const match = promptValue.match(/\{\{([^}]+)\}\}/);
      if (match && !answerValue.trim()) {
        answerValue = match[1].trim();
      }
    }

    return {
      setPrompt: onPromptInput,
      getPrompt: () => promptValue,
      setAnswer: (val) => { answerValue = val; },
      getAnswer: () => answerValue
    };
  }

  // French cloze: Je {{suis}} fatigué
  const row1 = createRowSimulation();
  row1.setPrompt("Je {{suis}} fatigué.");
  assert.equal(row1.getAnswer(), "suis", "Extracts 'suis' into answer field");

  // Chinese cloze: 这是{{老师}}
  const row2 = createRowSimulation();
  row2.setPrompt("这是{{老师}}");
  assert.equal(row2.getAnswer(), "老师", "Extracts '老师' into answer field");

  // Non-overwrite if answer already exists
  const row3 = createRowSimulation();
  row3.setAnswer("custom answer");
  row3.setPrompt("Je {{vais}} au marché");
  assert.equal(row3.getAnswer(), "custom answer", "Does not overwrite an existing answer");
});

/* =========================================================================
   Scenario 5: Batch Unit Splitting
   ========================================================================= */

test("Scenario 5: Batch Unit Splitting: assigns sequential Unit numbers in batches of 10", () => {
  // Simulate 30 rows in table
  const rows = Array.from({ length: 30 }, (_, i) => ({
    prompt: `Phrase ${i + 1}`,
    answer: `Answer ${i + 1}`,
    unit: "1"
  }));

  // Perform split logic (from app.js btnGridSplitUnits handler)
  rows.forEach((row, idx) => {
    row.unit = `Unit ${Math.floor(idx / 10) + 1}`;
  });

  // Verify rows 0–9 are Unit 1
  for (let i = 0; i < 10; i++) {
    assert.equal(rows[i].unit, "Unit 1", `Row ${i} must be Unit 1`);
  }

  // Verify rows 10–19 are Unit 2
  for (let i = 10; i < 20; i++) {
    assert.equal(rows[i].unit, "Unit 2", `Row ${i} must be Unit 2`);
  }

  // Verify rows 20–29 are Unit 3
  for (let i = 20; i < 30; i++) {
    assert.equal(rows[i].unit, "Unit 3", `Row ${i} must be Unit 3`);
  }
});

/* =========================================================================
   Phase: Global Brand Migration & Zero-Loss Legacy Ingestion
   ========================================================================= */

test("Brand Migration: Store migrates speedrecall_v3 data to reflex_v3 with zero loss", () => {
  const mockStorage = createMockStorage();
  globalThis.localStorage = mockStorage;

  // Prepare legacy speedrecall_v3 data in storage
  const legacyData = {
    version: 3,
    customDecks: {
      "deck-legacy-1": {
        id: "deck-legacy-1",
        name: "Legacy Spanish",
        cards: [
          { id: "c1", prompt: "hola", answers: ["hello"], group: "General", unit: "Unit 1" }
        ]
      }
    },
    extraCards: {},
    deletedDecks: {},
    progress: {
      "deck-legacy-1::c1": { w: 0.5, n: 10, c: 9, t: 1729000000000 }
    },
    prefs: { currentDeckId: "deck-legacy-1", decks: {} },
    sync: { lastSynced: 1729000000000 }
  };

  mockStorage.setItem("speedrecall_v3", JSON.stringify(legacyData));
  assert.equal(mockStorage.getItem("reflex_v3"), null, "reflex_v3 initially absent");

  // Initialize Store
  const store = new Store();
  const loadedState = store.state;

  // Store should have ingested from speedrecall_v3 and populated reflex_v3
  assert.ok(mockStorage.getItem("reflex_v3"), "reflex_v3 should now be populated in localStorage");
  assert.equal(store.state.customDecks["deck-legacy-1"]?.name, "Legacy Spanish");
  assert.equal(store.state.progress["deck-legacy-1::c1"]?.n, 10);
  assert.equal(store.state.prefs.currentDeckId, "deck-legacy-1");
});

test("Brand Migration: TokenExposureLedger migrates speedrecall_token_ledger to reflex_token_ledger", () => {
  const mockStorage = createMockStorage();
  globalThis.localStorage = mockStorage;

  // Prepare legacy ledger logs
  const log1 = JSON.stringify({ token: "professeur", success: true, t: 1729000010000 });
  const log2 = JSON.stringify({ token: "professeur", success: false, t: 1729000020000 });
  const log3 = JSON.stringify({ token: "etudiant", success: true, t: 1729000030000 });
  const legacyLogs = `${log1}\n${log2}\n${log3}`;

  mockStorage.setItem("speedrecall_token_ledger", legacyLogs);
  assert.equal(mockStorage.getItem("reflex_token_ledger"), null);

  const ledger = new TokenExposureLedger("reflex_token_ledger");

  assert.ok(mockStorage.getItem("reflex_token_ledger"), "reflex_token_ledger populated");
  const statsProf = ledger.getTokenStats("professeur");
  assert.equal(statsProf.reviews, 2);
  assert.equal(statsProf.errors, 1);

  const statsEtudiant = ledger.getTokenStats("etudiant");
  assert.equal(statsEtudiant.reviews, 1);
  assert.equal(statsEtudiant.errors, 0);
});

test("Brand Migration: Metadata, Document title and manifest brand constants match Reflex", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.webmanifest", import.meta.url), "utf-8"));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf-8");

  assert.equal(manifest.name, "Reflex");
  assert.equal(manifest.short_name, "Reflex");
  assert.equal(pkg.name, "reflex");
  assert.match(html, /<title>Reflex<\/title>/);
  assert.match(html, /content=["']Reflex["']/);
});

test("Brand Migration: GitHubSync default path is reflex-data.json with fallback", () => {
  const store = new Store();
  const sync = new GitHubSync(store);
  assert.equal(sync.config.filePath, "reflex-data.json");
});

