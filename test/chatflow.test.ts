import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chatFlow } from '../web/chat-flow.js';
import { VoiceSession } from '../web/session.js';
import { createStore } from '../web/store.js';

// The real store and the real session, with the socket, the pipe and the timers played by hand
// (as in session.test.ts): the relay's answers are written into the store the way RelayStore
// writes them, `chats` first and `chat` after, and what is asserted is what the session did.

class FakeSocket {
  url: string;
  readyState = 0;
  binaryType = 'blob';
  closedByClient = false;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send() {}
  close() {
    this.closedByClient = true;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
}

const DEFAULTS = { mode: 'direct', model: 'default', effort: 'default', permission: 'plan', autocorrect: false, output: true, gate: true };

const msg = (uuid: string, role: 'user' | 'model', text: string) => ({ uuid, role, text });
const THREAD = [msg('u1', 'user', 'hello'), msg('m1', 'model', 'hi'), msg('u2', 'user', 'again'), msg('m2', 'model', 'yes')];

function rig({ lastChat = null as string | null } = {}) {
  const sockets: FakeSocket[] = [];
  const store = createStore<Record<string, any>>({});
  const session = new VoiceSession({
    store,
    urlFor: (p: { resume?: string }) => `ws://relay/?mode=direct${p.resume ? `&resume=${p.resume}` : ''}`,
    makeSocket: (url: string) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s as any;
    },
    makePipe: () => {
      throw new Error('no microphone in this test');
    },
    setTimer: () => () => {},
    now: () => 0,
  });

  let settings = { ...DEFAULTS, lastChat };
  /** What was written as `lastChat`, in order. */
  const saved: (string | null)[] = [];
  const change = (patch: Record<string, unknown>) => {
    settings = { ...settings, ...patch } as typeof settings;
    saved.push(settings.lastChat);
    store.set({ settings });
  };
  /** What the relay was asked to open and to delete. RelayStore forgets the loaded chat before it asks. */
  const asked = { open: [] as string[], deleted: [] as string[] };
  const relay = {
    openChat(id: string) {
      asked.open.push(id);
      store.set({ loaded: null });
    },
    deleteChat(id: string) {
      asked.deleted.push(id);
    },
  };
  const flow = chatFlow({ store, session, relay: relay as any, settings: () => settings as any, change });

  /** The relay's answer to `chat_open` or `fork`: the list, then the chat (server.ts). */
  const answer = (chats: { id: string; working?: boolean }[], chat?: { id: string; messages?: unknown[]; forked?: boolean }) => {
    store.set({ connected: true, chats: chats.map((c) => ({ at: 1, title: c.id, ...c })) });
    if (chat) store.set({ loaded: { id: chat.id, messages: chat.messages ?? THREAD, forked: chat.forked === true } });
  };
  /** Sockets the session is holding right now. */
  const held = () => sockets.filter((s) => s.readyState !== 3);
  return { store, session, sockets, saved, asked, flow, answer, held, state: () => store.get(), settings: () => settings };
}

const A = { id: 'A', working: true };
const B = { id: 'B', working: false };

describe('chatFlow: opening a chat', () => {
  it('shows the chat that arrives, under its id', () => {
    const { answer, state } = rig();
    answer([B], { id: 'B' });
    assert.equal(state()['chatId'], 'B');
    assert.equal(state()['lines'].length, 4);
  });

  it('shows a fork, which arrives as an already-loaded chat with `forked` set', () => {
    const { answer, state, settings } = rig();
    answer([B, { id: 'F' }], { id: 'F', messages: THREAD.slice(0, 2), forked: true });
    assert.equal(state()['chatId'], 'F');
    assert.equal(state()['lines'].length, 2);
    assert.equal(settings().lastChat, 'F');
  });

  it('shows the chat once however often the store is written after it, and again when the same chat is asked for again', () => {
    const { answer, store, asked, state } = rig();
    answer([B], { id: 'B' });
    const first = state()['lines'];
    store.set({ level: 0.5 });
    store.set({ level: 0.6 });
    assert.equal(state()['lines'], first, 'levels are not a reason to show it again');
    store.set({ loaded: null });
    answer([B], { id: 'B', messages: THREAD.slice(0, 1) });
    assert.equal(state()['lines'].length, 1);
    assert.deepEqual(asked.open, []);
  });
});

describe('chatFlow: watching a chat that is working', () => {
  it('holds a socket resumed on a working chat when it is shown, and none for one that is not', () => {
    const { answer, held, session } = rig();
    answer([A, B], { id: 'A' });
    assert.equal(session.working, true);
    assert.deepEqual(held().map((s) => s.url), ['ws://relay/?mode=direct&resume=A']);
  });

  it('opening the chat that is already on screen, while Claude is working in it, attaches to it again', () => {
    const { answer, held, session, sockets, state, store } = rig();
    answer([A, B], { id: 'A' });
    assert.equal(held().length, 1);
    const before = sockets.length;

    // Tapped in the drawer: the loaded chat is forgotten, and the relay answers with the list, then the chat.
    store.set({ loaded: null });
    answer([A, B], { id: 'A' });

    assert.equal(session.working, true, 'the relay still says it is working');
    assert.equal(state()['working'], true);
    assert.deepEqual(held().map((s) => s.url), ['ws://relay/?mode=direct&resume=A'], 'one socket, on that chat');
    assert.ok(sockets.length > before, 'the one it had was dropped by showing the chat, and this is a new one');
  });

  it('opening a working chat that was not the one on screen attaches to it, and only to it', () => {
    const { answer, held, sockets } = rig();
    answer([A, { id: 'C', working: true }, B], { id: 'A' });
    sockets.length = 0;
    answer([A, { id: 'C', working: true }, B], { id: 'C' });
    assert.deepEqual(
      sockets.map((s) => s.url),
      ['ws://relay/?mode=direct&resume=C'],
      'nothing was dialled for the chat that was left',
    );
    assert.deepEqual(held().map((s) => s.url), ['ws://relay/?mode=direct&resume=C']);
  });

  it('leaving a working chat for one that is not lets the socket go, and dials nothing', () => {
    const { answer, held, sockets, session } = rig();
    answer([A, B], { id: 'A' });
    sockets.length = 0;
    answer([A, B], { id: 'B' });
    assert.equal(session.working, false);
    assert.equal(held().length, 0);
    assert.deepEqual(sockets, [], 'not even for a moment, for the chat that was left');
  });

  it('lets the socket go when the relay says the chat has stopped working', () => {
    const { answer, held, session } = rig();
    answer([A, B], { id: 'A' });
    answer([{ id: 'A', working: false }, B]);
    assert.equal(session.working, false);
    assert.equal(held().length, 0);
  });

  it('picks a chat up when it starts working while it is on screen', () => {
    const { answer, held } = rig();
    answer([{ id: 'A', working: false }, B], { id: 'A' });
    assert.equal(held().length, 0);
    answer([A, B]);
    assert.deepEqual(held().map((s) => s.url), ['ws://relay/?mode=direct&resume=A']);
  });
});

describe('chatFlow: the chat to reopen next time', () => {
  it('writes the chat that was opened, and writes it once when switching from another', () => {
    const { answer, saved, settings } = rig();
    answer([A, B], { id: 'A' });
    assert.deepEqual(saved, ['A']);
    saved.length = 0;
    answer([A, B], { id: 'B' });
    assert.deepEqual(saved, ['B'], 'once, and with the chat switched to: not B, A, B');
    assert.equal(settings().lastChat, 'B');
  });

  it('does not write what is already kept', () => {
    const { answer, saved } = rig({ lastChat: 'B' });
    answer([A, B], { id: 'B' });
    assert.deepEqual(saved, [], 'restoring B reopened it, and B was already what was kept');
  });

  it('forgets the chat on New chat', () => {
    const { answer, saved, flow, state } = rig();
    answer([A, B], { id: 'B' });
    saved.length = 0;
    flow.newChat();
    assert.equal(state()['chatId'], null);
    assert.deepEqual(saved, [null]);
  });

  it('keeps the chat that is named at the first turn of a new one', () => {
    const { store, saved } = rig();
    store.set({ chatId: 'N1', connected: true, chats: [] }); // what turn_start carries
    assert.deepEqual(saved, ['N1']);
  });
});

describe('chatFlow: coming back to the chat that was open', () => {
  it('asks for it once the list of chats has it', () => {
    const { answer, asked, saved } = rig({ lastChat: 'A' });
    assert.deepEqual(asked.open, [], 'nothing is asked before the list says it exists');
    answer([B, A]);
    assert.deepEqual(asked.open, ['A']);
    assert.deepEqual(saved, [], 'and the memory is not wiped while it is on its way');
  });

  it('asks for it only once, however many lists come after', () => {
    const { answer, asked, store } = rig({ lastChat: 'A' });
    answer([A, B]);
    answer([A, B]);
    store.set({ chats: [A, B] });
    assert.deepEqual(asked.open, ['A']);
  });

  it('opens it when the answer arrives, and then it is the chat on screen', () => {
    const { answer, state } = rig({ lastChat: 'B' });
    answer([A, B]);
    answer([A, B], { id: 'B' });
    assert.equal(state()['chatId'], 'B');
  });

  it('does not ask for a chat the relay does not have, and forgets it', () => {
    const { answer, asked, saved, settings } = rig({ lastChat: 'gone' });
    answer([A, B]);
    assert.deepEqual(asked.open, []);
    assert.deepEqual(saved, [null]);
    assert.equal(settings().lastChat, null);
  });

  it('does not ask for anything when nothing was kept', () => {
    const { answer, asked, saved } = rig();
    answer([A, B]);
    assert.deepEqual(asked.open, []);
    assert.deepEqual(saved, []);
  });

  it('does not take the screen back from something begun while the list was on its way', () => {
    const { answer, asked, store, saved } = rig({ lastChat: 'A' });
    store.set({ lines: [{ id: 1, kind: 'user', text: 'already typing', tools: [], running: false, given: [] }] });
    answer([A, B]);
    assert.deepEqual(asked.open, []);
    assert.deepEqual(saved, [], 'what was kept is left for the new chat to replace when it has a name');
  });
});

describe('chatFlow: deleting the chat on screen', () => {
  it('asks the relay, and clears the screen when it was the open one', () => {
    const { answer, flow, asked, state, saved } = rig();
    answer([A, B], { id: 'B' });
    saved.length = 0;
    flow.deleteChat('B');
    assert.deepEqual(asked.deleted, ['B']);
    assert.equal(state()['chatId'], null);
    assert.equal(state()['lines'].length, 0);
    assert.deepEqual(saved, [null], 'and it is not the one reopened next time');
  });

  it('leaves the screen alone when it was some other chat', () => {
    const { answer, flow, asked, state } = rig();
    answer([A, B], { id: 'B' });
    flow.deleteChat('A');
    assert.deepEqual(asked.deleted, ['A']);
    assert.equal(state()['chatId'], 'B');
    assert.equal(state()['lines'].length, 4);
  });

  it('lets go of the socket held for the chat that was deleted', () => {
    const { answer, flow, held } = rig();
    answer([A, B], { id: 'A' });
    assert.equal(held().length, 1);
    flow.deleteChat('A');
    assert.equal(held().length, 0);
  });
});
