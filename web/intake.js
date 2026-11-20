// @ts-check
// Everything that puts something on the list of what the next instruction will carry — a picture
// from the camera, the library or the clipboard, or a text too long for the field — and the
// person told, in words, what is going on. The bytes are converted by attach.js and kept by the
// session; this is the queue between them: one file at a time (a phone photo is tens of megabytes
// decoded), each under an id of its own, a bad file costing only itself.
//
// No page is touched here: `status` is how it speaks and `convert` how it converts, so a test can
// play both.

import { mintId, toJpegBase64 } from './attach.js';

/** The last id given, for the page's life: ids must not repeat, whoever asked. */
let lastId = 0;

const FALLBACK = 'That picture could not be added.';

/** @typedef {Pick<import('./session.js').VoiceSession, 'attach'>} Holder */
/** What it says: `busy` is a line while it works (null when it stops), `error` is why something was not added. @typedef {{ busy: (text: string | null) => void, error: (text: string) => void }} Status */

/**
 * @param {{
 *   session: Holder,
 *   status: Status,
 *   convert?: (blob: Blob) => Promise<string>,
 *   now?: () => number,
 * }} deps
 * @returns {{ addFiles: (files: Iterable<Blob>) => Promise<void>, addPaste: (text: string) => void }}
 */
export function createIntake({ session, status, convert = toJpegBase64, now = Date.now }) {
  const mint = () => (lastId = mintId(lastId, now()));
  /** Batches run one after another: a second call waits for the first. @type {Promise<void>} */
  let queue = Promise.resolve();

  /** @param {Blob[]} files */
  async function run(files) {
    /** @type {string[]} */
    const failures = [];
    for (const [i, file] of files.entries()) {
      status.busy(files.length > 1 ? `Processing ${i + 1} of ${files.length}…` : 'Processing…');
      try {
        const data = await convert(file);
        session.attach({ id: mint(), data });
      } catch (e) {
        failures.push(e instanceof Error ? e.message : FALLBACK);
      }
    }
    status.busy(null);
    const first = failures[0];
    if (first === undefined) return;
    status.error(files.length > 1 ? `${failures.length} of ${files.length} files could not be added. ${first}` : first);
  }

  return {
    /** Convert each file to a picture and attach it, one at a time, in order. Resolves when all are done. */
    addFiles(files) {
      const batch = [...files];
      if (batch.length === 0) return queue;
      const done = queue.then(() => run(batch));
      queue = done.catch(() => {}); // a batch that breaks must not break the ones behind it
      return done;
    },
    /** Attach a text whole. @param {string} text */
    addPaste(text) {
      session.attach({ id: mint(), text });
    },
  };
}
