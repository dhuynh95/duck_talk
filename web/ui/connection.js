// @ts-check
// Where the relay is, whether it answers, and the key that gets this browser in: the two facts that
// explain a page that does nothing. `ServerView` in ContentView.swift, ported — without its address
// field, because this page is served by the relay and so has only one address to go to, its own.
//
// Reachable is the data socket the page already holds, not a socket of this sheet's: `connected`
// is "a frame came back", the same fact the header's Offline pill draws, and two answers to one
// question could disagree. The sheet redraws in place when it changes, so a relay that stops while
// you look says so.
//
// A relay started with --open checks no key, and the page learns that from the relay (main.js,
// `keyRequired`): the row then says so, and there is nothing to forget.
//
// Forget key is the way back to the key form: the key is dropped from this browser's storage and the
// page reloads. It asks first, in the sheet, because the key is typed or pasted from somewhere and
// forgetting it is not undone by pressing back. If the browser will not let go of the key (storage
// that refuses removal) the page does not reload into the same state and call that a result: it says so.

import { h } from '../dom.js';
import { forgetKey, hasStoredKey } from '../key.js';
import { icon } from './icons.js';
import { confirmPane, paneNote, watchKeys } from './panes.js';
import { openSheet } from './sheet.js';

/** @typedef {import('./panes.js').Store} Store */
/** @typedef {{ kind: 'reachable' | 'offline' | 'checking', text: string, detail?: string }} Reach */

/**
 * The one line about whether a relay is answering: Reachable once a frame has come back; Offline,
 * with the relay's own reason, once it has failed; and "Checking…" in between, which is how the page
 * opens — `connected` is false until the first answer, and that is not an outage.
 * @param {Record<string, any>} state
 * @returns {Reach}
 */
export function reachOf(state) {
  if (state['connected'] === true) return { kind: 'reachable', text: 'Reachable' };
  if (state['connected'] === false && state['relayError']) return { kind: 'offline', text: 'Offline', detail: String(state['relayError']) };
  return { kind: 'checking', text: 'Checking…' };
}

/**
 * What the sheet says about the access key. `kept`: it is in this browser's storage, as opposed
 * to held for this visit because storage would not take it. `required`: false when the relay
 * said it is open; anything else is not something to say.
 * @param {{ inUse: boolean, kept: boolean, required?: boolean }} key
 * @returns {{ text: string, canForget: boolean }}
 */
export function keyLine({ inUse, kept, required }) {
  if (required === false) return { text: 'Not required (this relay was started with --open)', canForget: false };
  if (!inUse) return { text: 'No access key saved', canForget: false };
  return { text: kept ? 'Saved in this browser' : 'Used for this visit only', canForget: true };
}

/**
 * @param {{
 *   store: Store,
 *   key: string | null,
 *   storage: import('../key.js').KeyStorage | null,
 *   address: string,
 *   reload: () => void,
 * }} deps `key` is the one this page connected with, or null when it needed none; `address` is this page's own origin
 * @returns {import('./sheet.js').Sheet}
 */
export function openConnection({ store, key, storage, address, reload }) {
  const glyph = h('span', { class: 'kv-glyph', 'aria-hidden': 'true' });
  const reachTitle = h('span', { class: 'kv-title' });
  const reachDetail = h('span', { class: 'kv-detail', hidden: true });
  const version = h('div', { class: 'kv-row', hidden: true }, h('span', { class: 'kv-label' }, 'Relay'), ' ', h('span', { class: 'kv-value' }));
  const versionValue = /** @type {HTMLElement} */ (version.querySelector('.kv-value'));
  const problem = paneNote("This browser would not let go of the key, so it is still saved here.", 'warn');
  problem.hidden = true;
  problem.setAttribute('role', 'alert');

  const line = keyLine({ inUse: key !== null, kept: hasStoredKey(storage), required: store.get()['keyRequired'] });
  const forget = h('button', { class: 'kv-action', type: 'button', onclick: () => askForget() }, 'Forget key');
  forget.hidden = !line.canForget;

  const main = h(
    'div',
    { class: 'pane' },
    h(
      'div',
      { class: 'kv-card' },
      h('div', { class: 'kv-row status', role: 'status' }, glyph, h('span', { class: 'kv-text' }, reachTitle, reachDetail)),
      h('div', { class: 'kv-row' }, h('span', { class: 'kv-label' }, 'Address'), h('span', { class: 'kv-value' }, address)),
      version,
      h('div', { class: 'kv-row' }, h('span', { class: 'kv-label' }, 'Access key'), h('span', { class: 'kv-value' }, line.text)),
      forget,
    ),
    problem,
    paneNote('Add to Home screen from the browser menu for a full-screen app.'),
  );

  /** @param {Record<string, any>} state */
  const draw = (state) => {
    const reach = reachOf(state);
    glyph.className = `kv-glyph ${reach.kind}`;
    glyph.replaceChildren(reach.kind === 'checking' ? h('span', { class: 'spinner small' }) : icon(reach.kind === 'reachable' ? 'check-circle' : 'x-circle'));
    reachTitle.textContent = reach.text;
    reachDetail.hidden = !reach.detail;
    reachDetail.textContent = reach.detail ?? '';
    const v = state['relayVersion'];
    version.hidden = typeof v !== 'string' || v === '';
    versionValue.textContent = typeof v === 'string' ? v : '';
  };

  /** @type {'main' | 'confirm'} */
  let view = 'main';
  const showMain = () => {
    view = 'main';
    sheet.setContent(main, 'Connection');
  };
  const askForget = () => {
    view = 'confirm';
    sheet.setContent(
      confirmPane({
        text: 'This browser will ask for the access key again. The relay is not changed, and the key is still printed where it was.',
        cancel: 'Cancel',
        confirm: 'Forget key',
        onCancel: showMain,
        onConfirm: () => {
          forgetKey(storage);
          if (hasStoredKey(storage)) {
            problem.hidden = false;
            showMain();
            return;
          }
          sheet.close();
          reload();
        },
      }),
      'Forget the access key?',
    );
  };

  let stop = () => {};
  const sheet = openSheet({
    title: 'Connection',
    content: main,
    onClose: () => stop(),
    // Esc and a tap outside on the question are "no", not "leave without answering".
    beforeDismiss: () => {
      if (view !== 'confirm') return true;
      showMain();
      return false;
    },
  });
  stop = watchKeys(store, ['connected', 'relayError', 'relayVersion'], draw);
  return sheet;
}
