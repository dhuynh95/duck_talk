// @ts-check
// Review mode's question, put where the answer goes: the relay is holding an instruction back
// ("delete the cache") and the composer shows it, editable, with Accept. The ears misheard it,
// or you misspoke — this is where it is fixed before it runs, and what you change is the only
// evidence of what you really said, so accepting it teaches the relay (it files the edit).
// Saying "yes" or "no" works too, and needs nothing here: the relay hears it.
//
// It stands in for the normal field while an instruction is held, and the composer says when.
// What was typed in the normal field is still there when this is gone.

import { h } from '../dom.js';
import { autosize, enterSends } from './field.js';
import { icon } from './icons.js';

/**
 * @param {{ approve: (text: string) => void }} session
 * @returns {{
 *   el: HTMLElement,
 *   set: (pending: string | null) => void,
 *   focused: () => boolean,
 * }} `set` shows the held instruction, or hides the card when there is none; `focused`, whether the keyboard is in it
 */
export function reviewCard(session) {
  const input = h('textarea', {
    class: 'compose-input review-input',
    rows: 1,
    'aria-label': 'Instruction',
    // Never "corrected": a phone's autocorrect rewrites the very words you are here to fix.
    spellcheck: 'false',
    autocapitalize: 'off',
    autocorrect: 'off',
    autocomplete: 'off',
  });
  const accept = h('button', { class: 'button primary accept', type: 'button', 'aria-label': 'Accept', disabled: true }, icon('check'), h('span', null, 'Accept'));
  const el = h(
    'div',
    { class: 'review', hidden: true },
    h('div', { class: 'review-label' }, 'Review before it runs'),
    h('div', { class: 'review-row' }, input, accept),
  );

  const sync = () => {
    accept.disabled = !input.value.trim(); // an empty instruction is not one to run
  };
  const submit = () => {
    if (!input.value.trim()) return;
    session.approve(input.value);
  };
  input.addEventListener('input', () => {
    autosize(input);
    sync();
  });
  input.addEventListener('keydown', (event) => {
    if (!enterSends(event)) return;
    event.preventDefault();
    submit();
  });
  accept.addEventListener('click', submit);

  /** @type {string | null} */
  let shown = null;
  return {
    el,
    set(pending) {
      if (pending === shown) return; // the store is written 25 times a second: only a new instruction replaces what you are editing
      shown = pending;
      el.hidden = pending === null;
      if (pending === null) return;
      input.value = pending;
      autosize(input);
      sync();
    },
    focused: () => el.contains(document.activeElement),
  };
}
