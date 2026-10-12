# Modular Deck Architecture, Scalable Repo Layout & Scenario Test Framework

A comprehensive architecture and validation plan establishing modular per-deck files (`decks/<deck-id>.json`), a clean repository structure, decoupled progress tracking (`progress.json`), and an end-to-end scenario testing framework to simulate real-world workflows before implementation.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The clarifying rounds confirmed four foundational design rules:
> 1. **Modular Per-Deck Files**: Decks are independent JSON files (`decks/<deck-id>.json`), indexed by a repository `decks/manifest.json`, exactly matching how scalable open-source repositories and GitHub Pages operate.
> 2. **Decoupled Progress File (`progress.json`)**: User learning statistics, spaced repetition weights, and attempt counts are stored separately from deck definitions. This keeps deck files clean, version-controllable, and shareable without exposing personal study data.
> 3. **Content-Hash Progress Resilience**: Spaced repetition stats link to deterministic card hashes (`hash(prompt + '::' + answers + '::' + hint)`). When a deck expands with new units or card IDs shift, existing progress is preserved 100%.
> 4. **Pre-Build Scenario Framework**: Before building UI components, an automated simulation framework validates real-world user scenarios (external git pulls, unit expansion, peer sharing, and offline backups).

---

## 1. Scalable Repository & File Architecture

Instead of dumping multiple decks into a single monolithic JSON blob, the system standardizes on a modular structure compatible with GitHub repositories, local folder backups, and GitHub Pages hosting:

```
repo-root/ (or export folder)
├── decks/
│   ├── manifest.json              # Catalog of all active decks in this repo
│   ├── hsk1-mandarin.json         # Standalone shareable deck definition
│   ├── hsk2-mandarin.json         # Standalone shareable deck definition
│   └── spanish-verbs.json         # Standalone shareable deck definition
└── progress.json                  # Private personal study statistics & timestamps
```

### File Schema Specifications

#### 1. Deck Definition: `decks/<deck-id>.json`
Clean, shareable, and strictly focused on content:
```json
{
  "id": "spanish-verbs",
  "name": "Spanish Essential Verbs",
  "lang": "es",
  "defaultMode": "standard",
  "frontField": "prompt",
  "backField": "answer",
  "updated": 1728740000000,
  "units": ["Present Regular", "Ser vs Estar", "Preterite"],
  "cards": [
    {
      "id": "sp-001",
      "prompt": "hablar",
      "answers": ["to speak", "speak"],
      "hint": "ar-verb",
      "unit": "Present Regular"
    }
  ]
}
```

#### 2. Deck Catalog: `decks/manifest.json`
Provides fast discovery without needing to load every individual deck file upfront:
```json
{
  "version": 1,
  "updated": 1728740000000,
  "decks": [
    {
      "id": "spanish-verbs",
      "name": "Spanish Essential Verbs",
      "file": "spanish-verbs.json",
      "cardCount": 45,
      "units": ["Present Regular", "Ser vs Estar", "Preterite"]
    }
  ]
}
```

#### 3. Personal Study Progress: `progress.json`
Completely decoupled from deck contents; maps both card ID and content hash to spaced repetition weights:
```json
{
  "app": "speedrecall",
  "version": 4,
  "updated": 1728740500000,
  "progress": {
    "spanish-verbs::sp-001": {
      "w": 0.42,
      "n": 12,
      "c": 11,
      "t": 1728740500000,
      "hash": "a1b2c3d4"
    }
  },
  "hashIndex": {
    "spanish-verbs::a1b2c3d4": "spanish-verbs::sp-001"
  },
  "prefs": {
    "currentDeckId": "spanish-verbs"
  }
}
```

---

## 2. Deck Management Framework & User Scenarios

To ensure friction-free workflows, we define 5 core real-world scenarios to model and test:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       REAL-WORLD USER SCENARIOS                             │
└─────────────────────────────────────────────────────────────────────────────┘

  Scenario 1: External Deck Growth & Typo Fix (Core Scenario)
  ───────────────────────────────────────────────────────────
  • Context: User is studying "HSK 2" daily. Mastery score is 85%.
  • External Change: Repo maintainer updates `hsk2-mandarin.json`:
    - Adds Unit 4 ("Travel & Hotel", 30 new cards).
    - Fixes typo in an existing card answer ("hotell" -> "hotel").
    - Card IDs in the file are re-indexed during formatting.
  • Expected Flow:
    1. User syncs or imports the new `hsk2-mandarin.json`.
    2. Unchanged cards retain their exact weights and review history.
    3. The typo-fixed card falls back to card ID or hash matching; history is migrated.
    4. 30 new cards initialize cleanly with default weight 1.0.
    5. Overall deck mastery adjusts proportionally without resetting to 0.

  Scenario 2: Peer Sharing (Single Deck Export)
  ─────────────────────────────────────────────
  • Context: Learner creates a custom deck "Medical Terminology".
  • Learner wants to give it to a study group friend.
  • Expected Flow:
    1. Learner clicks "Export Deck" on the Medical deck.
    2. Browser downloads `medical-terminology.json` (content only, zero personal stats).
    3. Friend clicks "Import Deck", selects `medical-terminology.json`.
    4. Deck is added to friend's library immediately; friend starts at 0% fresh progress.

  Scenario 3: Non-GitHub Local Library Backup & Restore
  ────────────────────────────────────────────────────
  • Context: User has 5 custom decks and no GitHub account.
  • Expected Flow:
    1. In Settings > Local Backup, user clicks "Download Full Archive".
    2. Generates a clean bundle containing all deck JSONs + `progress.json`.
    3. User visits app on another device/browser and drops the file into Restore.
    4. Diff preview appears: "Found 5 decks, 420 cards, 180 practice records".
    5. User confirms -> 100% library and progress restored.

  Scenario 4: Multi-Device GitHub Repo Sync
  ─────────────────────────────────────────
  • Context: User configures GitHub sync with repo `user/speedrecall-decks`.
  • Expected Flow:
    1. App reads `decks/manifest.json` and loads available remote decks.
    2. Sync writes updated decks to `decks/<id>.json` and study history to `progress.json`.
    3. User practices on mobile -> pushes commit -> pulls on desktop seamlessly.
    4. Git diffs remain tiny and human-readable (clean per-deck JSON commits).

  Scenario 5: Archiving / Deleting a Deck
  ──────────────────────────────────────
  • Context: User finishes a course and wants to remove the deck from active practice.
  • Expected Flow:
    1. User can choose: "Archive Deck" (hide from practice) or "Delete Deck".
    2. Deleting marks a tombstone in `progress.json` to prevent zombie resurrection
       during remote sync.
```

---

## 3. Settings Hub & Deck Options UX Architecture

The Settings modal is reorganized into a 4-tab segmented layout, replacing the single long form:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SETTINGS MODAL LAYOUT                             │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  [ 📚 Decks ]    [ 💾 Local Storage ]    [ 🐙 GitHub ]    [ ⚙️ Options ] │
  └─────────────────────────────────────────────────────────────────────────┘

  [TAB 1: DECKS]
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ Active: HSK 1 Mandarin (150 cards · 3 units · 78% mastered)             │
  │                                                                         │
  │ • Quick Actions: [Edit Cards] [Export .json] [Duplicate] [Delete]       │
  │ • Import Cards: Paste spreadsheet rows (Tab / CSV) directly into deck   │
  │ • Installed Decks List: Cards count, last studied date, quick toggle    │
  │ • [+ Create New Deck]                                                   │
  └─────────────────────────────────────────────────────────────────────────┘

  [TAB 2: LOCAL STORAGE]
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ Manage your data on this device without requiring GitHub.               │
  │                                                                         │
  │ • Library Summary: 4 custom decks · 340 cards · 192 study records       │
  │ • [Download Library Backup] (Decks + Progress)                          │
  │ • [Export Selected Deck JSON] (Content only, perfect for sharing)      │
  │ • Restore: Drop any .json deck or full backup here                      │
  │   └── Preview inspection before applying (no accidental overwrites)     │
  │ • [Reset Progress] (Keep decks, reset learning scores to zero)          │
  └─────────────────────────────────────────────────────────────────────────┘

  [TAB 3: GITHUB SYNC]
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ Keep your decks and progress in sync across devices using GitHub.       │
  │                                                                         │
  │ • Repository: [ owner/repo-name ]   Decks Folder: [ decks/ ]            │
  │ • Personal Access Token: [ ******************** ]                       │
  │ • [Test Connection] -> "✓ Connected to owner/repo-name (Branch: main)"  │
  │ • Last Synced: 12 minutes ago · [Sync Now]                              │
  │ • Sync Strategy: Merges newer card reviews; never deletes uncommitted  │
  └─────────────────────────────────────────────────────────────────────────┘

  [TAB 4: PRACTICE OPTIONS]
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ • Default Field Roles: Front [Target Language] / Back [Native Language] │
  │ • Show Hints & Subtitles by default: [x]                                │
  │ • Pinyin Tone Strictness: [Normal]                                      │
  └─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Technical Implementation & Data Strategy

### Progress Resilience Engine
1. **Hash Generation**:
   ```javascript
   export function cardContentHash(card) {
     const p = (card.prompt || "").trim().toLowerCase();
     const a = (card.answers || []).map(s => s.trim().toLowerCase()).sort().join("|");
     const h = (card.hint || card.subtitle || "").trim().toLowerCase();
     return hashString(`${p}:::${a}:::${h}`);
   }
   ```
2. **Dual-Key Lookup**:
   When evaluating mastery or retrieving card spaced repetition weight:
   - Primary: Check `progress[`${deckId}::${card.id}`]`.
   - Secondary (fallback): If not found, check `progress[`${deckId}::hash::${card.hash}`]`.
   - On match, auto-link to current card ID so future accesses are instantaneous.
3. **External Sync Merge**:
   - Remote deck content updates overwrite or union cards cleanly.
   - Remote progress records merge using maximum timestamp rule (`record.t > local.t`).

---

## 5. Phased Execution Roadmap

### Phase 1: Scenario Testing Framework (`tests/deck_evolution_scenarios.test.mjs`)
- Construct automated test cases for all 5 identified scenarios:
  1. External deck file updated with new units & typo fixes -> verify progress retention.
  2. Single deck export/import -> verify clean separation of progress from content.
  3. Hash migration -> verify card ID renumbering preserves mastery.
  4. Repository manifest indexing -> verify dynamic deck listing.
  5. Deletion tombstone resolution -> verify no zombie decks on sync.

### Phase 2: Modular Deck & Storage Engine (`js/state.js`, `js/importer.js`)
- Add support for per-deck file export (`exportDeck(id)`) and full library backup.
- Implement content hash indexer and auto-migration in `Store`.
- Update deck importer to support single deck JSON files, multi-deck manifests, and tab-separated rows.

### Phase 3: GitHub Multi-File Sync Engine (`js/github-sync.js`)
- Support syncing to structured `decks/<id>.json`, `decks/manifest.json`, and `progress.json`.
- Add "Test Connection" method that verifies token validity and repo access permissions.

### Phase 4: Tabbed Settings UI Redesign (`index.html`, `js/app.js`, CSS)
- Implement clean tabbed navigation in Settings modal.
- Connect per-deck export and import preview.
- Add connection tester and visual status states.
- Run complete test suite and compilation verification.
