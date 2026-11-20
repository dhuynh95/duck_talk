// @ts-check
// Boot: find the access key, and draw either the form that asks for it or the app: one chat,
// typed or spoken, on a VoiceSession whose socket, audio pipe, timers and clock are the
// browser's own, handed in here — with the chats drawer beside it, and the verbs under each line.
// A browser with no key asks the relay whether it wants one, because a relay started with --open
// checks none and the form would only make someone type a key up.
//
// The gear's menu opens the three screens that are about the relay rather than the conversation
// (prompts, corrections, connection), and "Fix what was heard" under a line opens the corrections
// one straight onto it.
//
// Everything on the page is built with `h` (see dom.js): no markup is ever parsed from a
// string.

import { actions } from './actions.js';
import { AudioPipe } from './audio.js';
import { chatFlow } from './chat-flow.js';
import { h } from './dom.js';
import { keepKey, needsKey, socketUrl, takeKey } from './key.js';
import { RelayStore } from './relay.js';
import { VoiceSession } from './session.js';
import { loadSettings, normalizeSettings, saveSettings } from './settings.js';
import { createStore } from './store.js';
import { composer } from './ui/composer.js';
import { openConnection } from './ui/connection.js';
import { openCorrections } from './ui/corrections.js';
import { chatsDrawer } from './ui/drawer.js';
import { header } from './ui/header.js';
import { openPrompts } from './ui/prompts.js';
import { settingsMenu } from './ui/settings-menu.js';
import { transcriptView } from './ui/transcript-view.js';

const LOGO = '/logo.svg';
/** How long a notice put up by the page itself stays, in ms. */
const NOTICE_FOR = 4000;
const RELAY_DOWN = "The relay isn't answering.";

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
 * @param {string | null} key null for a relay that asks for none
 * @param {import('./settings.js').SettingsStorage | null} storage where the choices are kept
 * @param {boolean} [keyRequired] false when the relay said it is open; left out when it was not asked
 */
function app(key, storage, keyRequired) {
  // What the pickers chose, as last kept. The store holds the one copy the screens read; this
  // variable is the same object, for the socket's address to read when it is next dialled.
  let settings = loadSettings(storage);
  const store = createStore(/** @type {Record<string, any>} */ ({ settings, keyRequired }));
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

  // MARK: what the relay owns: prompts, corrections, and the way to leave

  const screens = { store, relay };
  // The editor a line asks for (line-actions.js) is this one: the same sheet the menu opens, onto that line.
  actions.openCorrections = (seed) => openCorrections(screens, seed);
  const menu = settingsMenu(store, {
    change,
    prompts: () => openPrompts(screens),
    corrections: () => openCorrections(screens),
    connection: () => openConnection({ store, key, storage: localStore(), address: location.origin, reload: () => location.reload() }),
  });

  // MARK: the conversation, and what the relay says about it

  /** A notice from the page itself, taken down by the page itself — and only if it is still the one up. @param {string} message */
  const notify = (message) => {
    store.set({ notice: message });
    setTimeout(() => {
      if (store.get()['notice'] === message) store.set({ notice: null });
    }, NOTICE_FOR);
  };

  /**
   * Branch the chat on screen at one of its messages, and let the answer — the new chat, already
   * loaded — land where every chat does. A session is stopped first, never left running beside
   * the fork: there is one session, and it belongs to whatever is on screen.
   * @param {string | undefined} at the message to cut at
   */
  const forkFrom = (at) => {
    const source = store.get()['chatId'];
    if (typeof source !== 'string' || !at) return false;
    if (store.get()['connected'] === false) {
      notify(RELAY_DOWN); // a fork asked of no relay would put words in the field and change nothing else
      return false;
    }
    session.stopListening();
    relay.fork(source, at);
    return true;
  };

  /** @type {import('./ui/line-actions.js').LineHandlers & { image: (id: number) => Promise<Blob | null> }} */
  const lineHandlers = {
    // An edit is a fork you get to retype: branch just before the message, put what you said in the
    // field, and the arrow that is already there runs it. The first message of a chat has nothing
    // before it to branch from, and needs nothing: a conversation with its opening line changed is
    // a new conversation.
    edit(line) {
      if (line.after === undefined) flow.newChat();
      else if (!forkFrom(line.after)) return;
      bottom.setDraft(line.text, true);
    },
    fork(line) {
      forkFrom(line.uuid);
    },
    fix(line) {
      actions.openCorrections({ at: Date.now(), heard: line.text, meant: line.text, clip: line.clip });
    },
    notify,
    clip: (id) => relay.clip(id),
    image: (id) => relay.image(id),
  };

  const view = transcriptView(store, lineHandlers);
  const bottom = composer(store, session, change);
  const drawer = chatsDrawer(store, {
    // What you were writing belonged to the chat you left.
    open(id) {
      bottom.setDraft('');
      relay.openChat(id);
    },
    newChat() {
      bottom.setDraft('');
      flow.newChat();
    },
    star: (id, on) => relay.star(id, on),
    rename: (id, title) => relay.rename(id, title),
    remove: (id) => flow.deleteChat(id),
  });
  const root = h(
    'div',
    { class: 'app' },
    drawer.el,
    h('div', { class: 'stage' }, view.el, header(store, { openChats: (button) => drawer.open(button), openSettings: (button, edge) => menu.toggle(button, edge) }), bottom.el),
  );

  // What the data socket says about chats, carried into the conversation on screen (chat-flow.js).
  const flow = chatFlow({ store, session, relay, settings: () => settings, change });

  // The conversation pads itself clear of the composer, which grows as you type: its height
  // is measured, not guessed, and the end of the conversation stays in view as it changes.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      root.style.setProperty('--composer-h', `${bottom.el.offsetHeight}px`);
      view.follow();
    }).observe(bottom.el);
  }

  // Esc stops whatever is running, from anywhere on the page — unless something nearer has taken
  // it (a sheet, the skills list putting itself away), which says so by preventing it.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && bottom.stop()) event.preventDefault();
  });

  return root;
}

export async function boot() {
  const storage = localStore();
  const key = takeKey(location, storage, (url) => history.replaceState(null, '', url));
  if (key) {
    document.body.replaceChildren(app(key, storage));
    return;
  }
  document.body.replaceChildren((await needsKey(fetch)) ? gate(storage) : app(null, storage, false));
}

// Importing this file in Node, where there is no page, must not boot one.
if (typeof document !== 'undefined') boot();
