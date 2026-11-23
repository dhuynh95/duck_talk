// @ts-check
// The plus: what you add to the next instruction besides words — a picture, from the camera or
// the library — and what Claude may do with it. `ContextSheet.swift`, ported.
//
// Those two look unrelated and are not: both are things you settle about the next instruction
// rather than say. Permission is here and not in the bar because of how it is used — you glance
// at the model every turn, and you set the permission once and forget it. The bar holds what you
// check; this holds what you change.
//
// Picking closes the sheet. One pick is one chooser, and the chooser (the camera, or the
// library with several pictures selected at once) is the browser's own: a file input, kept hidden
// and opened from a row, because a row can be named and styled and an input cannot. The sheet
// stays open while the chooser does, so cancelling it leaves the other rows to try; when files
// come back it closes, and they are processed in the background (intake.js), the composer saying
// how that is going. Each input is emptied after use so the same picture can be chosen again.

import { h } from '../dom.js';
import { icon } from './icons.js';
import { PERMISSIONS, permissionSheet } from './pickers.js';
import { openSheet } from './sheet.js';

/** @typedef {import('./pickers.js').Change} Change */
/** @typedef {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} Store */
/** @typedef {Pick<ReturnType<typeof import('../intake.js').createIntake>, 'addFiles'>} Intake */

/**
 * The + in the bar: opens the sheet.
 * @param {Store} store
 * @param {Change} change
 * @param {Intake} intake
 * @returns {HTMLButtonElement}
 */
export function contextButton(store, change, intake) {
  const button = h('button', { class: 'round plain add-context', type: 'button', 'aria-label': 'Add context', 'aria-haspopup': 'dialog' }, icon('plus'));
  button.addEventListener('click', () => contextSheet(store, change, intake, button));
  return button;
}

/**
 * @param {Store} store
 * @param {Change} change
 * @param {Intake} intake where the chosen files go
 * @param {HTMLElement | null} [opener] the button to give focus back to
 */
export function contextSheet(store, change, intake, opener) {
  /** @type {import('./sheet.js').Sheet | null} */
  let sheet = null;

  /**
   * A row that opens a file chooser, and what comes of it. The input stays beside the rows, not in
   * one: a control inside a button is not valid, and its click would reach the button too.
   * @param {import('./icons.js').IconName} glyph
   * @param {string} title
   * @param {string} detail
   * @param {Record<string, any>} attributes what the hidden input is told: whether it takes several, whether it is the camera
   */
  const fileRow = (glyph, title, detail, attributes) => {
    const input = h('input', { type: 'file', accept: 'image/*', hidden: true, tabindex: '-1', ...attributes });
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])]; // before it is emptied: emptying takes them from the list, not from the files
      input.value = '';
      if (files.length === 0) return;
      sheet?.close();
      void intake.addFiles(files);
    });
    const row = h(
      'button',
      { class: 'choice has-icon', type: 'button', onclick: () => input.click() },
      h('span', { class: 'choice-icon' }, icon(glyph)),
      h('span', { class: 'choice-text' }, h('span', { class: 'choice-title' }, title), h('span', { class: 'choice-detail' }, detail)),
    );
    return { row, input };
  };

  const settings = store.get()['settings'];
  const permission = PERMISSIONS.find((p) => p.id === settings?.permission) ?? PERMISSIONS[0];

  const camera = fileRow('camera', 'Camera', 'Take a picture', { capture: 'environment' });
  const library = fileRow('photo', 'Photo library', 'Choose pictures, several at once', { multiple: true });

  const content = h(
    'div',
    { class: 'choices' },
    h('div', { class: 'choice-list' }, camera.row, library.row),
    // Permission has no named opener: this sheet is replaced by the permission sheet, and a button
    // inside a sheet that is going is not somewhere focus can come back to. The plus is — and is
    // what has focus once this sheet has closed.
    h(
      'button',
      { class: 'choice-trailing', type: 'button', onclick: () => permissionSheet(store, change) },
      h('span', { class: 'choice-icon' }, icon(permission.icon ?? 'eye')),
      h('span', { class: 'trailing-title' }, 'Permission'),
      h('span', { class: 'trailing-value' }, permission.title),
      icon('chevron-right'),
    ),
    camera.input,
    library.input,
  );

  sheet = openSheet({ title: 'Add context', content, opener });
  return sheet;
}
