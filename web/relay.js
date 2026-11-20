// @ts-check
// The page's connection to what the relay owns, on the `?data=1` socket: corrections, the
// prompts it says to each model, the models and skills Claude Code offers, the chats, one
// chat's messages when asked for, and the clips and pictures behind them. The port of
// `RelayStore` in Corrections.swift, and held the same way `VoiceSession` holds its own: a
// relay that is not up yet, a laptop that slept, or a restarted process costs a reconnect and
// not a screen that stays empty for the life of the page.
//
// The relay owns the files and this keeps nothing of its own: every message is answered with
// all of the state, so what is in the store is what is on disk. `?data=1` opens neither Gemini
// nor Claude, so holding it costs nothing whether or not a voice session is running. `connected`
// is true once a frame has come back, which is proof of a relay where an open socket is only
// proof of a port, and false the moment the socket goes.
//
// Media is the one thing here that is not a state frame, and its answers carry no id. The relay
// answers `clip_get` and `image_get` with one binary frame BEFORE the usual state frames if the
// file exists, and with just the state frames if not, so the first frame back decides. That only
// works if a reply cannot be taken for another request's, so media is asked one request at a
// time, and a request holds its place until its whole answer has arrived (the chat list is the
// last frame of every answer) — the tail of one answer is never read as the start of the next.
// The state frames of some other request still in flight, a star or a rename sent a moment
// before, would be read as "no file": media is for taps, not for the same instant as an edit.
//
// The socket, the timers and the store are handed in, so a test can play the relay by hand.

/** @typedef {import('./session.js').SocketLike} SocketLike */
/** @typedef {import('./transcript.js').ChatMessage} ChatMessage */

/**
 * What the relay hears, and what was meant; `clip` is the utterance it was taught from, which the
 * relay keeps as a file (a correction made by hand has none).
 * @typedef {{ at: number, heard: string, meant: string, clip?: number, proposed?: string }} Correction
 */
/** One model Claude Code offers this account, as it describes it. `resolvedModel`: what an alias really runs. @typedef {{ value: string, displayName: string, description: string, resolvedModel?: string, supportsEffort?: boolean, supportedEffortLevels?: string[] }} ClaudeModel */
/** One skill the project offers: `/name` as an instruction runs it. @typedef {{ name: string, description: string, argumentHint: string }} SkillInfo */
/** What the relay says to a model: `live` is whether an edit reaches the session already running. @typedef {{ name: string, title: string, detail: string, live: boolean, text: string }} Prompt */
/** One conversation Claude Code has in this project. @typedef {{ id: string, at: number, title: string, starred?: boolean, working?: boolean }} Chat */
/** The one chat asked for with `openChat` or made by `fork`. @typedef {{ id: string, messages: ChatMessage[], forked: boolean }} LoadedChat */

/** @typedef {{ get: () => Record<string, any>, set: (patch: Record<string, any>) => void }} RelayStoreLike */

/**
 * @typedef {{
 *   store: RelayStoreLike,
 *   urlFor: () => string,
 *   makeSocket: (url: string) => SocketLike,
 *   setTimer: (fn: () => void, ms: number) => () => void,
 * }} RelayDeps
 */

/** @typedef {{ frame: { type: 'clip_get' | 'image_get', id: number }, mime: string, resolve: (blob: Blob | null) => void }} MediaRequest */
/** @typedef {{ req: MediaRequest, answered: boolean, cancel: () => void }} Outstanding */

const OPEN = 1; // WebSocket.OPEN, without reaching for the global
const FIRST_BACKOFF = 250;
const MAX_BACKOFF = 5000;
/** A connection that lasted longer than this was not a failing one. */
const LASTED = 5000;
/** A media request not answered in this is given up on, so one that never comes cannot jam the queue. */
const MEDIA_TIMEOUT = 10_000;
const DOWN = 'The relay is not answering.';

export class RelayStore {
  #store;
  #urlFor;
  #makeSocket;
  #setTimer;

  /** Someone wants a data socket held: the loop runs on this, and only `disconnect` ends it. */
  #wanted = false;
  /** @type {SocketLike | null} the current socket, open or still connecting */
  #socket = null;
  #backoff = FIRST_BACKOFF;
  /** @type {(() => void) | null} */
  #cancelRetry = null;
  /** @type {(() => void) | null} fires once this socket has lasted: the next drop starts the backoff over */
  #cancelStable = null;
  /** The relay has answered `read` in full on this socket, so nothing earlier is still on its way. */
  #settled = false;

  /** @type {MediaRequest[]} asked for, not yet sent */
  #queue = [];
  /** @type {Outstanding | null} sent, and its answer not yet over */
  #outstanding = null;

  /** @param {RelayDeps} deps */
  constructor({ store, urlFor, makeSocket, setTimer }) {
    this.#store = store;
    this.#urlFor = urlFor;
    this.#makeSocket = makeSocket;
    this.#setTimer = setTimer;
  }

  // MARK: holding the socket

  /** Hold a data socket for as long as someone wants one. Asking again does nothing. */
  connect() {
    if (this.#wanted) return;
    this.#wanted = true;
    this.#backoff = FIRST_BACKOFF;
    this.#store.set({ connected: false });
    this.#dial();
  }

  disconnect() {
    this.#wanted = false;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#cancelStable?.();
    this.#cancelStable = null;
    const socket = this.#socket;
    this.#socket = null; // first, so its close is not mistaken for a drop
    socket?.close();
    this.#settled = false;
    this.#failMedia();
    this.#store.set({ connected: false });
  }

  #dial() {
    const socket = this.#makeSocket(this.#urlFor());
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;
    this.#settled = false;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#send({ type: 'read' }); // anything is answered with all of it
      this.#cancelStable = this.#setTimer(() => {
        this.#cancelStable = null;
        this.#backoff = FIRST_BACKOFF;
      }, LASTED + 1);
    };
    socket.onmessage = (ev) => {
      if (this.#socket === socket) this.#receive(ev.data);
    };
    // a failure is followed by a close, which is where it is answered
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.#socket === socket) this.#lose();
    };
  }

  /** The socket is gone, from under a page that still wants one: say so, and redial. */
  #lose() {
    this.#socket = null;
    this.#cancelStable?.();
    this.#cancelStable = null;
    this.#settled = false;
    this.#failMedia();
    if (this.#store.get()['connected'] !== false || this.#store.get()['relayError'] !== DOWN) {
      this.#store.set({ connected: false, relayError: DOWN });
    }
    if (!this.#wanted) return;
    const wait = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF);
    this.#cancelRetry = this.#setTimer(() => {
      this.#cancelRetry = null;
      if (this.#wanted) this.#dial();
    }, wait);
  }

  get #open() {
    return this.#socket !== null && this.#socket.readyState === OPEN;
  }

  /** Said to the relay now, or not at all: an edit made with no relay there is not queued for the next one. @param {object} msg */
  #send(msg) {
    if (this.#open) this.#socket?.send(JSON.stringify(msg));
  }

  // MARK: what comes back

  /** @param {unknown} data */
  #receive(data) {
    if (typeof data !== 'string') {
      this.#binary(data);
      return;
    }
    /** @type {any} */
    let f;
    try {
      f = JSON.parse(data);
    } catch {
      return; // not a frame this client can read
    }
    if (typeof f !== 'object' || f === null || Array.isArray(f)) return;

    // A frame came back, so there is a relay there — whatever it said.
    /** @type {Record<string, any>} */
    const patch = { connected: true, relayError: null };
    switch (f.type) {
      case 'relay':
        if (typeof f.version === 'string') patch['relayVersion'] = f.version;
        break;
      case 'corrections':
        if (Array.isArray(f.items)) patch['corrections'] = [...f.items].reverse(); // newest first
        break;
      case 'prompts':
        if (Array.isArray(f.prompts)) patch['prompts'] = f.prompts;
        break;
      case 'models':
        if (Array.isArray(f.models)) patch['models'] = f.models;
        break;
      case 'skills':
        if (Array.isArray(f.skills)) patch['skills'] = f.skills;
        break;
      case 'chats':
        if (Array.isArray(f.chats)) patch['chats'] = f.chats; // already newest first
        break;
      case 'chat':
        if (typeof f.id === 'string' && Array.isArray(f.messages)) patch['loaded'] = { id: f.id, messages: f.messages, forked: f.forked === true };
        break;
    }
    // The media queue first, then the store: a subscriber is told inside `set`, and one that asks
    // for a picture right there must find this frame already over, not read it as the first
    // frame of that request's answer (or, if it throws, leave the slot held).
    this.#text(f.type);
    this.#store.set(patch);
  }

  // MARK: clips and pictures

  /**
   * The audio of an utterance, or null if the relay no longer has it (or does not answer).
   * @param {number} id
   * @returns {Promise<Blob | null>}
   */
  clip(id) {
    return this.#ask('clip_get', id, 'audio/wav');
  }

  /**
   * A picture that was attached, or null.
   * @param {number} id
   * @returns {Promise<Blob | null>}
   */
  image(id) {
    return this.#ask('image_get', id, 'image/jpeg');
  }

  /** @param {'clip_get' | 'image_get'} type @param {number} id @param {string} mime @returns {Promise<Blob | null>} */
  #ask(type, id, mime) {
    return new Promise((resolve) => {
      // No socket at all — never connected, or between a drop and the redial — is an answer.
      // One that is still opening is worth waiting for: the request goes out once the relay has spoken.
      if (this.#socket === null) {
        resolve(null);
        return;
      }
      this.#queue.push({ frame: { type, id }, mime, resolve });
      this.#next();
    });
  }

  /** Send the next request if nothing is outstanding and the relay has finished its first answer. */
  #next() {
    if (this.#outstanding || !this.#settled || !this.#open) return;
    const req = this.#queue.shift();
    if (!req) return;
    const outstanding = { req, answered: false, cancel: () => {} };
    this.#outstanding = outstanding;
    outstanding.cancel = this.#setTimer(() => this.#timedOut(outstanding), MEDIA_TIMEOUT);
    this.#send(req.frame);
  }

  /** @param {unknown} data */
  #binary(data) {
    const o = this.#outstanding;
    if (!o || o.answered) return; // nobody asked
    o.answered = true;
    o.req.resolve(new Blob([/** @type {BlobPart} */ (data)], { type: o.req.mime }));
  }

  /** @param {string} type the frame's `type`, once the store has it */
  #text(type) {
    const o = this.#outstanding;
    if (o && !o.answered) {
      o.answered = true;
      o.req.resolve(null); // text first: there was no file
    }
    if (type !== 'chats') return;
    // The last frame of every answer: this one is over, and the next may be asked.
    this.#settled = true;
    if (o) {
      o.cancel();
      this.#outstanding = null;
    }
    this.#next();
  }

  /**
   * The relay did not finish answering. A reply that came late on this socket could be taken for
   * the next request's, so this socket is let go of, and the redial starts clean.
   * @param {Outstanding} o
   */
  #timedOut(o) {
    if (this.#outstanding !== o) return;
    const socket = this.#socket;
    this.#socket = null; // first, so its close is not read as a second drop
    socket?.close();
    this.#lose();
  }

  /** Nobody is going to be answered: everything asked, sent or not, is null. */
  #failMedia() {
    const o = this.#outstanding;
    const queued = this.#queue;
    this.#outstanding = null;
    this.#queue = [];
    if (o) {
      o.cancel();
      if (!o.answered) o.req.resolve(null);
    }
    for (const req of queued) req.resolve(null);
  }

  // MARK: edits

  /** Save a correction: a new one by its `at`, or the same `at` again to edit it. @param {Correction} c */
  saveCorrection({ at, heard, meant, clip, proposed }) {
    /** @type {Record<string, unknown>} */
    const msg = { type: 'correction_save', at, heard, meant };
    if (clip != null) msg['clip'] = clip;
    if (proposed != null) msg['proposed'] = proposed;
    this.#send(msg);
  }

  /** @param {number} at */
  deleteCorrection(at) {
    this.#send({ type: 'correction_delete', at });
  }

  /** @param {string} name @param {string} text */
  savePrompt(name, text) {
    this.#send({ type: 'prompt_save', name, text });
  }

  /**
   * Ask for one chat's messages. The loaded chat is forgotten before it is asked for again, so
   * the answer is a change even when it is the same chat as last time: whoever opens a chat when
   * `loaded` changes would otherwise see the old id, and show the transcript as it was.
   * @param {string} id
   */
  openChat(id) {
    this.#store.set({ loaded: null });
    this.#send({ type: 'chat_open', id });
  }

  /** Branch `id` at one of its messages. The answer is the new chat, already loaded, with `forked` set. @param {string} id @param {string} at */
  fork(id, at) {
    this.#send({ type: 'fork', id, at });
  }

  /** The three things done to a chat without opening it each come back as the whole list again. @param {string} id @param {boolean} on */
  star(id, on) {
    this.#send({ type: 'chat_star', id, starred: on });
  }

  /** @param {string} id @param {string} title */
  rename(id, title) {
    this.#send({ type: 'chat_rename', id, text: title });
  }

  /** @param {string} id */
  deleteChat(id) {
    this.#send({ type: 'chat_delete', id });
  }
}
