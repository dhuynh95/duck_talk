/**
 * What every turn did and when — the relay's own record of its work.
 *
 * One line of JSON per finished turn, in `.duck-talk/turns.jsonl`. The phone, this
 * relay and the test harness all run on one Mac, so every stamp here shares one clock
 * and any latency is a subtraction rather than a measurement. `app/sim.py` reads this
 * file to report what a spoken turn cost.
 *
 * It is also, without anything being added for it, the index from a past conversation
 * back to its audio: a turn holds the `instruction` Claude was sent — verbatim what
 * the transcript shows — beside the `clip` it was heard from. So `chats.ts` can put a
 * play button on a line you spoke last week, and nothing had to be written twice.
 *
 * `session.ts` fills a Turn in as it goes and appends it here; this file is where the
 * shape lives, so that the thing that writes the log and the thing that reads it agree
 * without either owning the other.
 */

import { appendFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { state } from './paths.ts';

export type Mode = 'direct' | 'review';

/** What one turn did and when, on this Mac's clock. */
export interface Turn {
  turn: number;
  mode: Mode;
  /** Which model answered this turn, and what it was allowed to do while answering.
   *  Both can be changed from the phone mid-conversation, so they belong to the turn
   *  rather than to the session — two turns of one chat can differ. Null for the model
   *  means whichever one the CLI defaults to. */
  model: string | null;
  permission: string;
  /** How hard the model thought while answering — one of the levels its ModelInfo
   *  offers. Null means the CLI's own default, same convention as `model`. */
  effort: string | null;
  /** The Claude session this turn belongs to — what groups turns into a chat, and
   *  what `?resume=` takes to carry one on. Null before Claude's first result. */
  session_id: string | null;
  heard: string;
  /** The audio `heard` was made from, as clips.ts files it. Null for a typed turn —
   *  nothing was heard. */
  clip: number | null;
  /** The pictures this instruction carried, as images.ts files them. Empty for a turn
   *  with none, which is most of them. */
  images: number[];
  proposed: string; // what Gemini's tool call asked for, before any correction
  corrected: string | null; // what auto-correct made of it, when on
  instruction: string; // what actually ran — corrected, or edited by the user
  approval: 'accepted' | 'rejected' | null;
  said: string;
  speech_end_at: number | null; // caller marked the moment its audio stopped (probe/app)
  /** The utterance's first committed text — when words first appeared on the phone's
   *  screen. With `speech_end_at` on the other side it brackets the utterance from
   *  both edges, which is as close to voice onset as this stack gets: Gemini offers
   *  no word timings (asked, probed), and a mic-side onset detector is a threshold
   *  this project does not build. */
  partial_first_at: number | null;
  partial_last_at: number | null; // last interim transcript before the final
  heard_at: number | null; // the utterance was finished — the instruction exists
  corrected_at: number | null; // auto-correct came back
  /** The instruction went to Claude. In review mode everything before this is a
   *  human deciding, which is not latency; timing Claude from here keeps the two apart. */
  ran_at: number | null;
  claude_start_at: number | null; // Claude opened its first block of the turn
  claude_opens: string | null; // and what it was: text, thinking, tool_use
  claude_first_at: number | null; // Claude's first token
  tts_sent_at: number | null; // first sentence handed to the voice model
  voice_out_at: number | null; // first reply byte written to the phone
  reply_in_at: number | null; // phone reported that byte arrived
  voice_ms: number; // reply audio sent, exact (24 kHz Int16 = 48 bytes/ms)
  /** Reply audio the phone's speaker actually played, when it fell short of what was
   *  sent — a route change took the queued buffers with it, or a barge-in dropped
   *  them. Null on an ordinary turn, and that is the normal case rather than a gap:
   *  the phone's report trails the last buffer by a beat, by which time the turn has
   *  already ended on its own arithmetic, so only a reply that stopped *early* gets
   *  here in time to be written down. Also null for a listener that cannot count —
   *  a typed turn, an older app, `probe.ts`. */
  heard_ms: number | null;
  /** What this turn cost, alone. The SDK reports what the whole session has cost so
   *  far, so claude.ts subtracts one result's total from the last — which is why a
   *  session's bill is the sum of its turns here, and why an interrupted turn, whose
   *  result nothing listens for, leaves its cost in no line at all. */
  cost_usd: number | null;
}

const file = () => state('turns.jsonl');

export async function append(t: Turn): Promise<void> {
  await appendFile(file(), `${JSON.stringify(t)}\n`);
}

/**
 * Which clip each instruction was heard from — the whole log read back as a lookup.
 *
 * Keyed by the instruction rather than by the session, and newest wins. Both follow
 * from what a fork is: a branched chat replays messages that were spoken under the
 * parent's `session_id`, so matching on the session would lose exactly the lines a
 * fork inherited, while matching on what was said finds them. Say the same sentence
 * twice and the later recording is the one offered, which is the one worth hearing.
 *
 * A typed turn has no clip and is skipped, so typing a sentence you once spoke does
 * not take its audio away.
 */
export function clips(): Map<string, number> {
  let text: string;
  try {
    text = readFileSync(file(), 'utf8');
  } catch {
    return new Map(); // no turns yet, which is the normal first-run state
  }
  const found = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line) as Turn;
      if (t.clip && t.instruction) found.set(t.instruction, t.clip);
    } catch {
      // a half-written line is not worth losing the rest of the file over
    }
  }
  return found;
}

/**
 * Which pictures each instruction carried — the same lookup as `clips`, for the other
 * kind of media, and keyed the same way and for the same reasons.
 *
 * One read of the file could answer both, and deliberately does not: a caller wanting
 * audio would then pay for images it never draws, and the two would have to agree on a
 * pair shape neither needs. Both are cheap, both are called once per chat opened.
 */
export function images(): Map<string, number[]> {
  let text: string;
  try {
    text = readFileSync(file(), 'utf8');
  } catch {
    return new Map(); // no turns yet, which is the normal first-run state
  }
  const found = new Map<string, number[]>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line) as Turn;
      if (t.images?.length && t.instruction) found.set(t.instruction, t.images);
    } catch {
      // a half-written line is not worth losing the rest of the file over
    }
  }
  return found;
}
