/**
 * The audio of one utterance, exactly as the ears heard it.
 *
 * A clip is the slice of microphone stream that produced one transcript — same bytes,
 * same order, nothing resampled. That is the whole point: a correction made against a
 * remembered sentence is a guess, and a correction made while listening to what was
 * actually sent is evidence. The phone plays these; `corrections.ts` points at them.
 *
 * A clip's id is the moment the utterance finished, which is `Turn.heard_at` — already
 * stamped, already unique, already in the turn record. So nothing here invents an id
 * and nothing has to look one up.
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

// A clip nothing points at is a debugging aid with a short life; one a correction was
// taught from is part of that correction and outlives everything. So retention is not
// a number of days, it is: keep what is referenced, plus enough recent ones to fix a
// mishearing you noticed a minute ago.
const KEEP_RECENT = 20;

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
 * Drop clips nothing refers to, keeping the most recent few regardless.
 *
 * Called on every save rather than on a timer: the moment a clip is written is the
 * moment the set changed, and there is no daemon here to run a timer anyway.
 */
function prune(): void {
  const keep = new Set<string>();
  for (const c of loadCorrections()) if (c.clip) keep.add(`${c.clip}.wav`);
  let names: string[];
  try {
    names = readdirSync(state('utterances', '.')).filter((n) => n.endsWith('.wav'));
  } catch {
    return; // nothing written yet, which is the normal first-run state
  }
  // Newest last, so the tail is what a "fix that" a minute later still finds.
  const loose = names.filter((n) => !keep.has(n)).sort();
  for (const name of loose.slice(0, Math.max(0, loose.length - KEEP_RECENT))) {
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
