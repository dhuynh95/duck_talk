// @ts-check
// Boot: find the access key, and draw either the form that asks for it or the app: one chat,
// typed or spoken, on a VoiceSession whose socket, audio pipe, timers and clock are the
// browser's own, handed in here.
//
// Everything on the page is built with `h` (see dom.js): no markup is ever parsed from a
// string.

import { AudioPipe } from './audio.js';
import { h } from './dom.js';
import { keepKey, socketUrl, takeKey } from './key.js';
import { RelayStore } from './relay.js';
import { VoiceSession } from './session.js';
import { loadSettings, normalizeSettings, saveSettings } from './settings.js';
import { createStore } from './store.js';
import { composer } from './ui/composer.js';
import { header } from './ui/header.js';
import { transcriptView } from './ui/transcript-view.js';

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

/** @param {string} url */
function makeSocket(url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  return ws;
}

/** @param {() => void} fn @param {number} ms */
function setTimer(fn, ms) {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/**
 * The app: the conversation, and the header and composer floating over it.
 * @param {string} key
 * @param {import('./settings.js').SettingsStorage | null} storage where the choices are kept
 */
function app(key, storage) {
  // What the pickers chose, as last kept. The store holds the one copy the screens read; this
  // variable is the same object, for the socket's address to read when it is next dialled.
  let settings = loadSettings(storage);
  const store = createStore(/** @type {Record<string, any>} */ ({ settings }));
  const session = new VoiceSession({
    store,
    // Mode and auto-correct ride the address, so changing either redials (see `change`).
    urlFor: (params) => socketUrl(location, { mode: settings.mode, correct: settings.autocorrect ? '1' : undefined, ...params }, key),
    makeSocket,
    makePipe: () => new AudioPipe(),
    setTimer,
    now: () => Date.now(),
  });

  // The one place that tells the session what Claude should be and how it should sound, on
  // arrival and again on every change: the session carries it to the socket it has open and to
  // every one it opens after, so talking and typing never disagree about it.
  /** @param {import('./settings.js').Settings | null} was */
  const apply = (was) => {
    if (!was || was.model !== settings.model || was.permission !== settings.permission || was.effort !== settings.effort) {
      session.use({ model: settings.model, permission: settings.permission, effort: settings.effort });
    }
    session.output = settings.output;
    session.gate = settings.gate;
    if (was && (was.mode !== settings.mode || was.autocorrect !== settings.autocorrect)) session.reconnect();
  };
  apply(null);

  /**
   * Every picker's way of changing a choice: kept, applied, and told to the screens.
   * @type {import('./ui/pickers.js').Change}
   */
  const change = (patch) => {
    const was = settings;
    settings = normalizeSettings({ ...was, ...patch });
    saveSettings(storage, settings);
    apply(was);
    store.set({ settings });
  };

  // The data socket: models, skills, chats and the rest of what the relay owns, held for as
  // long as the page is up. It is also what the header's Offline pill reads.
  const relay = new RelayStore({ store, urlFor: () => socketUrl(location, { data: '1' }, key), makeSocket, setTimer });
  relay.connect();

  const view = transcriptView(store);
  const bottom = composer(store, session, change);
  const root = h('div', { class: 'app' }, view.el, header(store), bottom.el);

  // The conversation pads itself clear of the composer, which grows as you type: its height
  // is measured, not guessed, and the end of the conversation stays in view as it changes.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      root.style.setProperty('--composer-h', `${bottom.el.offsetHeight}px`);
      view.follow();
    }).observe(bottom.el);
  }

  // Esc stops whatever is running, from anywhere on the page.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && bottom.stop()) event.preventDefault();
  });

  return root;
}

export function boot() {
  const storage = localStore();
  const key = takeKey(location, storage, (url) => history.replaceState(null, '', url));
  document.body.replaceChildren(key ? app(key, storage) : gate(storage));
}

// Importing this file in Node, where there is no page, must not boot one.
if (typeof document !== 'undefined') boot();
