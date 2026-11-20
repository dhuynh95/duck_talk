// @ts-check
// What the next instruction will carry, in the composer, until it is sent: a picture as a small
// square, a pasted text as a chip with its opening words, each with a button that takes it back.
// `AttachThumb` in Attachment.swift, with the same family as what a sent line wears (pieces.js).
//
// The row is drawn from the store's `attached`, which the session owns: it changes only when
// something is attached, dropped or sent, so a chip is built once and kept, and the store being
// written 25 times a second for the microphone costs nothing here. Nothing a chip says is markup:
// a text is set as text, and the one URL made from data is `data:image/jpeg;base64,…` around what
// attach.js produced.
//
// Removing a chip does not always take the attachment back. While a socket is open the relay
// already holds it — it went out when the chip was made — and has no frame to let go of it, so the
// next turn is still given it. The × says so when that is the case (see `SENT`).

import { h } from '../dom.js';
import { icon } from './icons.js';
import { pasteLabel } from './pieces.js';

/** @typedef {import('../transcript.js').Attachment} Attachment */
/** @typedef {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} Store */

/** What the × says once the relay has the attachment, and again, in the line above the field, when it is pressed. */
const SENT = 'Already sent — Claude may still receive it';

/** @param {HTMLElement} remove @param {boolean} sent */
function describeRemove(remove, sent) {
  if (sent) {
    remove.title = SENT;
    remove.setAttribute('aria-description', SENT);
  } else {
    remove.removeAttribute('title');
    remove.removeAttribute('aria-description');
  }
}

/**
 * @param {Attachment} a
 * @param {HTMLElement} remove
 */
function chip(a, remove) {
  const body =
    'data' in a
      ? h('img', { class: 'attach-img', alt: 'Picture attachment', src: `data:image/jpeg;base64,${a.data}` })
      : h('span', { class: 'attach-text' }, h('span', { class: 'paste-tag', 'aria-hidden': 'true' }, 'TXT'), h('span', { class: 'paste-label' }, pasteLabel(a.text)));
  return h('li', { class: 'attach-item' }, body, remove);
}

/**
 * The row of pending attachments: hidden while there are none.
 * @param {Store} store
 * @param {{ drop: (id: number) => void, focusField: () => void, sent: () => boolean, remind: (text: string) => void }} actions
 *   `drop` takes one off the row; `focusField` is where the keyboard goes when the last is gone;
 *   `sent` says whether the relay already holds what is attached (read on every write to the store,
 *   which the session makes when its socket opens and closes); `remind` says something in words
 * @returns {HTMLElement}
 */
export function attachChips(store, { drop, focusField, sent, remind }) {
  const el = h('ul', { class: 'attach-row', 'aria-label': 'Attachments', hidden: true });
  /** @type {Map<number, HTMLElement>} */
  const chips = new Map();
  /** @type {Attachment[] | undefined} */
  let drawn;
  let held = sent();

  /** @param {Attachment} a */
  function make(a) {
    const remove = h('button', { class: 'attach-remove', type: 'button', 'aria-label': 'Remove attachment' }, icon('close'));
    describeRemove(remove, held);
    const item = chip(a, remove);
    remove.addEventListener('click', (event) => {
      // Taken back with the keyboard, the keyboard stays in the row (or goes back to the field);
      // with a pointer there is nothing to keep.
      const beside = item.nextElementSibling ?? item.previousElementSibling;
      // Off this screen only: with a socket open the relay already has it and cannot give it back
      // (VoiceSession.drop, until the `drop` frame of follow-up 13b), so say what it still will do.
      if (sent()) remind(SENT);
      drop(a.id);
      if (event.detail !== 0) return;
      const next = beside?.querySelector('.attach-remove');
      if (next instanceof HTMLElement) next.focus();
      else focusField();
    });
    return item;
  }

  /** @param {Record<string, any>} state */
  function draw(state) {
    const now = sent();
    if (now !== held) {
      held = now;
      for (const remove of el.querySelectorAll('.attach-remove')) describeRemove(/** @type {HTMLElement} */ (remove), held);
    }
    /** @type {Attachment[]} */
    const attached = Array.isArray(state['attached']) ? state['attached'] : [];
    if (attached === drawn) return;
    drawn = attached;
    const seen = new Set();
    attached.forEach((a, i) => {
      seen.add(a.id);
      let item = chips.get(a.id);
      if (!item) {
        item = make(a);
        chips.set(a.id, item);
      }
      if (el.children[i] !== item) el.insertBefore(item, el.children[i] ?? null);
    });
    for (const [id, item] of chips) {
      if (seen.has(id)) continue;
      item.remove();
      chips.delete(id);
    }
    el.hidden = attached.length === 0;
  }

  draw(store.get());
  store.subscribe(draw);
  return el;
}
