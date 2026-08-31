/**
 * The audio of one utterance, exactly as the ears heard it.
 *
 * A clip is the slice of microphone stream that produced one transcript — same bytes,
 * same order, nothing resampled. That is the whole point: a correction made against a
 * remembered sentence is a guess, and a correction made while listening to what was
 * actually sent is evidence. The phone plays these; `corrections.ts` points at them.
 *
 * A clip's id is the moment the utterance finished — unique, orderable, and the same
 * number the turn record and any correction born from it carry. So the id is also the
 * filename, and nothing has to keep an index.
 *
 * How long one lives is one rule: a clip a correction points at is part of that
 * correction and stays; every other clip lives a week. The whole correction store is
 * asked, not the window a prompt gets — see `load` in corrections.ts.
 *
 * Written as a WAV rather than raw PCM because the one consumer is a phone that plays
 * it: 44 bytes of header is what turns "some bytes" into something AVAudioPlayer opens
 * with no format agreed anywhere.
 */

import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { state } from './paths.ts';
import { load as loadCorrections } from './corrections.ts';

/** The format the ears listen in — see ears.ts, which declares it to Gemini. */
const RATE = 16_000;

// A clip a correction was taught from is part of that correction and outlives
// everything. Every other clip lives a week — long enough to reopen a conversation
// from the other day and fix what it misheard, which is when you notice.
//
// Days rather than a count, because days is the unit the question is asked in, and
// because the id already is the moment it was recorded: a clip's age is read off its
// own name, so nothing here has to stat a file or sort a directory. At ~140 KB an
// utterance a week is tens of megabytes, and it stays there.
const KEEP_DAYS = 7;

const file = (id: number) => state('utterances', `${id}.wav`);

/** Keep this utterance, and forget the ones nothing needs any more. */
export function save(pcm: Buffer, id: number): void {
  writeFileSync(file(id), wav(pcm));
  prune();
}

/** One clip, or null when it has been pruned — which the phone treats as "no audio". */
export function read(id: number): Buffer | null {
  try {
    return readFileSync(file(id));
  } catch {
    return null;
  }
}

/**
 * Forget the clips that are neither spoken for nor recent.
 *
 * Called on every save rather than on a timer: the moment a clip is written is the
 * moment the set changed, and there is no daemon here to run a timer anyway.
 */
function prune(): void {
  const keep = new Set<string>();
  for (const c of loadCorrections()) if (c.clip) keep.add(`${c.clip}.wav`);
  let names: string[];
  try {
    names = readdirSync(state('utterances', '.'));
  } catch {
    return; // nothing written yet, which is the normal first-run state
  }
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const name of names) {
    if (!name.endsWith('.wav') || keep.has(name)) continue;
    if (Number(name.slice(0, -4)) >= cutoff) continue;
    try { unlinkSync(state('utterances', name)); } catch { /* already gone, which is the goal */ }
  }
}

/** 16 kHz mono Int16 PCM with the 44-byte header that makes it a file. */
export function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM header length
  header.writeUInt16LE(1, 20); // uncompressed
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // bytes per frame
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
