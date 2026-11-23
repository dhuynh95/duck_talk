/**
 * Where the relay reads and writes, now that it can be started from anywhere.
 *
 * Two directories, and what tells them apart is who wrote them:
 *
 *   PROJECT   the folder you ran `duck-talk` in — the repo Claude works in, and what
 *             scopes a Claude Code session, so it is also which chats the drawer shows.
 *   state()   `<PROJECT>/.duck-talk` — what the relay has learned about that folder:
 *             the corrections, the turn records, the prompts you edited from the
 *             phone, and one log per run.
 *
 * Nothing is kept beside the code any more, and both halves of that matter. Installed
 * by `npx` the code sits in a cache directory that is wiped between runs, so state
 * there would not survive the version bump that replaces it. And one relay serving
 * whichever folder you start it in has to keep one set of corrections per project
 * rather than one for its own copy — the way you say a name is a fact about the
 * project you are talking about.
 *
 * The prompts are the one thing with two homes: a default ships in the package, and
 * an edit lands in the project. See prompts.ts, which reads the second and falls back
 * to the first.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folder Claude works in: where you started the relay, unless told otherwise. */
export const PROJECT = (process.env['PROJECT_CWD'] ?? process.cwd()).replace(/(.)\/+$/, '$1');

const STATE = resolve(PROJECT, '.duck-talk');

/**
 * A path under the project's state directory.
 *
 * The directory is made on the way past rather than at startup, so it exists for the
 * file about to be used and nowhere else — and a folder you cannot write to fails on
 * that file, with the reason, instead of on the relay starting.
 */
export function state(...parts: string[]): string {
  if (!kept) keepOutOfGit();
  const path = resolve(STATE, ...parts);
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* the read or write below reports it */ }
  return path;
}

let kept = false;

/**
 * Once a process: the state directory holds the access key, and the logs hold it too,
 * so it must never be committed — and Claude Code, working in this very folder, may
 * well `git add -A`. A `.gitignore` of `*` inside it keeps the whole folder out of any
 * repo it sits in, with nothing to add to the project's own. Made closed to other users
 * when this is what makes it; one that was there keeps its mode, and its `.gitignore`
 * if it has one. Best-effort: a folder that cannot be written fails on the file that
 * was asked for, with the reason, not here.
 */
function keepOutOfGit(): void {
  kept = true;
  try { mkdirSync(STATE, { recursive: true, mode: 0o700 }); } catch { /* reported by the file asked for */ }
  try { writeFileSync(join(STATE, '.gitignore'), '*\n', { flag: 'wx' }); } catch { /* there already, or unwritable */ }
}

/** A file that ships with the relay — a default prompt. Read-only, and always there. */
export function packaged(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

/**
 * The published version, read from the package rather than written into the code.
 * One path works from both homes — `server/` and `dist/` sit at the same depth, which
 * is the reason the build flattens into `dist/` rather than nesting. It is also the
 * app's version: `app/dt gen` reads the same file, so a phone and a relay cut from one
 * release carry one number, and the relay says it to every data connection.
 */
export const VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(packaged('../package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown'; // running from somewhere that is neither, which is not a reason to stop
  }
})();
