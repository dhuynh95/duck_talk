/**
 * The relay's one gate: a key, because the relay is now reachable by more than the
 * phone in your hand.
 *
 * The iPhone app and the relay shared a trust that came from the network — a LAN, or
 * a tailnet — and a browser client makes that too little. A tailnet is shared, and
 * whoever can reach the port can run Claude Code in your project, so the relay
 * wants a secret from whoever connects, and `--open` is the explicit way to say you
 * do not.
 *
 * The key is made by the relay for itself rather than chosen by you: 128 random bits,
 * kept in a file beside the project's other state, so it survives a restart and a
 * bookmarked URL keeps working. `DUCK_TALK_KEY` overrides it for a relay run from a
 * service manager or a container, where a file is the wrong place for it.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The key this relay runs with: `DUCK_TALK_KEY` if set, else the one in `file`,
 * made on the first start. Both are trimmed — `DUCK_TALK_KEY=$(cat key)` and a pasted
 * line bring a newline the browser never sends — and one that is empty after that is
 * as good as none: a start cut short mid-write must not leave a relay whose key is the
 * empty string.
 */
export function loadKey(file: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['DUCK_TALK_KEY']?.trim();
  if (fromEnv) return fromEnv;

  let kept = '';
  try {
    kept = readFileSync(file, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // unreadable is not the same as new
  }
  if (kept) return kept;

  const key = randomBytes(16).toString('base64url');
  writeFileSync(file, key, { mode: 0o600 });
  chmodSync(file, 0o600); // `mode` only applies to a file this call created, and the key is a secret either way
  return key;
}

/**
 * Whether what a client supplied is the key. Constant-time, so the answer cannot be
 * got a character at a time from how long it takes — and it answers rather than
 * throws, because the other side of this is a stranger's query string: absent,
 * empty, or any length they like. `timingSafeEqual` throws on buffers of unequal
 * length, so that is settled first; the length of the key is not the secret.
 */
export function keyMatches(supplied: string | null | undefined, key: string): boolean {
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether the gate is deliberately off: `--open`, or `DUCK_TALK_OPEN=1` where a flag is awkward. */
export function isOpen(argv: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return argv.includes('--open') || env['DUCK_TALK_OPEN'] === '1';
}
