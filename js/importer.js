/**
 * js/importer.js — pasted text (TSV/Anki) and JSON backup files.
 *
 * Supports:
 *   Prompt  Answer
 *   Prompt  Answer  Hint  Unit
 *   Unit    Prompt  Answer
 *   Group   Unit    Prompt  Answer
 *   Group   Unit    Prompt  Hint    Answer
 *   Anki cloze lines: {{c1::answer}} with automatic HTML cleaning.
 */

import { normalizeCard } from "./state.js";
import { cleanAnkiHtml, hasCloze, autoExtractCloze } from "./cloze.js";

export function parseTSV(text) {
  const cards = [];
  const errors = [];
  const stamp = Date.now().toString(36);

  text.split(/\r?\n/).forEach((rawLine, i) => {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    // Split columns and clean Anki HTML from each
    const cols = rawLine.split("\t").map((c) => cleanAnkiHtml(c.trim()));

    // Skip common header row if detected
    if (i === 0 && (cols[0]?.toLowerCase() === "prompt" || cols[0]?.toLowerCase() === "front")) {
      return;
    }

    let group = "Imported";
    let unit = "Unit 1";
    let prompt = "";
    let subtitle = "";
    let answer = "";

    if (cols.length >= 5) {
      [group, unit, prompt, subtitle, answer] = cols;
    } else if (cols.length === 4) {
      // Prompt, Answer, Hint, Unit OR Group, Unit, Prompt, Answer
      if (hasCloze(cols[0]) || cols[3].length <= 15) {
        [prompt, answer, subtitle, unit] = cols;
      } else {
        [group, unit, prompt, answer] = cols;
      }
    } else if (cols.length === 3) {
      if (hasCloze(cols[0])) {
        [prompt, subtitle, unit] = cols;
      } else {
        [unit, prompt, answer] = cols;
      }
    } else if (cols.length === 2) {
      if (hasCloze(cols[0])) {
        prompt = cols[0];
        subtitle = cols[1];
      } else {
        [prompt, answer] = cols;
      }
    } else if (cols.length === 1 && hasCloze(cols[0])) {
      // Anki single cloze field export
      prompt = cols[0];
    } else {
      errors.push(`Line ${i + 1}: needs at least a prompt and an answer, separated by a tab.`);
      return;
    }

    // Auto-resolve cloze prompt if answer is missing
    if (hasCloze(prompt)) {
      const cloze = autoExtractCloze(prompt);
      if (cloze) {
        if (!answer) answer = cloze.primaryAnswer;
        if (!subtitle && cloze.primaryHint) subtitle = cloze.primaryHint;
      }
    }

    const card = normalizeCard({ id: `c-${stamp}-${i}`, group, unit, prompt, subtitle, answer });
    if (card) {
      cards.push(card);
    } else {
      errors.push(`Line ${i + 1}: missing prompt or answer.`);
    }
  });

  return { cards, errors };
}

/**
 * Parses pasted text into tabular row structures for the Deck Editor.
 * Returns array of { prompt, answer, hint, unit }.
 */
export function parseRowsForEditor(text) {
  const rows = [];
  text.split(/\r?\n/).forEach((rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const cols = rawLine.split("\t").map((c) => cleanAnkiHtml(c.trim()));

    // Skip header row
    if (cols[0]?.toLowerCase() === "prompt" || cols[0]?.toLowerCase() === "front") return;

    let prompt = "";
    let answer = "";
    let hint = "";
    let unit = "1";

    if (cols.length >= 4) {
      [prompt, answer, hint, unit] = cols;
    } else if (cols.length === 3) {
      if (hasCloze(cols[0])) {
        [prompt, hint, unit] = cols;
      } else {
        [prompt, answer, hint] = cols;
      }
    } else if (cols.length === 2) {
      if (hasCloze(cols[0])) {
        prompt = cols[0];
        hint = cols[1];
      } else {
        [prompt, answer] = cols;
      }
    } else if (cols.length === 1) {
      prompt = cols[0];
    }

    if (hasCloze(prompt)) {
      const cloze = autoExtractCloze(prompt);
      if (cloze) {
        if (!answer) answer = cloze.primaryAnswer;
        if (!hint && cloze.primaryHint) hint = cloze.primaryHint;
      }
    }

    if (prompt || answer) {
      rows.push({ prompt, answer, hint, unit: unit || "1" });
    }
  });
  return rows;
}

export function readJSONFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(reader.result));
      } catch (err) {
        reject(new Error(`That file isn't valid JSON (${err.message}).`));
      }
    };
    reader.onerror = () => reject(new Error("Couldn't read the file."));
    reader.readAsText(file);
  });
}

export function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
