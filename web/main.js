// @ts-check
// Boot: find the access key, and draw either the form that asks for it or the app's shell.
// Nothing connects to the relay from here yet; the shell is the place the rest mounts.
//
// Everything on the page is built with `h` (see dom.js): no markup is ever parsed from a
// string.

import { h } from './dom.js';
import { keepKey, takeKey } from './key.js';

const LOGO = '/logo.svg';

/** localStorage, or null where the browser will not hand it over (blocked site data throws on the property itself). */
function localStore() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The single field that asks for the key. @param {import('./key.js').KeyStorage | null} storage */
function gate(storage) {
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
  function submit(event) {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    if (keepKey(storage, value)) location.reload();
    else note.textContent = 'This browser would not keep the key. Open the link the relay printed instead, which carries it.';
  }

  return h(
    'main',
    { class: 'gate' },
    h(
      'form',
      { class: 'gate-card', onsubmit: submit },
      h('img', { class: 'logo', src: LOGO, alt: '' }),
      h('h1', null, 'Duck Talk'),
      h('label', { for: 'key' }, 'Enter access key'),
      input,
      h('p', { class: 'gate-help' }, 'Paste the key the relay printed when it started, or the one in .duck-talk/key in the project folder.'),
      note,
      h('button', { class: 'button primary', type: 'submit' }, 'Continue'),
    ),
  );
}

/** The app with nothing in it yet: a header, an empty transcript, a composer that does not work. */
function shell() {
  return h(
    'div',
    { class: 'app', id: 'app' },
    h('header', { class: 'bar floating' }, h('img', { class: 'logo', src: LOGO, alt: '' }), h('h1', { class: 'title' }, 'Duck Talk')),
    h('main', { class: 'transcript', id: 'transcript', 'aria-label': 'Conversation' }),
    h(
      'div',
      { class: 'composer floating' },
      h('input', { class: 'field', type: 'text', placeholder: 'Message Duck Talk', 'aria-label': 'Message', disabled: true }),
      h('button', { class: 'button primary', type: 'button', disabled: true }, 'Send'),
    ),
  );
}

export function boot() {
  const storage = localStore();
  const key = takeKey(location, storage, (url) => history.replaceState(null, '', url));
  document.body.replaceChildren(key ? shell() : gate(storage));
}

// Importing this file in Node, where there is no page, must not boot one.
if (typeof document !== 'undefined') boot();
