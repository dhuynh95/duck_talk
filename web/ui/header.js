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
// The chats button opens the drawer (drawer.js), which on a wide screen is always open and so
// has no use for it: CSS hides it there but keeps its room, so the name stays in the middle. The
// gear opens the settings menu (settings-menu.js), which hangs under it and marks it expanded while
// it is open. The Offline pill is the only thing here that speaks about the relay: the gear is a
// gear whether or not one is answering, and the menu's Connection row is where to look into it.

import { h } from '../dom.js';
import { icon } from './icons.js';

const LOGO = '/logo.svg';
/** How long the relay may be not answering before the pill says so, in ms. */
const GRACE = 800;

/**
 * @param {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} store
 * @param {{
 *   openChats?: (opener: HTMLElement) => void,
 *   openSettings?: (opener: HTMLElement, edge?: 'first' | 'last') => void,
 * }} [actions] each is told which button was pressed, so focus can go back to it; `edge` is the row the keyboard lands on when the arrow keys opened the menu
 * @returns {HTMLElement}
 */
export function header(store, actions = {}) {
  const chats = h('button', { class: 'round floating chats-button', type: 'button', 'aria-label': 'Chats', 'aria-haspopup': 'dialog', onclick: () => actions.openChats?.(chats) }, icon('chats'));
  const gear = h('button', { class: 'round floating', type: 'button', 'aria-label': 'Settings', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => actions.openSettings?.(gear) }, icon('settings'));
  // A menu button opens on the arrow keys too, landing on the row the arrow points at.
  gear.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    actions.openSettings?.(gear, event.key === 'ArrowUp' ? 'last' : 'first');
  });
  const offline = h('span', { class: 'status-pill', role: 'status', hidden: true }, h('span', { class: 'status-dot', 'aria-hidden': 'true' }), 'Offline');

  const el = h(
    'header',
    { class: 'top' },
    chats,
    h('div', { class: 'title floating' }, h('img', { class: 'logo', src: LOGO, alt: '' }), h('h1', null, 'Duck Talk')),
    h('div', { class: 'top-end' }, offline, gear),
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
