// @ts-check
// What the data socket says about chats, carried into the conversation on screen: a chat that was
// asked for (or a fork, which arrives as one) is shown; the chat being Working is the session's
// third reason to hold its socket, so a working chat streams in; and the chat on screen is the
// one the page reopens next time. The part of `ContentView.swift` that watches `relay.loaded`,
// `working` and the open chat, as a function of its own so it can be played against the real
// store and the real session.
//
// It is one subscriber on the store, written to a store that is written 25 times a second while
// the microphone is open: each step is a few comparisons when nothing it reads has moved.

/** @typedef {import('./settings.js').Settings} Settings */
/** @typedef {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} FlowStore */
/** @typedef {Pick<import('./session.js').VoiceSession, 'show' | 'working'>} FlowSession */
/** @typedef {Pick<import('./relay.js').RelayStore, 'openChat' | 'deleteChat'>} FlowRelay */

/**
 * @param {{
 *   store: FlowStore,
 *   session: FlowSession,
 *   relay: FlowRelay,
 *   settings: () => Settings,
 *   change: (patch: Partial<Settings>) => void,
 * }} deps `settings` is read when it is needed, because it is replaced on every change
 * @returns {{ newChat: () => void, deleteChat: (id: string) => void }}
 */
export function chatFlow({ store, session, relay, settings, change }) {
  /** @type {import('./relay.js').LoadedChat | null} the chat last put on screen */
  let shown = null;
  /** @type {unknown} */
  let seenChats;
  /** @type {unknown} */
  let seenId;
  /** The session has forgotten what the list said about the chat on screen, so say it again. */
  let remind = false;
  /** Waiting for the first list of chats to say whether the one that was open still exists. */
  let restoring = settings().lastChat !== null;
  /** @type {string | null} the chat on screen as last looked at, for `lastChat` */
  let lastId = null;

  // Every step reads the store when it runs, never the state this was called with: showing a chat
  // writes the store from inside the write that called us, and a state taken before that is the
  // chat that was just left.
  const read = () => store.get();
  /** @param {Record<string, any>} state */
  const chatOf = (state) => (typeof state['chatId'] === 'string' ? state['chatId'] : null);

  /** A chat that was asked for, or a fork, which arrives as one. */
  function showLoaded() {
    const loaded = read()['loaded'];
    if (!loaded || loaded === shown) return;
    shown = loaded;
    session.show(loaded.messages, loaded.id);
    // Showing a chat starts it as not working: "the new chat's own word arrives with the next
    // list". For a chat that was not on screen that list is the one still to come; for the one
    // that already was (tapped again in the drawer) it came before the chat did and has been seen.
    remind = true;
  }

  /** The first list of chats: is the chat that was open last time still there? */
  function restore() {
    const state = read();
    const chats = state['chats'];
    if (!restoring || !Array.isArray(chats)) return;
    restoring = false;
    const idle = chatOf(state) === null && !state['lines']?.length && !state['utterance']; // nothing begun in the meantime
    const last = settings().lastChat;
    if (last === null || !idle) return;
    if (chats.some((c) => c?.id === last)) relay.openChat(last);
    else change({ lastChat: null }); // it is gone
  }

  /** The chat on screen is the one to reopen next time. */
  function remember() {
    if (restoring) return;
    const id = chatOf(read());
    if (id === lastId) return;
    lastId = id;
    if (id !== settings().lastChat) change({ lastChat: id });
  }

  /** The relay's word that the chat on screen is working, handed to the session. */
  function mirrorWorking() {
    const state = read();
    const chats = state['chats'];
    const id = chatOf(state);
    if (!remind && chats === seenChats && id === seenId) return;
    remind = false;
    seenChats = chats;
    seenId = id;
    session.working = (Array.isArray(chats) ? chats : []).find((c) => c?.id === id)?.working === true;
  }

  store.subscribe(() => {
    showLoaded();
    restore();
    remember();
    mirrorWorking();
  });

  /** A blank conversation: what "New chat" is, and what deleting the chat on screen leaves. */
  const newChat = () => session.show([], null);

  return {
    newChat,
    deleteChat(id) {
      relay.deleteChat(id);
      if (read()['chatId'] === id) newChat();
    },
  };
}
