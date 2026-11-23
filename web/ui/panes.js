// @ts-check
// The few pieces the settings sheets (corrections, prompts, connection) are made of, so that
// they look and behave as one: a bar with Back on the left and what the pane does on the right
// (the sheet's own header is taken by the close button and the title), a question that asks
// twice before it does something that cannot be undone, a note for a relay that is not there,
// and a way to hear about the few things in the store that matter without being told about the
// other twenty-five writes a second the microphone makes.
//
// Everything is set as text: a correction, a prompt and a relay's error are somebody else's words.

import { h } from '../dom.js';
import { icon } from './icons.js';

/** @typedef {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} Store */

/** What a pane says when an edit would go nowhere: `RelayStore` sends nothing while no socket is open. */
export const OFFLINE_NOTE = "Offline. Changes can't be saved until the relay answers.";

/**
 * The bar across the top of a pane. Both ends are optional; the one that is there keeps its side.
 * @param {HTMLElement | null} start usually Back
 * @param {HTMLElement | null} [end] usually Save, or the plus
 */
export function paneBar(start, end) {
  return h('div', { class: 'pane-bar' }, start ?? h('span'), end ?? null);
}

/** @param {string} label where Back goes, as a person reads it @param {() => void} onclick */
export function backButton(label, onclick) {
  return h('button', { class: 'pane-back', type: 'button', onclick }, icon('chevron-left'), h('span', null, label));
}

/** A line of small print under something. @param {string} text @param {string} [kind] `warn` for what needs attention */
export function paneNote(text, kind) {
  return h('p', { class: kind ? `pane-note ${kind}` : 'pane-note' }, text);
}

/** The note for a relay that is not answering, hidden until it is needed. */
export function offlineNote() {
  return h('p', { class: 'pane-note warn', role: 'status', hidden: true }, OFFLINE_NOTE);
}

/** Where rows will be, for a list on its way. */
export function loadingPane() {
  return h('div', { class: 'choice-loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…');
}

/**
 * The question that comes before something that cannot be undone: what it is about, what it
 * costs, and two buttons — the safe one first, and focused, so Enter is never the dangerous answer.
 *
 * Given a `store`, the answer is for something done on the relay, which sends nothing while no
 * socket is open: so while `connected` is false the confirming button is off and the offline note
 * is shown, instead of a Delete that is pressed and does nothing. `destroy` stops listening, and
 * is to be called when the question is put away.
 * @param {{ subject?: string, text: string, cancel: string, confirm: string, onCancel: () => void, onConfirm: () => void, store?: Store }} options
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function confirmPane({ subject, text, cancel, confirm, onCancel, onConfirm, store }) {
  const note = offlineNote();
  const yes = h('button', { class: 'button danger', type: 'button', onclick: onConfirm }, confirm);
  const el = h(
    'div',
    { class: 'dialog' },
    subject ? h('p', { class: 'dialog-subject' }, subject) : null,
    h('p', { class: 'dialog-text' }, text),
    store ? note : null,
    h('div', { class: 'dialog-actions' }, h('button', { class: 'button', type: 'button', dataset: { autofocus: '' }, onclick: onCancel }, cancel), yes),
  );
  if (!store) return { el, destroy() {} };
  return {
    el,
    destroy: watchKeys(store, ['connected'], (state) => {
      const away = state['connected'] === false;
      yes.disabled = away;
      note.hidden = !away;
    }),
  };
}

/**
 * Call `fn` with the state now, and again whenever one of `keys` has a different value. The store
 * is written 25 times a second while the microphone is open and none of these screens care.
 * @param {Store} store
 * @param {string[]} keys
 * @param {(state: Record<string, any>) => void} fn
 * @returns {() => void} stops listening
 */
export function watchKeys(store, keys, fn) {
  let seen = keys.map((key) => store.get()[key]);
  fn(store.get());
  return store.subscribe((state) => {
    const next = keys.map((key) => state[key]);
    if (next.every((value, i) => value === seen[i])) return;
    seen = next;
    fn(state);
  });
}
