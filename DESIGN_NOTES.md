# SpeedRecall — Architecture, Design Notes & Reference Log

This document serves as the running, authoritative technical reference for SpeedRecall's architectural decisions, UX/UI interaction patterns, data contracts, accessibility standards, and known trade-offs.

---

## 1. Executive Architectural Blueprint

SpeedRecall is a client-side, zero-latency progressive web application (PWA) engineered for high-frequency vocabulary and sentence recall drills across diverse writing systems (CJK ideographs, tonal diacritic Latin scripts, Arabic abjads, and heavily contracted European languages).

### System Topology

```
+---------------------------------------------------------------------------------------+
|                                    UI Layer (DOM)                                     |
|  - "Play First" Home Hub (#homeHub)       - Stage Container (#stage, #card)           |
|  - 5 Route Modifiers (body.dataset.route) - Safety Lock Glyph & Radial SVG (#safety)  |
|  - Milestone Celebration Modal (#modal)   - Inline Cloze Injection (.cloze-blank)     |
+---------------------------------------------------------------------------------------+
                                           │
                                           ▼
+---------------------------------------------------------------------------------------+
|                                  Controllers & Engine                                 |
|  - RouteController (js/routes.js): Manages cognitive route state & IME buffers        |
|  - RecallEngine (js/engine.js): Reactive drill loop, stumble queue, card roulette     |
|  - AudioController (js/audio.js): 3-tier audio cascade (WebAudio -> TTS -> Silence)   |
+---------------------------------------------------------------------------------------+
                                           │
                                           ▼
+---------------------------------------------------------------------------------------+
|                                Pedagogical Core & Logic                               |
|  - Normalizer (js/normalizer.js): Multi-tier diacritic, tone & alias resolution      |
|  - Cloze Engine (js/cloze.js): Lexical tokenization, punctuation isolation, blanks    |
|  - State & Ledger (js/state.js): TokenExposureLedger, Store, local/cloud sync payloads|
+---------------------------------------------------------------------------------------+
                                           │
                                           ▼
+---------------------------------------------------------------------------------------+
|                                Storage & Manifest Data                                |
|  - LocalStorage: speedrecall_v3 (progress, prefs), speedrecall_token_ledger (log)     |
|  - Static Decks (data/*.json): 11 curated manifests & unified archetype datasets     |
|  - Service Worker (sw.js): Stale-while-revalidate offline asset caching               |
+---------------------------------------------------------------------------------------+
```

---

## 2. Architectural & Design Decisions

### 2.1 Multi-Tier Phonetic & Orthographic Normalization (`normalizer.js`)
* **Decision:** Decoupled string evaluation into a layered fast-path evaluation cascade rather than a single monolithic regex or distance metric.
  1. *Fast-Path ASCII / Case Match:* Checks `candTrimmed.toLowerCase() === inputLower` with a fast non-ASCII detector (`toNFC`) that bypasses expensive V8 ICU normalization for plain Latin text.
  2. *Canonical Normalization (NFC vs. NFD):* Harmonizes precomposed and decomposed Unicode glyphs (e.g., Yorùbá sub-dots `ọ`, `ẹ`, `ṣ` and French accents `é`, `è`, `ê`).
  3. *Speed / Lenient Mode:* Strips combining diacritical marks (`[\u0300-\u036f]`), permitting rapid reflex typing without mobile keyboard accent menus (e.g., `oluko` matches `olùkọ́`, `eleve` matches `élève`).
  4. *Strict Mode:* Mandates exact accents and diacritics; rejects stripped strings.
  5. *Pinyin Romanization:* Distinguishes tone numbers (`lao3shi1`) from visual tone marks (`lǎoshī`) and optional neutral tones.
* **Trade-off Accepted:** Memory caching vs. Garbage Collection. Created bounded `Map` caches (`ANSWER_KEY_CACHE`, `LATIN_CACHE`, `PINYIN_CACHE`, max 1,000–2,000 entries) to guarantee evaluation throughput under $10\text{ms}$ per 1,000 evaluations while strictly guarding against memory exhaustion.

### 2.2 Dual-Syntax Cloze Tokenization & Inline Metric Isolation (`cloze.js`)
* **Decision:** Supported both legacy bracketed cloze (`{{c1::word::hint}}`) and modern space-delimited lexical sentences (`"我 是 老师 。"`) through a unified token structure.
* **Punctuation Isolation:** Tokenizer separates leading and trailing punctuation (`splitPunctuation`) so that sentence-ending marks (`。`, `？`, `!`, `.`, `,`) do not attach to target blanks.
* **Space-Collapsing Native Rendering:** Languages tagged with CJK language codes collapse interstitial token spaces in Native View (`renderNativeText("我 是 老师 。", "zh-CN")` $\to$ `"我是老师。"`), while space-separated scripts (French, English, Yorùbá) preserve word boundaries.
* **Inline Cloze Input Width Metrics (Latin `ch` vs. CJK `em`):**
  - Rigid bounding widths calculated by `calculateInputWidth(targetText, options)` to achieve CLS = 0.
  - *Latin Scripts:* Font-relative `ch` units: `(Math.max(3, len) + 1.2).toFixed(2) + "ch"` with `min-width: 3ch`.
  - *CJK Ideographs:* Full-width ideographic `em` units: `Math.max(2, cjkChars * 1.15 + nonCjkChars * 0.6 + 0.5).toFixed(2) + "em"` with `min-width: 2em`.
  - Elements receive `data-script="cjk|latin"` and classes `.cloze-input--cjk` / `.cloze-input--latin` for targeted CSS normalization.
* **Trade-off Accepted:** Requiring authors to space-delimit multi-token Chinese sentences (`"我 是 老师 。"`) avoids requiring heavy client-side dictionary segmentation libraries (e.g., Jieba WebAssembly, which would inflate bundle size by $>1\text{MB}$).

### 2.3 Dynamic Token Exposure Ledger (`state.js`)
* **Decision:** Implemented a fine-grained `TokenExposureLedger` running on an append-only transaction model in `localStorage`.
* **Selection Algorithm:**
  - Identifies targetable content tokens.
  - Excludes predefined and language-specific stop words (`STOP_WORDS`).
  - Prioritizes unsaturated tokens (`reviews < saturationLimit = 5`), tie-breaking on highest historical stumble count.
  - Saturated Fallback: Selects the token with the oldest `lastSeen` timestamp if all candidate tokens have been mastered.
* **Target Resolution Priority:** In `generateCloze`, priority is strictly ordered:
  1. Explicit legacy syntax (`{{c1::...}}`)
  2. Explicit `options.targetIndex`
  3. Explicit `options.target` string
  4. Dynamic `options.ledger.getLeastDrilledToken(...)`
  5. Static `card.answer` fallback
  6. First targetable token fallback

### 2.4 Five Specialized Cognitive Interaction Routes (`routes.js`)
* **Route 1: Reflex Sprint (`Routes.REFLEX`)**
  - Instant prefix-free auto-advancement on character match.
  - Borderless staging, ambient dark charcoal canvas.
  - 150ms lateral nudge animation (`lateralNudge`) on mistyping; warm amber/slate miss reveal.
  - 220ms visual accent flash transition contract (`@keyframes accentFlash`) providing visual reinforcement within the 200–250ms threshold.
* **Route 2: Contextual Cloze (`Routes.CONTEXT_CLOZE`)**
  - Static sentence cloze with fluid typography `clamp(1.25rem, 3.5vw, 2rem)` and line-height $2.0$.
  - Inline input blank with dynamic sizing ($\min 3\text{ch}$) and zero cumulative layout shift (CLS = 0).
* **Route 3: Variable Cloze (`Routes.VARIABLE_CLOZE`)**
  - Dynamic token blank rotation driven by `TokenExposureLedger` to prevent rote sentence memorization.
* **Route 4: Sensory Flash / Kid Mode (`Routes.SENSORY_FLASH`)**
  - Edge-to-edge canvas with total chrome suppression (`topbar`, `stats`, `helpLine` hidden or set to `inert`).
  - Virtual keyboard suppressed (`input.disabled = true`, `input.blur()`).
  - Screen Wake Lock API (`navigator.wakeLock.request("screen")`) active to prevent mobile sleep.
  - 2.0s hold-to-unlock radial indicator (`#safetyLockGlyph`) with instant cancellation on pointer interruption.
  - Lower 2/3 tap-anywhere advancement with $\ge 200\text{ms}$ tap debouncing.
* **Route 5: Native IME Production (`Routes.STRICT_PRODUCTION`)**
  - Explicit IME composition shielding: listens to `compositionstart`, `compositionupdate`, and `compositionend`.
  - Disables prefix-free auto-advance while composing Japanese Kanji or Chinese Hanzi in the OS input buffer.
  - Enforces explicit Enter keydown submission with visual `#imeCommitIndicator` ("⏎ Enter to submit").

### 2.5 Three-Tier Lookahead Audio Pipeline (`audio.js`)
* **Decision:** Implemented a resilient cascade architecture:
  - **Tier 1 (Web Audio API):** Pre-fetches and decodes audio into memory for mounted card $N$ and lookahead cards $N+1, N+2, N+3$.
  - **Tier 2 (SpeechSynthesis API):** Falls back to native speech synthesis if audio URL is absent or fails, mapped by BCP-47 language tag.
  - **Tier 3 (Graceful Silence):** If speech synthesis errors or language tag is unsupported (`xx-ZZ`), cleanly resolves `{ status: "silence", mode: "fallback" }` without throwing unhandled promise rejections or freezing pacing timers.
* **Stumble-Recycled Buffer Retention Lifecycle:**
  - When a card is missed or stumbled, it is marked via `audio.retainStumbled(card)`.
  - Normal lookahead queue preloading strictly evicts cards that drop out of the $[N+1, N+2, N+3]$ window to avoid memory leaks.
  - Stumble-recycled cards in `retainedStumbleIds` bypass eviction and remain fully decoded in `bufferMap` until explicitly cleared via `audio.clearStumbled(card)` upon a successful review.
* **Memory Management:** `preloadQueue()` cleans up all unneeded buffers while preserving active, lookahead, and retained stumble cards.

### 2.6 Encoding Integrity, Data Sanitization & Unicode Enforcement
* **Document Head Declaration:** In `index.html`, `<meta charset="utf-8">` is strictly declared as the initial element of `<head>` within the first 1024 bytes as mandated by the HTML5 specification to eliminate browser heuristic encoding misinterpretation.
* **Data Pipeline Sanitization:**
  - *TSV Import Pipeline (`importer.js`):* Strips UTF-8 Byte Order Marks (`0xFEFF`) from pasted clipboard or spreadsheet data and normalizes text to Unicode NFC before tokenization.
  - *JSON File Pipeline (`importer.js`):* Forces explicit `"UTF-8"` decoding parameter on `FileReader.readAsText()` and normalizes JSON payloads to NFC.
  - *Export Pipeline (`importer.js`):* Explicitly tags MIME type as `application/json;charset=utf-8` on downloadable `Blob` objects.
  - *Deck Metadata (`state.js`):* Sanitizes deck titles, prompt labels, and language identifiers through `.normalize("NFC")`.
  - *Base64 Sync Pipeline (`github-sync.js`):* Uses native `TextEncoder` / `TextDecoder` for strictly UTF-8 compliant binary transfers.
* **Canonical Fixture Quality Gates:**
  - Automated tests verify zero BOM headers (`\xEF\xBB\xBF`) and zero replacement characters (`\uFFFD`) across all doc and deck files.
  - Algorithmic double-encoded detection (`isDoubleEncoded`) checks every string field across all sample decks (`test-zh-sprint.json`, `test-zh-cloze.json`, `test-yo-tonal.json`, `test-fr-elision.json`).
  - Test fixtures assert against actual canonical Unicode strings (e.g. `"老师"`, `"lǎoshī"`, `"olùkọ́"`, `"ẹwà"`, `"fenêtre"`, `"forêt"`) rather than double-encoded characters.

### 2.7 Cloze & Input Interface Consolidation (Dual-Input Elimination & Punctuation Gap Fixes)
* **Elimination of Dual Inputs:** In Cloze drilling (Route 2: Sentence Cloze, Route 3: Grammar Gym, or whenever `card.cloze` is active via `.has-cloze`), the bottom action row (`.answer-row`), `#answerInput`, `#btnReveal`, and `#helpLine` are completely suppressed with `display: none !important`.
* **Single Active Input Context:** The inline sentence blank (`inlineInput`) serves as the sole active text input. All keystrokes, composition events, corrections (`.is-correcting`), give-up triggers (Enter key), and lateral nudges are routed directly through `inlineInput`.
* **Punctuation Attachment & Space Elimination:**
  - Tokenization isolates standalone punctuation marks (e.g. `.` or `,`), tagging them with `isPunct: true`.
  - DOM rendering tags punctuation elements with `.cloze-token--punct` and preceding tokens with `.cloze-token--before-punct`.
  - CSS strictly zeroes out margins between preceding words and punctuation: `.cloze-token--punct { margin-left: 0 !important; }` and `.cloze-token--before-punct, .cloze-token:has(+ .cloze-token--punct) { margin-right: 0 !important; }`, completely resolving detached punctuation gaps (e.g. `à l'école .` $\to$ `à l'école.`).
* **Scoped Cloze Typography & Viewport Anchoring:**
  - Dedicated rule `.card__prompt[data-size="cloze"]` enforces `line-height: 2.2`, `max-width: 820px`, and `font-size: clamp(1.25rem, 3.5vw, 1.95rem)`.
  - Cloze stages are anchored to the upper 40–50% of the viewport (`justify-content: flex-start; padding-top: max(24px, 8vh);`), preventing virtual keyboard overlap and line-wrap thrashing.

### 2.8 Reflex Engine Restoration (Route 1 Speed Sprint)
* **Distraction-Free Surface:** Borderless, transparent card container (`border: none; background: transparent; box-shadow: none;`).
* **Clutter Suppression:** Manual reveal button (`.reveal-button`), secondary instructions (`.help-line`), and success/error badges (`.card__badge`) are completely suppressed with `display: none !important`.
* **Rapid-Fire Cadence:** The input target is styled as a minimal underline typing zone (`border-bottom: 2px solid var(--accent)`), maintaining permanent focus, synchronous prefix-free auto-advance, and transient 220ms visual reinforcement flashes (`@keyframes accentPulseFlash`).

### 2.9 Pedagogical Mode Humanization & Deck Compatibility Gating
* **Humanized Identifiers:** Replaced internal developer and route codenames with user-centric pedagogical names:
  - `reflex` $\to$ **Speed Sprint**
  - `contextual-cloze` $\to$ **Sentence Cloze**
  - `variable-cloze` $\to$ **Grammar Gym**
  - `sensory-flash` $\to$ **Audio Flashcards**
  - `strict-production` $\to$ **Native Typing**
* **Archetype Compatibility Gating (`routesForDeck`):**
  - `isNativeTypingCompatible(deck)` determines whether a deck involves ideographic or complex non-Latin scripts (Hanzi, Kana, Hangul, Arabic, Cyrillic) or explicit Pinyin checking.
  - Romanized/Latin decks (French, Yoruba, Spanish, English) strictly exclude `Native Typing (IME)` from selection to avoid redundant manual Enter submit badges.
  - Automatic Incompatible Route Fallback: When a user switches to a Latin deck while Native Typing is active, the engine automatically falls back to **Speed Sprint**.
* **Cold-Launch Flow:** The app opens directly to the Home Hub (`#homeHub`) with `#stage` hidden. Tapping the Quick Resume Hero card executes a seamless 1-tap transition into active drilling in $<2$ interactions.

### 2.10 Sensory Mode Polish (Route 4 Audio Flashcards)
* **Animation Restart on Card Transition:** Fixed CSS animation freezing on `.pacing-countdown-bar__fill` by forcing DOM reflow (`fill.style.animation = "none"; void fill.offsetWidth; fill.style.animation = "";`) upon every `card-mounted` event.
* **Tactile Affordance Hint Pill:** Added a visually centered tactile affordance badge (`.sensory-tap-surface__hint`) to `.sensory-tap-surface` with an upward cue arrow (`.sensory-tap-surface__cue`) and a subtle 3s pulsing animation (`@keyframes sensoryHintPulse`), instructing learners: *"Tap anywhere to reveal / advance"*.

---

## 3. UI/UX & Component Behavior

### 3.1 "Play First" Home Hub & Cold-Launch Flow
* **Sub-Two-Tap Path to Value:** Cold launch opens the Home Hub (`#homeHub`) featuring a high-contrast **Quick Resume Hero Card** (`#quickResumeHero`).
  - Tapping the hero immediately resumes the most recently drilled deck and mode in $\le 1$ to 2 taps.
  - Secondary grid provides 1-tap entry into all installed decks.
  - "Custom Setup" button surfaces the configuration sheet for advanced filtering.

### 3.2 Responsive Sizing & Thumb-Zone Ergonomics
* **Viewport Containment:** Root containers use `100dvh` (dynamic viewport height) and `viewport-fit=cover` to eliminate scroll chaining on mobile browsers.
* **Safe-Area Insets:** Anchored interactive controls enforce `padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0px))` to prevent collision with iOS home bars.
* **Keyboard Clearance:** Media query `@media (max-height: 560px)` accommodates simulated 300px software keyboards on 640px displays by collapsing padding, preserving unobstructed line-of-sight to the prompt and input.
* **WCAG 2.2 Target Sizing:** All touch targets outside full-screen tap mode enforce $\ge 48 \times 48\text{px}$ bounding boxes (`.icon-button`, `.deck-button`, `.reveal-button`, `.hero-card__cta`, `.safety-lock-glyph`).

### 3.3 State Handling Matrix
| Component / Route | Default State | Active / Drilling State | Error / Miss State | Disabled / Locked State |
| :--- | :--- | :--- | :--- | :--- |
| **Stage Card (`#card`)** | Clean surface, badge hidden | Borderless or bordered per route | `.is-miss`, 150ms lateral nudge, answer reveal | `.locked-stage` (Route 4 Sensory) |
| **Answer Row (`.answer-row`)** | Clean input, reveal active | Typing, auto-advances on match | Input clears, `.is-correcting` styling | Hidden in Cloze & Sensory modes |
| **Inline Cloze (`.cloze-input`)** | Focused inline blank | Typing, auto-advances on match | Clears input, `.is-correcting` styling | Blurred on sheet open |
| **Safety Lock (`#safetyLockGlyph`)** | Static lock glyph (Route 4) | Radial SVG fills over 2000ms | Releases early: resets to 0% | Hidden in Routes 1, 2, 3, 5 |
| **Sensory Tap Surface (`#sensoryTapSurface`)** | Centered tactile hint pill | Tap reveals answer; next tap advances | N/A | Hidden in Routes 1, 2, 3, 5 |
| **Home Hub (`#homeHub`)** | Visible on cold launch/home | Hidden when drill starts | N/A | Inert during active drill |
| **Milestone Modal (`#milestoneModal`)** | Hidden dialog | Pops every 15 consecutive clears | N/A | Modal focus trap; Enter/Space clears |

### 3.4 Multi-Script Typography & Palette
* **Theme Surfaces:** Dark charcoal background (`#161618`), card layer (`#1E1E22`), light text (`#F4F4F5`), muted text (`#A1A1AA`), success emerald (`#10B981`), amber miss (`#F59E0B`).
* **Font Fallback Stack:** Prioritizes CJK ideographs, Yorùbá combining marks, and Latin script rendering:
  `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", "Noto Sans CJK SC", "Noto Sans Arabic", sans-serif`.

---

## 4. API & Data Flow Contracts

### 4.1 Unified Card Schema
Every card record across production and test datasets validates against the following contract:

```typescript
interface Card {
  id: string;               // Unique, human-readable ID (e.g., "test-zh-001", "test-yo-005")
  script: string | null;    // Non-Latin orthography (Hanzi, Kana, Arabic); null for Latin scripts
  phonetic: string;         // Mandatory Romanized transcription or native pronunciation
  gloss: string;            // Mandatory translation or meaning in source language
  prompt: string;           // Derived or explicit drill prompt text
  answer: string;           // Primary target string for single-string evaluation
  answers?: string[];       // Optional array of primary valid target strings
  subtitle?: string;        // Subtitle / semantic hint displayed under the card prompt
  aliases: string[];        // Array of acceptable synonym / romanization variants (>= 30% coverage)
  lang: string;             // Valid BCP-47 tag (e.g., "zh-CN", "fr-FR", "yo-NG", "ja-JP")
  audio: string | null;     // Data URI ("data:audio/wav;base64,..."), relative path, or null
  group?: string;           // Deck taxonomy group (e.g., "Tonal Vocabulary")
  unit?: string;            // Deck taxonomy unit (e.g., "Unit 1")
  isCloze?: boolean;        // Flags sentence for automatic cloze target generation
}
```

### 4.2 Local Storage & State Payload (`state.js`)
* **State Schema Version:** 3
* **Keys:**
  - `speedrecall_v3`: Snapshot of custom decks, progress records (`${deckId}::${cardId} -> { w, n, c, t }`), deleted deck tombstones, and per-deck preferences.
  - `speedrecall_token_ledger`: Newline-delimited JSON transaction log for token exposures:
    `{"token": "laoshi", "success": true, "t": 1729272000000}`.

---

## 5. Verification Suite & Quality Gates

The test architecture consists of 10 hermetic test suites executed via Node.js native test runner (`node --test tests/*.test.mjs`), ensuring zero test cross-contamination:

| Test Suite | Tests | Verification Scope |
| :--- | :---: | :--- |
| `tests/datasets.test.mjs` | **17** | Unified schema validation, global ID uniqueness, Unicode NFC enforcement, $\ge 30\%$ alias coverage, Chinese space-collapsing, Yorùbá speed vs. strict diacritics, French elisions, 3-tier audio decoding & silent fallback, dynamic blank rotation, legacy backward compatibility, HTML document UTF-8 `<head>` declaration, canonical Unicode fixture enforcement (zero BOM/mojibake). |
| `tests/decks.test.mjs` | **11** | Manifest answerability across all 11 built-in and test decks in STANDARD and STRICT modes. |
| `tests/visual.test.mjs` | **13** | Dynamic 100dvh viewport, 300px keyboard clearance, CLS = 0, font fallback alignment, safe-area padding, $\ge 48\text{px}$ targets, chrome suppression, radial hold-to-unlock, quick resume $\le 2$ taps, Route 1 Sprint clutter suppression, sensory tap surface tactile affordance. |
| `tests/normalizer.test.mjs` | **17** | NFC/NFD equivalence, speed diacritic stripping, strict rejection, Pinyin tone suffix parsing, alias resolution, $<10\text{ms}$ / 1,000 evaluations throughput benchmark. |
| `tests/lockdown.test.mjs` | **11** | Sensory route isolation, virtual keyboard suppression, 2.0s hold cancellation, touch interruption resilience, 200ms tap debounce, wake lock API. |
| `tests/routes.test.mjs` | **14** | Unmount teardown, timer cancellation, focus restoration, IME composition shielding, explicit Enter submission in Route 5, humanized route identifiers, deck archetype compatibility gating, routesForDeck filtering, incompatible route switching fallback. |
| `tests/cloze.test.mjs` | **12** | Dynamic blank alignment, multi-word token replacement, punctuation isolation, Chinese vs. Latin space rendering, Latin `ch` vs. CJK `em` inline width calculation, punctuation gap elimination (.cloze-token--punct), dual-input elimination (answer-row suppression), scoped cloze typography. |
| `tests/scaffolding.test.mjs` | **14** | Deck verification, alias coverage, tone parsing, lookahead pre-fetch, cascade fallback, token ledger frequency-capping. |
| `tests/audio.test.mjs` | **4** | Audio lookahead queue, 3-tier cascade fallback, buffer release memory management, stumble-recycled buffer retention lifecycle. |
| `tests/integration.test.mjs` | **1** | State immutability and sync isolation during 50-card continuous drill sprints. |
| **Total** | **114** | **100% Passing (0 failures, 0 skipped, 0 cancelled)** |

---

## 6. Open Questions, Trade-offs & Future Refactoring Debt

1. **Client-Side Segmenter vs. Explicit Whitespace:**
   - *Current State:* Chinese sentence cloze decks require spaces between words (`"我 是 老师 。"`), which are collapsed in Native View.
   - *Future Enhancement:* Evaluate a lightweight Intl.Segmenter (`Intl.Segmenter("zh", { granularity: "word" })`) fallback for unsegmented Chinese text where browser support permits, while retaining explicit whitespace for custom token boundaries.
2. **Audio Asset Hosting & Storage Quotas:**
   - *Current State:* Embedded Base64 clips are restricted to $<2\text{KB}$ mono WAVs to prevent repository bloat; production decks rely on relative assets or Web Speech synthesis.
   - *Future Enhancement:* Implement an IndexedDB blob store for user-recorded audio clips to avoid `localStorage` 5MB quota exhaustion.
3. **PWA Background Sync:**
   - *Current State:* Stale-while-revalidate caching works completely offline via `sw.js`. Progress synchronization is triggered manually or upon network availability.
   - *Future Enhancement:* Integrate Background Sync API (`SyncManager`) to queue GitHub sync commits when recovering from offline drill sessions.

