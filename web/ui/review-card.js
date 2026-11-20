// @ts-check
// Review mode's question, put where the answer goes: the relay is holding an instruction back
// ("delete the cache") and the composer shows it, editable, with Accept. The ears misheard it,
// or you misspoke — this is where it is fixed before it runs, and what you change is the only
// evidence of what you really said, so accepting it teaches the relay (it files the edit).
// Saying "yes" or "no" works too, and needs nothing here: the relay hears it.
//
// It stands in for the normal field while an instruction is held, and the composer says when.
// What was typed in the normal field is still there when this is gone.
//
// It announces itself, because nothing else will: it is a group with a name, a polite note says
// what to do, and the keyboard moves into the field (unless a dialog or menu has it). Esc in the
// field leaves the field and nothing more — Esc anywhere else stops Claude, which would throw
// away the very edit being made.

import { h } from '../dom.js';
import { autosize, autosizeOnResize, enterSends } from './field.js';
import { icon } from './icons.js';

/** What to do, said to a screen reader when the card appears. */
const ASK = 'Review the instruction, then Accept';

/**
 * @param {{ approve: (text: string) => void }} session
 * @returns {{
 *   el: HTMLElement,
 *   note: HTMLElement,
 *   set: (pending: string | null) => void,
 *   focused: () => boolean,
 * }} `set` shows the held instruction, or hides the card when there is none; `note` is the live region that says what to do, which must be in the page beside the card (not in it: a region that appears with its words is not announced); `focused`, whether the keyboard is in it
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
  const note = h('div', { class: 'sr', role: 'status' });
  const el = h(
    'div',
    { class: 'review', role: 'group', 'aria-labelledby': 'review-label', hidden: true },
    h('div', { class: 'review-label', id: 'review-label' }, 'Review before it runs'),
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
  autosizeOnResize(input);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault(); // taken: the page's Esc stops Claude, and the held instruction with it
      if (!event.isComposing) input.blur(); // an input method's own Esc is its to say
      return;
    }
    if (!enterSends(event)) return;
    event.preventDefault();
    submit();
  });
  accept.addEventListener('click', submit);

  /** @type {string | null} */
  let shown = null;
  return {
    el,
    note,
    set(pending) {
      if (pending === shown) return; // the store is written 25 times a second: only a new instruction replaces what you are editing
      shown = pending;
      el.hidden = pending === null;
      note.textContent = pending === null ? '' : ASK; // emptied, so the same words said again are a change
      if (pending === null) return;
      input.value = pending;
      autosize(input);
      sync();
      // The keyboard goes where the question is — but not out of a dialog or menu someone is in.
      if (document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    },
    focused: () => el.contains(document.activeElement),
  };
}
