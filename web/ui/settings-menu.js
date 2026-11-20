// @ts-check
// The gear's menu: what you set once and forget — what the relay says to the models (Prompts),
// what the ears keep mishearing (Corrections), whether to fix it for you (Auto-correct), whether
// the microphone listens while the reply plays — and the way out to the relay (Connection).
// The `settings` menu in ContentView.swift, ported.
//
// A popover under the button, on every width: it is five rows, and a sheet for five rows would
// cover a phone for nothing. It is a menu in the keyboard's sense too — one tab stop that the
// arrows move within, Enter and Space act, Tab and Esc put it away, and focus goes back to the
// gear. A tap anywhere else puts it away and is not also a press on whatever is there: a
// transparent layer under the menu takes it, as a phone's own menus do.
//
// The two switches stay open when flipped, so the change is seen; a row that opens something
// closes the menu first, so the sheet it opens finds focus on the gear and gives it back there.
// Auto-correct is greyed (aria-disabled, so the keyboard still finds it and hears why) while the
// microphone is on — the Swift's `.disabled(live)` — and, here, while Claude is working too: it
// rides the socket's address, so changing it redials (main.js), and a redial would hang up on you
// or on a reply being written. That is the rule the mode capsule is held to, for the same reason.
// The rows come from `menuItems`, plain data, so what is in the menu, in what order, and what it
// refuses are rules a test can hold.

import { h } from '../dom.js';
import { icon } from './icons.js';
import { modeLocked } from './pickers.js';

/** @typedef {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} Store */
/** @typedef {'prompts' | 'corrections' | 'autocorrect' | 'gate' | 'connection'} RowId */
/**
 * One row: something that opens a screen (`item`), or a switch (`toggle`), which is checked or not
 * and may be disabled with a reason in `detail`.
 * @typedef {{
 *   id: RowId,
 *   kind: 'item' | 'toggle',
 *   title: string,
 *   detail?: string,
 *   icon: import('./icons.js').IconName,
 *   checked?: boolean,
 *   disabled?: boolean,
 * }} Row
 */
/** @typedef {Row | { id: 'divider', kind: 'divider', title: string }} MenuItem */

const GATE_DETAIL = 'Stops the microphone hearing the reply (echo). Turn off with headphones to interrupt by voice.';

/**
 * Auto-correct rides the chat socket's address (`?correct=1`), so it is fixed while a socket is
 * wanted: while the microphone is connecting or on (the Swift's `.disabled(live)`), and while a turn
 * is running, when changing it would redial in the middle of one. Nothing is lost by waiting: it
 * only matters to a microphone session, and the next one opens with whatever was chosen.
 * @param {Record<string, any>} state
 */
export function autocorrectLocked(state) {
  return modeLocked(state);
}

/**
 * What the menu holds, top to bottom, as of this state.
 * @param {Record<string, any>} state
 * @returns {MenuItem[]}
 */
export function menuItems(state) {
  const settings = state['settings'] ?? {};
  const locked = autocorrectLocked(state);
  return [
    { id: 'prompts', kind: 'item', title: 'Prompts', icon: 'prompts' },
    { id: 'corrections', kind: 'item', title: 'Corrections', icon: 'corrections' },
    {
      id: 'autocorrect',
      kind: 'toggle',
      title: 'Auto-correct',
      detail: locked ? 'Available when the microphone is off and Claude is not working.' : 'Fixes what was misheard, using your corrections.',
      icon: 'wand',
      checked: settings.autocorrect === true,
      disabled: locked,
    },
    { id: 'gate', kind: 'toggle', title: 'Mute mic while Claude speaks', detail: GATE_DETAIL, icon: 'mic-off', checked: settings.gate !== false, disabled: false },
    { id: 'divider', kind: 'divider', title: '' },
    { id: 'connection', kind: 'item', title: 'Connection', icon: 'network' },
  ];
}

/**
 * @param {Store} store
 * @param {{
 *   change: import('./pickers.js').Change,
 *   prompts: () => void,
 *   corrections: () => void,
 *   connection: () => void,
 * }} actions `change` is how every choice is kept and applied (main.js), which for Auto-correct includes the redial
 * @returns {{ toggle: (anchor: HTMLElement, edge?: 'first' | 'last') => void, close: () => void, isOpen: () => boolean }}
 */
export function settingsMenu(store, actions) {
  /** @type {{ close: () => void } | null} */
  let current = null;

  /** @param {HTMLElement} anchor the gear: the menu hangs under it, and focus goes back to it @param {'first' | 'last'} edge */
  function open(anchor, edge) {
    /** @type {Map<string, HTMLButtonElement>} */
    const rows = new Map();
    const parts = menuItems(store.get()).map((item) => {
      if (item.id === 'divider') return h('div', { class: 'menu-sep', role: 'separator' });
      const toggle = item.kind === 'toggle';
      const row = h(
        'button',
        {
          class: 'menu-item',
          type: 'button',
          role: toggle ? 'menuitemcheckbox' : 'menuitem',
          tabindex: '-1',
          'aria-checked': toggle ? String(item.checked === true) : false,
          dataset: { id: item.id },
        },
        h('span', { class: 'menu-icon' }, icon(item.icon)),
        h('span', { class: 'menu-text' }, h('span', { class: 'menu-title' }, item.title), h('span', { class: 'menu-detail', hidden: !item.detail }, item.detail ?? '')),
        toggle ? h('span', { class: 'switch', 'aria-hidden': 'true' }) : null,
      );
      row.addEventListener('click', () => press(item.id));
      rows.set(item.id, row);
      return row;
    });
    const list = [...rows.values()];

    const panel = h('div', { class: 'menu', role: 'menu', 'aria-label': 'Settings' }, parts);
    const scrim = h('div', { class: 'menu-scrim', onclick: () => close() });
    const rect = anchor.getBoundingClientRect();
    Object.assign(panel.style, { top: `${Math.round(rect.bottom + 8)}px`, right: `${Math.max(8, Math.round(document.documentElement.clientWidth - rect.right))}px` });

    /** Redraw what a store write can change: the switches, and what Auto-correct says about itself. @param {Record<string, any>} state */
    const paint = (state) => {
      for (const item of menuItems(state)) {
        if (item.id === 'divider') continue;
        const row = rows.get(item.id);
        if (!row) continue;
        if (item.kind === 'toggle') row.setAttribute('aria-checked', String(item.checked === true));
        if (item.disabled) row.setAttribute('aria-disabled', 'true');
        else row.removeAttribute('aria-disabled');
        const detail = /** @type {HTMLElement} */ (row.querySelector('.menu-detail'));
        if (item.detail !== undefined && detail.textContent !== item.detail) detail.textContent = item.detail;
      }
    };
    paint(store.get());

    // The store is written 25 times a second while the microphone is open: only what decides the rows matters here.
    const watched = ['settings', 'status', 'inFlight', 'working', 'lines'];
    let seen = watched.map((k) => store.get()[k]);
    const unsubscribe = store.subscribe((state) => {
      const next = watched.map((k) => state[k]);
      if (next.every((v, i) => v === seen[i])) return;
      seen = next;
      paint(state);
    });

    /** @param {number} index */
    const focusRow = (index) => {
      list.forEach((row, i) => (row.tabIndex = i === index ? 0 : -1));
      list[index]?.focus({ preventScroll: true });
    };

    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        close(); // focus goes to the gear first, and Tab carries on from there
        return;
      }
      const at = list.findIndex((row) => row === document.activeElement);
      const last = list.length - 1;
      const to = event.key === 'ArrowDown' ? (at >= last ? 0 : at + 1) : event.key === 'ArrowUp' ? (at <= 0 ? last : at - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1;
      if (to < 0) return;
      event.preventDefault();
      focusRow(to);
    });

    // Capture phase on the document, so Esc is heard before the page's own Esc (which stops Claude).
    /** @param {KeyboardEvent} event */
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const onResize = () => close(); // it hangs from a place that has moved

    /** @param {RowId} id */
    function press(id) {
      const state = store.get();
      switch (id) {
        case 'autocorrect':
          if (!autocorrectLocked(state)) actions.change({ autocorrect: state['settings']?.autocorrect !== true });
          return;
        case 'gate':
          actions.change({ gate: state['settings']?.gate === false });
          return;
        case 'prompts':
          close();
          actions.prompts();
          return;
        case 'corrections':
          close();
          actions.corrections();
          return;
        case 'connection':
          close();
          actions.connection();
          return;
      }
    }

    let closed = false;
    /** @param {boolean} [giveFocusBack] */
    function close(giveFocusBack = true) {
      if (closed) return;
      closed = true;
      current = null;
      unsubscribe();
      document.removeEventListener('keydown', onKey, true);
      removeEventListener('resize', onResize);
      panel.remove();
      scrim.remove();
      anchor.setAttribute('aria-expanded', 'false');
      if (giveFocusBack && anchor.isConnected) anchor.focus({ preventScroll: true });
    }

    current = { close };
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onKey, true);
    addEventListener('resize', onResize);
    document.body.append(scrim, panel);
    focusRow(edge === 'last' ? list.length - 1 : 0);
  }

  return {
    /** Open under `anchor`, or put away if it is open. `edge`: which row the keyboard lands on. */
    toggle(anchor, edge = 'first') {
      if (current) current.close();
      else open(anchor, edge);
    },
    close: () => current?.close(),
    isOpen: () => current !== null,
  };
}
