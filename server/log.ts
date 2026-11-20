/**
 * The terminal, kept: everything the relay prints, teed into one file per start.
 *
 * There is no logging API and nothing threaded through the modules. The relay
 * already narrates itself completely to stdout and stderr — the startup lines, each
 * connection's `[id]` lines, the turn summaries, the uncaught handlers — so the file
 * is made by intercepting the two streams once, here, rather than by teaching every
 * `log()` a second destination. What the file holds is exactly what the terminal
 * showed, and the two can never disagree.
 *
 * One file per start, named by the moment it started — readable, sortable, and
 * parseable back, so a log's age is read off its own name and retention needs no
 * index: opening today's file is when the week-old ones go. The same decisions
 * clips.ts made, for the same reasons, and the same week.
 *
 * What the terminal shows includes the access key — the startup rows print the
 * address with it — so the file is the owner's alone, like `.duck-talk/key` is, and
 * so is the folder when this is what makes it.
 */

import { chmodSync, createWriteStream, fchmodSync, mkdirSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { state } from './paths.ts';

const KEEP_DAYS = 7;

/** Start keeping the terminal, and forget the logs nothing needs any more.
 *  Returns the file's path, so the startup lines can say where the terminal went.
 *  `tighten` is how the file is closed to other users, handed in so a test can make it fail. */
export function openLog(tighten: typeof fchmodSync = fchmodSync): string {
  const dir = logsDir();
  prune(dir);
  const path = state('logs', `${stamp(new Date())}.log`);
  // Opened here rather than by the stream, which opens in the background: the file is there, and
  // closed to everyone else, before anything is written to it. `mode` only applies to a file this
  // call makes, and one left by an earlier start of the same second needs closing too.
  const fd = openSync(path, 'a', 0o600); // a real problem (a folder that cannot be written) stops the start, as it always did
  // A filesystem that will not change modes (exFAT, some network mounts) or a file that is someone
  // else's refuses this. The relay still starts: a file made here is 0600 already.
  let untightened: unknown = null;
  try { tighten(fd, 0o600); } catch (err) { untightened = err; }
  const file = createWriteStream(path, { fd });
  for (const stream of [process.stdout, process.stderr] as const) {
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      file.write(chunk);
      return write(chunk, ...rest);
    }) as typeof stream.write;
  }
  // Said once the tee is in, so that the log says it too.
  if (untightened !== null) console.error(`could not tighten the log file's permissions: ${untightened instanceof Error ? untightened.message : String(untightened)}`);
  return path;
}

/** The folder the logs live in, closed to other users if this is what makes it. One that was there is not ours to change. */
function logsDir(): string {
  const dir = state('logs', '.'); // makes `.duck-talk`, which is the one `mkdir` below needs
  try { mkdirSync(dir, { mode: 0o700 }); } catch { /* there already, or the open that follows says why not */ }
  return dir;
}

/** `2026-09-01_14-30-05` — the moment, in local time, as a filename. */
function stamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}_${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}`;
}

/** The moment back out of the name, or null for a file that is not one of ours. */
function born(name: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.log$/.exec(name);
  return m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).getTime() : null;
}

/** Forget the logs nothing needs any more, and close the ones kept: an earlier start's carry the same key. */
function prune(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // nothing logged yet, which is the normal first-run state
  }
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const name of names) {
    const at = born(name);
    if (at === null) continue;
    const old = join(dir, name);
    if (at >= cutoff) {
      try { chmodSync(old, 0o600); } catch { /* not ours to close, or gone */ }
      continue;
    }
    try { unlinkSync(old); } catch { /* already gone, which is the goal */ }
  }
}
