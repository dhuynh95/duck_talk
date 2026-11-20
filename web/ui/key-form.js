// @ts-check
// The one form that asks for the access key, in its two places: the whole page on a first visit
// (main.js's gate), and a dialog over the app when the relay will not take the key this browser
// has. The second is the one a person would otherwise never find: a browser cannot see a WebSocket
// refused with a 401, so a wrong key looks exactly like a relay that is down — and the key is made
// per project folder while the browser keeps one per address, so a relay started in another folder
// on the same port refuses a key that worked yesterday. relay.js asks the relay which it is and sets
// `keyRefused`; this draws it, with the explanation, the field, and the way out (Forget key).
//
// Everything here is built with `h`; the only text from outside is what the person types.

import { h } from '../dom.js';
import { forgetKey, hasStoredKey, keepKey } from '../key.js';

const LOGO = '/logo.svg';

export const REFUSED_TITLE = 'Key refused';
export const REFUSED_TEXT = 'The relay refused this key — it may belong to another project. The key is per project folder.';
const HELP = 'Paste the key the relay printed when it started, or the one in .duck-talk/key in the project folder.';
const NOT_KEPT = 'This browser would not keep the key. Open the link the relay printed instead, which carries it.';
const NOT_FORGOTTEN = 'This browser would not let go of the key, so it is still saved here.';

/**
 * What submitting the field does: a key typed is kept and the page reloads onto it. Returns what to
 * say under the field, or null when there is nothing to say (it worked, or nothing was typed).
 * @param {string} typed
 * @param {import('../key.js').KeyStorage | null} storage
 * @param {() => void} reload
 * @returns {string | null}
 */
export function useKey(typed, storage, reload) {
  const value = typed.trim();
  if (!value) return null;
  if (!keepKey(storage, value)) return NOT_KEPT;
  reload();
  return null;
}

/**
 * Forget key: the stored key dropped and the page reloaded, which then asks for one on its own.
 * Returns what to say instead when the browser would not let go of it.
 * @param {import('../key.js').KeyStorage | null} storage
 * @param {() => void} reload
 * @returns {string | null}
 */
export function dropKey(storage, reload) {
  forgetKey(storage);
  if (hasStoredKey(storage)) return NOT_FORGOTTEN;
  reload();
  return null;
}

/**
 * The card: logo, title, an optional explanation, the field, and the buttons.
 * @param {{
 *   storage: import('../key.js').KeyStorage | null,
 *   reload: () => void,
 *   title?: string,
 *   explain?: string,
 *   submit?: string,
 *   forget?: boolean,
 *   titleId?: string,
 * }} opts `forget`: offer Forget key beside the submit button; `titleId`: for a dialog that is named by the title
 */
export function keyForm({ storage, reload, title = 'Duck Talk', explain, submit = 'Continue', forget = false, titleId }) {
  const note = h('p', { class: 'gate-note', role: 'alert' });
  const input = h('input', {
    id: 'key',
    class: 'field',
    name: 'key',
    type: 'text',
    required: true,
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false', // the attribute's value is the word "false"; a bare `false` would leave it off the element
  });

  /** @param {Event} event */
  const onsubmit = (event) => {
    event.preventDefault();
    note.textContent = useKey(input.value, storage, reload) ?? '';
  };

  const primary = h('button', { class: 'button primary', type: 'submit' }, submit);
  const actions = forget
    ? h('div', { class: 'gate-actions' }, h('button', { class: 'button', type: 'button', onclick: () => void (note.textContent = dropKey(storage, reload) ?? '') }, 'Forget key'), primary)
    : primary;

  const el = h(
    'form',
    { class: 'gate-card', onsubmit },
    h('img', { class: 'logo', src: LOGO, alt: '' }),
    h('h1', { id: titleId }, title),
    explain ? h('p', { class: 'gate-explain' }, explain) : null,
    h('label', { for: 'key' }, 'Enter access key'),
    input,
    h('p', { class: 'gate-help' }, HELP),
    note,
    actions,
  );
  return { el, input };
}

/**
 * The dialog over the app while the relay refuses this browser's key. Made once, opened and closed
 * in place as `keyRefused` changes; it cannot be dismissed — the app behind it can do nothing
 * without a key the relay takes — so Esc is swallowed here rather than reaching the page.
 * @param {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} store
 * @param {{ storage: import('../key.js').KeyStorage | null, reload: () => void }} deps
 */
export function keyDialog(store, { storage, reload }) {
  const form = keyForm({ storage, reload, title: REFUSED_TITLE, explain: REFUSED_TEXT, submit: 'Use this key', forget: true, titleId: 'key-dialog-title' });
  const el = /** @type {HTMLDialogElement} */ (
    h('dialog', {
      class: 'key-dialog',
      'aria-labelledby': 'key-dialog-title',
      oncancel: (/** @type {Event} */ event) => event.preventDefault(),
      onkeydown: (/** @type {KeyboardEvent} */ event) => {
        if (event.key === 'Escape') event.preventDefault();
      },
    }, form.el)
  );

  // `keyRefused` only ever turns true after a socket has failed and the relay has been asked, so
  // long after the app is on the page: a dialog not yet in the document has nothing to show.
  /** @param {Record<string, any>} state */
  const draw = (state) => {
    const refused = state['keyRefused'] === true;
    if (refused && !el.open && el.isConnected) {
      el.showModal();
      form.input.focus();
    } else if (!refused && el.open) {
      el.close();
    }
  };
  store.subscribe(draw);
  return el;
}
