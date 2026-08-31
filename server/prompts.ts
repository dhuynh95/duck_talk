/**
 * Everything the relay says to a model, as files you can edit from the phone.
 *
 * One registry, because a prompt is one concept however many models there are: the
 * voice style used to be a dotfile owned by voice.ts, Claude's a constant read once
 * at module load in claude.ts. Both are now entries below, and adding another is one
 * line here and nothing anywhere else — the phone renders what this sends.
 *
 * `live` is the only thing that makes them different, and it is a fact about the
 * relay rather than a preference: the voice style is re-read per sentence, so an edit
 * is audible on the next one; Claude's is fixed when `openClaude` builds its query,
 * because the SDK takes `systemPrompt` there and rebuilding per turn would throw away
 * the warm session. So a Claude edit reaches the next session, and the phone greys
 * the row out while one is running rather than making a promise it cannot keep.
 *
 * `title` and `detail` live here too, so the screen and the behaviour cannot drift
 * apart: the file that decides when a prompt takes effect is the file that says so.
 *
 *   node prompts.ts            list them
 *   node prompts.ts voice      print one
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packaged, state } from './paths.ts';

// A prompt has two homes: the wording that ships with the relay, and the one you
// edited for this project. An edit is a fact about the project, so it is written
// beside the project's other state and read in preference to the default — which is
// also what lets `npx duck-talk` start with sensible words and still be changed.

const PROMPTS = [
  {
    name: 'voice',
    file: 'voice.md',
    title: 'Voice',
    live: true,
    detail: 'Said before every sentence. There is no speed setting — the wording is it. Asking for a brisk pace is about 1.5× faster than leaving this empty; asking for a slow one is about 1.5× slower. Takes effect on the next sentence.',
  },
  {
    name: 'claude',
    file: 'claude.md',
    title: 'Claude',
    live: false,
    detail: 'How Claude answers: how long, in what tone, and what to do before it speaks. Remember it is being read aloud, not printed. Added to Claude Code’s own instructions rather than replacing them, so this is a way of speaking and not the whole brief. Fixed when a session starts, so it takes effect the next time you press listen.',
  },
] as const;

export type Name = (typeof PROMPTS)[number]['name'];

/** One prompt, as the phone sees it: what it is, when it takes effect, and its text. */
export interface Prompt {
  name: Name;
  title: string;
  detail: string;
  live: boolean;
  text: string;
}

/** The prompt as edited for this project, or — until it has been — the one that ships. */
export function read(name: Name): string {
  const { file } = entry(name);
  for (const at of [state('prompts', file), packaged(`./prompts/${file}`)]) {
    try {
      return readFileSync(at, 'utf8').trim();
    } catch {
      // not edited here, or — for the default — a package missing its own asset
    }
  }
  return '';
}

export function write(name: Name, text: string): void {
  writeFileSync(state('prompts', entry(name).file), `${text.trim()}\n`);
}

/** Every prompt, text included — the whole of what the phone's Prompts screen shows. */
export function all(): Prompt[] {
  return PROMPTS.map((p) => ({ name: p.name, title: p.title, detail: p.detail, live: p.live, text: read(p.name) }));
}

/** Whether a string off the wire names a prompt, so `write` can trust its argument. */
export function isName(value: unknown): value is Name {
  return typeof value === 'string' && PROMPTS.some((p) => p.name === value);
}

function entry(name: Name) {
  const found = PROMPTS.find((p) => p.name === name);
  if (!found) throw new Error(`no prompt named ${name}`);
  return found;
}

// --- CLI: run alone ---------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const asked = process.argv[2];
  if (asked) {
    if (!isName(asked)) { console.error(`no prompt named ${asked}`); process.exit(1); }
    console.log(read(asked));
  } else {
    for (const p of all()) {
      console.log(`${p.name}  (${p.live ? 'live' : 'fixed when a session starts'})  ${p.text.length} chars`);
      console.log(`  ${p.text.split('\n')[0]?.slice(0, 100) || '(empty)'}`);
    }
  }
}
