// @ts-check
// The header: three things floating over the top of the conversation, not a bar across it —
// the chats button, the name, and settings — each its own piece of glass, as on the phone.
// The conversation shows between them.
//
// The status pill reads `connected` from the store, which the data socket will write. Until
// something says the relay is not answering (`false`, not merely unknown) it is not drawn:
// a red word on a screen that is working is a false alarm.
//
// The chats and settings buttons are here and named, and do nothing yet: the drawer and the
// settings sheet are theirs to open.

import { h } from '../dom.js';
import { icon } from './icons.js';

const LOGO = '/logo.svg';

/**
 * @param {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} store
 * @returns {HTMLElement}
 */
export function header(store) {
  const offline = h('span', { class: 'status-pill', role: 'status', hidden: true }, h('span', { class: 'status-dot', 'aria-hidden': 'true' }), 'Offline');

  const el = h(
    'header',
    { class: 'top' },
    h('button', { class: 'round floating', type: 'button', 'aria-label': 'Chats' }, icon('chats')),
    h('div', { class: 'title floating' }, h('img', { class: 'logo', src: LOGO, alt: '' }), h('h1', null, 'Duck Talk')),
    h('div', { class: 'top-end' }, offline, h('button', { class: 'round floating', type: 'button', 'aria-label': 'Settings' }, icon('settings'))),
  );

  /** @param {Record<string, any>} state */
  const draw = (state) => {
    offline.hidden = state['connected'] !== false;
  };
  draw(store.get());
  store.subscribe(draw);
  return el;
}
