/**
 * js/importer.js — pasted text (TSV) and JSON backup files.
 *
 * One card per line, tab-separated (copying rows from a spreadsheet gives this):
 *   Prompt  Answer
 *   Unit    Prompt  Answer
 *   Group   Unit    Prompt  Answer
 *   Group   Unit    Prompt  Hint    Answer
 * Each card has exactly one answer. Lines starting with # are ignored.
 */

import { normalizeCard } from "./state.js";

export function parseTSV(text) {
  const cards = [];
  const errors = [];
  const stamp = Date.now().toString(36);
  let cleanText = String(text ?? "").normalize("NFC");
  if (cleanText.charCodeAt(0) === 0xFEFF) {
    cleanText = cleanText.slice(1);
  }
  cleanText.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith("#")) return;
    const cols = line.split("\t").map((c) => c.trim());
    let group = "Imported", unit = "Unit 1", prompt, subtitle = "", answer;
    if (cols.length >= 5) [group, unit, prompt, subtitle, answer] = cols;
    else if (cols.length === 4) [group, unit, prompt, answer] = cols;
    else if (cols.length === 3) [unit, prompt, answer] = cols;
    else if (cols.length === 2) [prompt, answer] = cols;
    else {
      errors.push(`Line ${i + 1}: needs at least a prompt and an answer, separated by a tab.`);
      return;
    }
    const card = normalizeCard({ id: `c-${stamp}-${i}`, group, unit, prompt, subtitle, answer });
    if (card) cards.push(card);
    else errors.push(`Line ${i + 1}: missing prompt or answer.`);
  });
  return { cards, errors };
}

export function readJSONFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        let content = reader.result;
        if (typeof content === "string") {
          content = content.normalize("NFC");
          if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
          }
        }
        resolve(JSON.parse(content));
      } catch (err) {
        reject(new Error(`That file isn't valid JSON (${err.message}).`));
      }
    };
    reader.onerror = () => reject(new Error("Couldn't read the file."));
    reader.readAsText(file, "UTF-8");
  });
}

export function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
