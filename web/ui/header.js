// @ts-check
// The header: three things floating over the top of the conversation, not a bar across it —
// the chats button, the name, and settings — each its own piece of glass, as on the phone.
// The conversation shows between them.
//
// The status pill reads `connected` from the store, which the data socket writes: false until a
// frame has come back, and again the moment the socket goes. Even then it waits a moment before
// it says so (GRACE), because the page opens with `connected` false for as long as it takes the
// relay to answer, and a drop that heals in a blink is not an outage: a red word on a screen
// that is working is a false alarm.
//
// The chats and settings buttons are here and named, and do nothing yet: the drawer and the
// settings sheet are theirs to open.

import { h } from '../dom.js';
import { icon } from './icons.js';

const LOGO = '/logo.svg';
/** How long the relay may be not answering before the pill says so, in ms. */
const GRACE = 800;

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

  /** @type {ReturnType<typeof setTimeout> | null} */
  let waiting = null;
  /** @param {Record<string, any>} state */
  const draw = (state) => {
    if (state['connected'] !== false) {
      if (waiting !== null) clearTimeout(waiting);
      waiting = null;
      offline.hidden = true;
    } else if (offline.hidden && waiting === null) {
      waiting = setTimeout(() => {
        waiting = null;
        offline.hidden = false;
      }, GRACE);
    }
  };
  draw(store.get());
  store.subscribe(draw);
  return el;
}
