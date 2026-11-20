// @ts-check
// Sheets: the one way anything on this page asks you to decide something, and then goes away.
// A panel that rises from the bottom on a phone and is a centred dialog on a wide screen, over
// a dimmed page. One at a time — opening a second closes the first — and modal in every way a
// keyboard can tell: focus goes in, Tab stays in, Esc and a tap outside close it, and focus
// goes back to what opened it.
//
// `choiceSheet` is the list of a few things, each named and explained, that three pickers are
// (mode, model and effort, what Claude may do): picking one closes the sheet, because there is
// nothing else on the screen to do. A row's check is drawn on every row and shown on one, so
// picking a different choice cannot reflow the text beside it.
//
// Everything a row says is set as text, so a model description or a chat title can never be markup.

import { h } from '../dom.js';
import { icon } from './icons.js';

/**
 * @typedef {{
 *   close: () => void,
 *   setContent: (content: HTMLElement, title?: string) => void,
 * }} Sheet
 */

/** @typedef {{ id: string, title: string, detail: string, icon?: import('./icons.js').IconName }} Choice */

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';
/** The longest a leaving sheet is waited for before it is taken off the page whether or not its animation said it ended. */
const LEAVE_MS = 300;

/** @type {Sheet | null} */
let current = null;
let serial = 0;

/** The people who asked for less motion get none: the sheet is there, and gone. */
function calm() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** What Tab can reach inside `root`, in order. @param {HTMLElement} root @returns {HTMLElement[]} */
function tabbable(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(
    (el) => el instanceof HTMLElement && el.tabIndex >= 0 && !el.hasAttribute('disabled') && !el.closest('[hidden]'),
  ).map((el) => /** @type {HTMLElement} */ (el));
}

/**
 * Open a sheet over the page. `onClose` is called once, however it was closed. Focus goes back
 * to `opener` then — the button that was pressed, which only some browsers focus when it is
 * pressed, so it can be named — or else to whatever had focus when this opened.
 * @param {{ title: string, content: HTMLElement, onClose?: () => void, opener?: HTMLElement | null }} options
 * @returns {Sheet}
 */
export function openSheet({ title, content, onClose, opener: named }) {
  current?.close(); // the first goes, and focus goes back to what opened it — which is what opens this one

  const active = document.activeElement;
  const opener = named ?? (active instanceof HTMLElement && active !== document.body ? active : null);

  const titleId = `sheet-title-${++serial}`;
  const titleEl = h('h2', { class: 'sheet-title', id: titleId }, title);
  const closeButton = h('button', { class: 'round plain sheet-close', type: 'button', 'aria-label': 'Close', onclick: () => sheet.close() }, icon('close'));
  const body = h('div', { class: 'sheet-body' }, content);
  const panel = h(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h('div', { class: 'sheet-head' }, closeButton, titleEl),
    body,
  );
  const backdrop = h('div', { class: 'sheet-backdrop', onclick: () => sheet.close() });
  const layer = h('div', { class: 'sheet-layer' }, backdrop, panel);

  const focusInto = () => {
    const target = body.querySelector('[data-autofocus]') ?? tabbable(body)[0] ?? closeButton;
    /** @type {HTMLElement} */ (target).focus({ preventScroll: true });
  };

  // Capture phase on the document, so Esc here is heard before the page's own Esc (which stops
  // Claude) and Tab before anything else can take it.
  /** @param {KeyboardEvent} event */
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      sheet.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = tabbable(panel);
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const at = document.activeElement;
    if (!(at instanceof Node) || !panel.contains(at)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && (at === first || at === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && at === last) {
      event.preventDefault();
      first.focus();
    }
  };

  let closed = false;
  /** @type {Sheet} */
  const sheet = {
    close() {
      if (closed) return;
      closed = true;
      if (current === sheet) {
        current = null;
        document.documentElement.classList.remove('sheet-open');
      }
      document.removeEventListener('keydown', onKey, true);
      layer.classList.add('leaving');
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      const gone = () => layer.remove();
      if (calm()) {
        gone();
      } else {
        panel.addEventListener('animationend', (event) => {
          if (event.target === panel) gone();
        });
        setTimeout(gone, LEAVE_MS);
      }
      onClose?.();
    },

    /** Swap what the sheet shows, and the title with it if one is given — one sheet that changes its mind. */
    setContent(next, nextTitle) {
      if (closed) return;
      body.replaceChildren(next);
      if (nextTitle !== undefined && titleEl.textContent !== nextTitle) titleEl.textContent = nextTitle;
      focusInto();
    },
  };

  current = sheet;
  document.documentElement.classList.add('sheet-open');
  document.addEventListener('keydown', onKey, true);
  document.body.append(layer);
  focusInto();
  return sheet;
}

/**
 * The rows of a choice sheet: a listbox of what can be picked, then (under it, on its own
 * surface, so it is never taken for one more choice) a row that opens something related.
 *
 * @param {{
 *   label: string,
 *   choices: Choice[],
 *   picked: string,
 *   onPick: (id: string) => void,
 *   trailing?: { title: string, value: string, open: () => void },
 *   loading?: boolean,
 * }} options
 * @returns {HTMLElement}
 */
function choiceContent({ label, choices, picked, onPick, trailing, loading }) {
  if (loading) {
    return h('div', { class: 'choices' }, h('div', { class: 'choice-loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…'));
  }

  // One tab stop for the list, on the row that is picked, and the arrows move within it.
  const start = Math.max(0, choices.findIndex((c) => c.id === picked));
  const rows = choices.map((choice, index) =>
    h(
      'button',
      {
        class: choice.icon ? 'choice has-icon' : 'choice',
        type: 'button',
        role: 'option',
        'aria-selected': String(choice.id === picked),
        tabindex: index === start ? '0' : '-1',
        dataset: index === start ? { id: choice.id, autofocus: '' } : { id: choice.id },
        onclick: () => onPick(choice.id),
      },
      choice.icon ? h('span', { class: 'choice-icon' }, icon(choice.icon)) : null,
      h('span', { class: 'choice-text' }, h('span', { class: 'choice-title' }, choice.title), choice.detail ? h('span', { class: 'choice-detail' }, choice.detail) : null),
      h('span', { class: 'choice-check' }, icon('check')),
    ),
  );

  /** @param {number} index */
  const focusRow = (index) => {
    rows.forEach((row, i) => (row.tabIndex = i === index ? 0 : -1));
    rows[index]?.focus({ preventScroll: false });
  };
  const list = h('div', { class: 'choice-list', role: 'listbox', 'aria-label': label }, rows);
  list.addEventListener('keydown', (event) => {
    const at = rows.findIndex((row) => row === document.activeElement);
    const last = rows.length - 1;
    const to = event.key === 'ArrowDown' ? (at >= last ? 0 : at + 1) : event.key === 'ArrowUp' ? (at <= 0 ? last : at - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1;
    if (to < 0 || rows.length === 0) return;
    event.preventDefault();
    focusRow(to);
  });

  return h(
    'div',
    { class: 'choices' },
    list,
    trailing
      ? h(
          'button',
          { class: 'choice-trailing', type: 'button', onclick: trailing.open },
          h('span', { class: 'trailing-title' }, trailing.title),
          h('span', { class: 'trailing-value' }, trailing.value),
          icon('chevron-right'),
        )
      : null,
  );
}

/**
 * What a choice sheet shows. `loading` is a spinner where the rows will be, for a list still on
 * its way; `trailing` is a row under the list that opens something related.
 * @typedef {{
 *   title: string,
 *   choices: Choice[],
 *   picked: string,
 *   onPick: (id: string) => void,
 *   trailing?: { title: string, value: string, open: () => void },
 *   loading?: boolean,
 * }} ChoiceOptions
 */

/**
 * A sheet of a few things to pick from. Picking one closes it and then tells `onPick`. `swap`
 * shows another list in the same sheet — the model sheet's effort, or its rows once they arrive.
 *
 * @param {ChoiceOptions & { onClose?: () => void, opener?: HTMLElement | null }} options
 * @returns {Sheet & { swap: (options: ChoiceOptions) => void }}
 */
export function choiceSheet({ onClose, opener, ...options }) {
  /** @param {ChoiceOptions} o */
  const content = (o) =>
    choiceContent({
      ...o,
      label: o.title,
      onPick: (id) => {
        sheet.close(); // first: if `onPick` throws, the sheet is not left over the page
        o.onPick(id);
      },
    });
  const sheet = openSheet({ title: options.title, content: content(options), onClose, opener });
  return { ...sheet, swap: (o) => sheet.setContent(content(o), o.title) };
}
