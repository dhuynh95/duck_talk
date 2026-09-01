/**
 * The pictures that came with an instruction.
 *
 * A clip is the audio an utterance was heard from; an image is what you were looking at
 * when you said it. Same shape, and deliberately so: the id is the moment it was picked,
 * the id is the filename, and nothing keeps an index — `turns.jsonl` already records
 * which ids a turn carried, so `chats.ts` can put a thumbnail on a line from last week
 * the same way it puts a play button on one you spoke.
 *
 * Two things differ from clips.ts, and both are the point.
 *
 * Always JPEG. The phone caps the long edge before sending, because the model downsamples
 * past ~1568px anyway — resolution is the knob that matters and the codec is not. One
 * format means one extension here, one `media_type` in claude.ts, and nothing to
 * negotiate on the wire.
 *
 * Nothing is pruned. A clip is evidence for a correction and ages out once no correction
 * points at it; a picture is part of what was said, and a chat reopened in a month should
 * still show it. The turn log it is indexed by is never trimmed either, so this is the
 * same stance in both files rather than a second rule.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { state } from './paths.ts';

const file = (id: number) => state('images', `${id}.jpg`);

/** Keep this picture under the id the phone minted for it. */
export function save(jpeg: Buffer, id: number): void {
  writeFileSync(file(id), jpeg);
}

/** One picture, or null when there is no such file — which the phone draws as a gap
 *  rather than an error, the same way a pruned clip reads as "no audio". */
export function read(id: number): Buffer | null {
  try {
    return readFileSync(file(id));
  } catch {
    return null;
  }
}
