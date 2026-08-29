/**
 * What the speech-to-text keeps getting wrong, and what was meant instead.
 *
 * A pair is born when the user edits a held instruction in review mode: that edit
 * is the only evidence of what they actually said. Two things read them back —
 * `ears.ts` puts them in Gemini's system prompt, `correct.ts` uses them as few-shot
 * for a text model — so this file is the one store and the one wording.
 *
 * `heard` is what the ears produced, `meant` is what the user actually said, and
 * `proposed` is the wording that was on screen when they corrected it — the same as
 * `heard` for one added by hand. `at` is when it was learned, and doubles as its id.
 *
 * The file is the only copy. The phone edits it over a socket rather than keeping a
 * list of its own, so there is nothing to drift.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

export interface Correction {
  at: number;
  heard: string;
  proposed: string;
  meant: string;
}

const FILE = new URL('./.corrections.jsonl', import.meta.url).pathname;
const MAX = 50; // a prompt is not a database; keep the most recent lessons

/** Every correction learned so far, newest last, one per `heard` (a later edit wins). */
export function load(): Correction[] {
  let text: string;
  try {
    text = readFileSync(FILE, 'utf8');
  } catch {
    return []; // no corrections yet is the normal first-run state
  }
  const byHeard = new Map<string, Correction>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line) as Correction;
      if (c.heard && c.meant) byHeard.set(key(c.heard), c);
    } catch {
      // a half-written line is not worth losing the rest of the file over
    }
  }
  return [...byHeard.values()].slice(-MAX);
}

export function add(c: Correction): void {
  appendFileSync(FILE, `${JSON.stringify(c)}\n`);
}

/** Add one, or replace the one with the same `at`. */
export function save(c: Correction): void {
  const kept = all().filter((x) => x.at !== c.at);
  kept.push(c);
  rewrite(kept);
}

export function remove(at: number): void {
  rewrite(all().filter((c) => c.at !== at));
}

/** Every line as written, in order — what `load()` reads before it dedupes. */
function all(): Correction[] {
  let text: string;
  try {
    text = readFileSync(FILE, 'utf8');
  } catch {
    return [];
  }
  const out: Correction[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Correction); } catch { /* skip a torn line */ }
  }
  return out;
}

function rewrite(corrections: Correction[]): void {
  writeFileSync(FILE, corrections.map((c) => `${JSON.stringify(c)}\n`).join(''));
}

/** The block both consumers paste into a prompt. Empty string when nothing is known. */
export function render(corrections: Correction[]): string {
  if (!corrections.length) return '';
  const lines = corrections.map((c) => `- "${c.heard.trim()}" → "${c.meant.trim()}"`);
  return `\n\n<STT_CORRECTIONS>\nThe speech-to-text often mishears this user. When you hear the left, they mean the right:\n${lines.join('\n')}\n</STT_CORRECTIONS>\n`;
}

function key(heard: string): string {
  return heard.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
