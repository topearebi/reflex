/**
 * js/cloze.js — cloze sentence parser, Anki syntax compatibility, and card expansion.
 *
 * Anki syntax supported:
 *   {{answer}}
 *   {{answer::hint}}
 *   {{c1::answer}}
 *   {{c1::answer::hint}}
 *   {{c2::answer}}
 *
 * Splitting rule:
 *   A sentence with multiple gaps becomes one card per gap.
 *   On each card, the non-target gaps are filled in with their answers.
 */

/** Strips HTML tags, Anki media references, and decodes common entities. */
export function cleanAnkiHtml(str) {
  if (!str) return "";
  return String(str)
    // Remove Anki sound and image tags
    .replace(/\[sound:[^\]]+\]/gi, "")
    .replace(/\[image:[^\]]+\]/gi, "")
    // Replace breaks and paragraphs with a space
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div)>/gi, " ")
    // Strip all remaining HTML tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    // Collapse excess whitespace
    .replace(/\s+/g, " ")
    .trim();
}

const CLOZE_REGEX = /\{\{(?:c\d+::)?(.*?)\}\}/;
const CLOZE_GLOBAL_REGEX = /\{\{(?:c(\d+)::)?(.*?)\}\}/g;

/** Returns true if the string contains cloze markers. */
export function hasCloze(str) {
  return typeof str === "string" && CLOZE_REGEX.test(str);
}

/**
 * Parses all cloze gaps from a prompt.
 * Returns array of { match, ankiNum, answer, hint, start, end }
 */
export function parseClozeGaps(prompt) {
  if (typeof prompt !== "string") return [];
  const gaps = [];
  let m;
  const re = new RegExp(CLOZE_GLOBAL_REGEX);
  while ((m = re.exec(prompt)) !== null) {
    const rawContent = m[2] || "";
    const parts = rawContent.split("::");
    const answer = (parts[0] || "").trim();
    const hint = parts.slice(1).join("::").trim();
    if (answer) {
      gaps.push({
        fullMatch: m[0],
        ankiNum: m[1] ? Number(m[1]) : null,
        answer,
        hint,
        start: m.index,
        end: m.index + m[0].length
      });
    }
  }
  return gaps;
}

/**
 * Automatically extracts the first cloze answer and hint from a prompt.
 * Used by the deck editor when authoring.
 */
export function autoExtractCloze(prompt) {
  const gaps = parseClozeGaps(prompt);
  if (!gaps.length) return null;
  return {
    answers: gaps.map((g) => g.answer),
    primaryAnswer: gaps[0].answer,
    primaryHint: gaps[0].hint || ""
  };
}

/**
 * Expands a source card containing cloze gaps into individual drill cards.
 * If there are multiple gaps, creates one card per gap with other gaps filled in.
 * If there are no cloze gaps, returns [card].
 */
export function expandClozeCard(card) {
  if (!card || !hasCloze(card.prompt)) return [card];
  const gaps = parseClozeGaps(card.prompt);
  if (!gaps.length) return [card];

  return gaps.map((targetGap, i) => {
    // Build sentence where target gap is represented as {{answer::hint}},
    // and all other gaps are replaced with their filled-in answers.
    let cursor = 0;
    let sentence = "";
    let prefix = "";
    let suffix = "";

    for (let j = 0; j < gaps.length; j++) {
      const g = gaps[j];
      const preceding = card.prompt.slice(cursor, g.start);
      sentence += preceding;

      if (j === i) {
        prefix = sentence;
        sentence += `{{${g.answer}${g.hint ? "::" + g.hint : ""}}}`;
      } else {
        sentence += g.answer;
      }
      cursor = g.end;
    }
    const remainder = card.prompt.slice(cursor);
    sentence += remainder;
    suffix = card.prompt.slice(targetGap.end);

    // If other gaps were after targetGap, they need to be resolved in suffix too
    let suffixResolved = "";
    let sCursor = targetGap.end;
    for (let j = i + 1; j < gaps.length; j++) {
      const g = gaps[j];
      suffixResolved += card.prompt.slice(sCursor, g.start) + g.answer;
      sCursor = g.end;
    }
    suffixResolved += card.prompt.slice(sCursor);

    // Build subtitle / hint
    const hintParts = [];
    if (targetGap.hint) hintParts.push(targetGap.hint);
    if (card.subtitle) hintParts.push(card.subtitle);

    return {
      id: gaps.length > 1 ? `${card.id}-c${i + 1}` : `${card.id}-c1`,
      sourceId: card.id,
      group: card.group || "General",
      unit: card.unit || "General",
      prompt: sentence,
      answers: [targetGap.answer],
      subtitle: hintParts.join(" · "),
      isCloze: true,
      clozeIndex: i,
      clozeTotal: gaps.length,
      clozeData: {
        prefix,
        answer: targetGap.answer,
        hint: targetGap.hint,
        suffix: suffixResolved,
        fullSentence: card.prompt.replace(CLOZE_GLOBAL_REGEX, (_, __, content) => content.split("::")[0].trim())
      }
    };
  });
}

/**
 * Automatically chunks an array of cards into DJT-style units of 10.
 * Updates the `unit` field of each card to "1–10", "11–20", etc.
 */
export function chunkCardsIntoUnits(cards, chunkSize = 10) {
  const size = Math.max(1, chunkSize);
  return cards.map((card, i) => {
    const chunkIndex = Math.floor(i / size);
    const start = chunkIndex * size + 1;
    const end = (chunkIndex + 1) * size;
    return {
      ...card,
      unit: `${start}–${end}`
    };
  });
}
