# SpeedRecall

Rapid-fire flashcard drilling for any language, in the style of DJT Kana. One prompt, one definite answer, type it and the next card appears the instant you're right.

Plain HTML, CSS and JavaScript modules. No build step: push to GitHub Pages and it runs.

## How a drill works

- **Type the answer.** The card advances the moment your input matches. No Enter needed.
- **Don't know it?** Press **Enter** (or tap **Reveal**). The answer is shown and you must type it correctly to move on. That counts as a miss and the card comes back more often.
- **Pick what to drill** from the deck button at the top. Choices are remembered per deck. Each unit tile shows how well you know it.

Cards you miss are weighted up, and cards you know are weighted down. Weights drift back toward neutral over about a week, so old cards come back for review.

## Answer checking

Each card has **one** canonical answer. Checking never accepts a different word; it only forgives how you type the right one.

| Mode | Latin-script answers | Pinyin decks |
| --- | --- | --- |
| Accents optional / Tones required (default) | `ete` = `été`, `jai` = `j'ai`, case and spaces ignored | `ni3hao3` or `nǐhǎo`; neutral tone optional; `v` or `ü` |
| Tones optional | — | `nihao` |
| Accents required / Exact spelling | `été` only | exactly as written |

Arabic vowel marks and Hebrew niqqud are optional in the default mode. Japanese dakuten are never ignored (`か` ≠ `が`).

## Deck files

Built-in decks live in `data/` and are listed in `data/manifest.json`:

```json
{
  "defaultDeckId": "zh-hsk1",
  "decks": [{ "id": "zh-hsk1", "file": "./data/zh-hsk1.json" }]
}
```

A deck file:

```json
{
  "name": "Mandarin · HSK 1 vocabulary",
  "lang": "zh-CN",
  "answerLang": "zh-Latn-pinyin",
  "romanization": "pinyin",
  "defaultMode": "standard",
  "cards": [
    { "id": "hsk1-001", "group": "Words 1–50", "unit": "1–10", "prompt": "我", "subtitle": "I", "answer": "wo3" }
  ]
}
```

- `lang` is the language of the prompts. It sets fonts, screen-reader pronunciation and text direction (RTL for `ar`, `he`, `fa`, `ur`).
- `romanization: "pinyin"` turns on tone-aware checking.
- `subtitle` is the hint under the prompt. Use it to point to the one intended answer when a word could mean several things (e.g. `est` → "être · il/elle").
- **Keep card `id`s stable.** Progress is stored by deck id and card id, so edits to a card's text keep its history, and a renamed id starts fresh.

Edit or add deck files and push. Users get the new content the next time they open the app; their progress and their own cards are never overwritten.

## Your own cards

**Settings → Add cards** accepts rows pasted from a spreadsheet (tab-separated):

```
Prompt  Answer
Group   Unit    Prompt  Hint    Answer
```

Add them to the current deck or create a new deck with its own language.

## Cloze sentences & Anki compatibility

Sentences with cloze gaps are automatically drilled as fill-in-the-blank cards:

```
Je {{suis}} fatigué.                      → answer "suis"
Je {{suis::être}} fatigué.                → same, with hint "être"
Hier, j'{{ai}} {{mangé}} une pomme.       → two cards: one per gap, other gap filled in
```

- **Anki exports supported**: Accepts `{{c1::word}}`, `{{c1::word::hint}}`, and `{{c2::...}}`. HTML tags like `<br>` and `<b>` are scrubbed on import.
- **Live gap typing**: What you type appears directly inside the underlined slot in the sentence.
- **Reverse mode (`⇄`)**: Toggles between recognition (French → English) and production (English → French). Cloze cards remain target-sentence completions.

## In-app deck editor

- Tap **Practice → Edit deck** or **+ New deck** to open the fast spreadsheet table.
- **Keyboard speed**: Type prompt, `Tab` to answer, `Enter` to create the next row. Cloze sentences auto-fill the answer and hint columns.
- **Split into units of 10**: Auto-groups lists into DJT-style chunks (`1–10`, `11–20`).
- **Publish to site**: Set your site repository write token in Settings to publish decks directly to `data/<deck>.json` and `data/manifest.json`.

## Sync and backup

- **Sync with GitHub:** one button. It pulls `speedrecall-data.json` from a repo you own, merges it with this device, and pushes the result. Merging never deletes cards, and for each card the most recent practice wins. Use a fine-grained token limited to that one repo with *Contents: read and write*. The token is stored only in the browser.
- **Download backup / Restore from file:** the same data as a JSON file. Restoring merges rather than replaces.

## Offline

A service worker caches the app and decks. It opens instantly from cache and refreshes in the background, so a new deploy is picked up on the next launch.

## Tests

```sh
node --test tests/*.test.mjs
```

Covers answer matching, cloze parsing, Anki compatibility, unit chunking, reverse mode, and built-in cards.
