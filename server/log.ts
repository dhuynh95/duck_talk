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
 */

import { createWriteStream, readdirSync, unlinkSync } from 'node:fs';
import { state } from './paths.ts';

const KEEP_DAYS = 7;

/** Start keeping the terminal, and forget the logs nothing needs any more.
 *  Returns the file's path, so the startup lines can say where the terminal went. */
export function openLog(): string {
  prune();
  const path = state('logs', `${stamp(new Date())}.log`);
  const file = createWriteStream(path, { flags: 'a' });
  for (const stream of [process.stdout, process.stderr] as const) {
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      file.write(chunk);
      return write(chunk, ...rest);
    }) as typeof stream.write;
  }
  return path;
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

function prune(): void {
  let names: string[];
  try {
    names = readdirSync(state('logs', '.'));
  } catch {
    return; // nothing logged yet, which is the normal first-run state
  }
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const name of names) {
    const at = born(name);
    if (at === null || at >= cutoff) continue;
    try { unlinkSync(state('logs', name)); } catch { /* already gone, which is the goal */ }
  }
}
