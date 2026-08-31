/**
 * What the speech-to-text keeps getting wrong, and what was meant instead.
 *
 * A pair is born when the user edits a held instruction in review mode: that edit
 * is the only evidence of what they actually said. Two things read them back, and
 * both renderings live here so a correction has one meaning: `terms` is the words
 * `ears.ts` biases the recogniser towards, `render` is the block `correct.ts` shows a
 * text model.
 *
 * `heard` is what the ears produced, `meant` is what the user actually said, and
 * `proposed` is the wording that was on screen when they corrected it — the same as
 * `heard` for one added by hand. `at` is when it was learned, and doubles as its id.
 *
 * `clip` points at the audio it was taught from — see clips.ts, which keeps the file
 * and decides when one may go. A correction made by hand has none, and one whose clip
 * has been pruned reads the same way: the pair is the correction, the sound is
 * evidence for it.
 *
 * The file is the only copy. The phone edits it over a socket rather than keeping a
 * list of its own, so there is nothing to drift.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { state } from './paths.ts';

export interface Correction {
  at: number;
  heard: string;
  proposed: string;
  meant: string;
  /** The utterance this was taught from, as clips.ts files it. Set here, this is also
   *  what keeps that audio from being pruned. */
  clip?: number;
}

/** One file per project, under the folder the relay was started in — see paths.ts. */
const file = () => state('corrections.jsonl');

/**
 * Every correction learned so far, newest last, one per `heard` (a later edit wins).
 *
 * All of them, because everything that is not a prompt wants all of them: the phone
 * lists them to delete one, and clips.ts asks which audio is still spoken for. Only a
 * prompt has a size limit, and that limit lives in `render` — where the prompt is.
 */
export function load(): Correction[] {
  let text: string;
  try {
    text = readFileSync(file(), 'utf8');
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
  return [...byHeard.values()];
}

export function add(c: Correction): void {
  appendFileSync(file(), `${JSON.stringify(c)}\n`);
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
    text = readFileSync(file(), 'utf8');
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
  writeFileSync(file(), corrections.map((c) => `${JSON.stringify(c)}\n`).join(''));
}

// A prompt is not a database. The store keeps every lesson; this many of the most
// recent ones is what a model is told about, and the cap belongs here rather than in
// `load` — where it also quietly shortened the phone's list and the set of clips that
// count as spoken for.
const MAX = 50;

/** The block both consumers paste into a prompt. Empty string when nothing is known. */
export function render(corrections: Correction[]): string {
  if (!corrections.length) return '';
  const lines = corrections.slice(-MAX).map((c) => `- "${c.heard.trim()}" → "${c.meant.trim()}"`);
  return `\n\n<STT_CORRECTIONS>\nThe speech-to-text often mishears this user. When you hear the left, they mean the right:\n${lines.join('\n')}\n</STT_CORRECTIONS>\n`;
}

/**
 * What to bias the recogniser towards: each sentence as the user said it was.
 *
 * Whole sentences, not the words inside them. Sending only the words that differ from
 * `heard` is the obvious refinement and it measured worse — 83% against 100% — because
 * a term the ears happened to get right in the utterance that taught the correction
 * never enters the list, and is then missed everywhere else. The extra words cost
 * nothing: a hundred phrases bias just as well when only a few are relevant.
 */
export function terms(corrections: Correction[]): string[] {
  const out = new Set<string>();
  for (const c of corrections) if (c.meant.trim()) out.add(c.meant.trim());
  return [...out].slice(-100); // the docs put the useful ceiling around here
}

function key(heard: string): string {
  return heard.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
