// @ts-check
// The key a control answers to, drawn small on the corner of its button. Decoration — the
// button's own name and `aria-keyshortcuts` carry the meaning — so it is hidden from a screen
// reader, and style.css shows it only where there is a keyboard to press it on.

import { h } from '../dom.js';

/** @param {string} [text] what to draw; nothing for none */
export function keycap(text = '') {
  return h('kbd', { class: 'keycap', 'aria-hidden': 'true', hidden: !text }, text);
}
