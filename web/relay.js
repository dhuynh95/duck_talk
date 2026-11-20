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
// Media is the one thing here that is not a state frame, and it does not travel on this socket.
// The relay answers `clip_get` and `image_get` with one binary frame BEFORE the usual state frames
// if the file exists, and with just the state frames if not, and the answer carries no id. On
// this socket, which the relay also pushes a fresh chat list to whenever a chat starts or stops
// working, that cannot be told from the answer to anything else asked at the same moment: a push
// landing between the request and its audio reads as "no file", and the audio is then read as
// the answer to whatever was asked next. So each request gets a socket of its own, as the phone's
// `Relay.ask` does: open, ask, and the first frame that is the answer decides — the binary frame
// is the file, `corrections` (always the first state frame of an answer) is "no file", and the
// greeting and a pushed chat list are neither. Then it is closed. A few run at once (CONCURRENT),
// each is given up on if the relay does not answer (MEDIA_TIMEOUT), and none of it touches
// `connected` or the data socket's own state.
//
// An answer is one of two kinds, and they are kept apart because what the page does about them
// differs. The relay SAID there is no file: `null`, a fact that stays true, drawn as "No audio". The
// relay could not be asked, or did not say — a refused socket, one that dropped, a timeout, a page
// that has let go of the relay: the promise REJECTS with an Error whose message is a sentence a
// person can read, drawn as a failure with a Retry. A phone on a bad network must not leave a
// permanent "No audio" behind, so nothing here remembers a failure: asking again is a new question.
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

/** @typedef {{ type: 'clip_get' | 'image_get', id: number, mime: string, resolve: (blob: Blob | null) => void, reject: (why: Error) => void }} MediaRequest */

const OPEN = 1; // WebSocket.OPEN, without reaching for the global
const FIRST_BACKOFF = 250;
const MAX_BACKOFF = 5000;
/** A connection that lasted longer than this was not a failing one. */
const LASTED = 5000;
/** A media request not answered in this, from the moment its socket is made, is given up on. */
const MEDIA_TIMEOUT = 10_000;
/** How many media sockets are open at once: a chat of twenty pictures is a queue, not twenty connections. */
const CONCURRENT = 3;
const DOWN = 'The relay is not answering.';
// Why a media request failed, for whoever draws the Retry.
const NOT_CONNECTED = 'The relay is not connected.';
const UNREACHABLE = 'Could not reach the relay.';
const LOST = 'The connection to the relay was lost.';
const TOO_SLOW = 'The relay did not answer in time.';

// MARK: rows

// The relay's lists are drawn row by row by code that reads a field and calls a string method on
// it, inside a store write that tells every screen at once. One row of the wrong shape would throw
// there — and a screen that did not hear about the write is a screen that is wrong until the next
// one — so a row that could not be drawn is not stored: the others are. A field that is missing is
// fine; only one that is there and of a type the page would trip on is not.

/** @param {unknown} v @returns {v is Record<string, any>} */
const isRow = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const isString = (v) => typeof v === 'string';
/** @param {unknown} v @param {'string' | 'number'} type */
const maybe = (v, type) => v === undefined || typeof v === type;

/**
 * The rows of a list the page can draw.
 * @template T
 * @param {unknown[]} rows
 * @param {(row: Record<string, any>) => boolean} fits
 * @returns {T[]}
 */
function keep(rows, fits) {
  return /** @type {T[]} */ (rows.filter((row) => isRow(row) && fits(row)));
}

/** @param {Record<string, any>} m */
const isModel = (m) =>
  isString(m['value']) &&
  maybe(m['displayName'], 'string') &&
  maybe(m['description'], 'string') &&
  maybe(m['resolvedModel'], 'string') &&
  (m['supportedEffortLevels'] === undefined || (Array.isArray(m['supportedEffortLevels']) && m['supportedEffortLevels'].every(isString)));
/** @param {Record<string, any>} c */
const isCorrection = (c) => typeof c['at'] === 'number' && isString(c['heard']) && isString(c['meant']) && maybe(c['clip'], 'number');
/** @param {Record<string, any>} p */
const isPrompt = (p) => isString(p['name']) && isString(p['title']) && isString(p['text']) && maybe(p['detail'], 'string');
/** @param {Record<string, any>} k */
const isSkill = (k) => isString(k['name']) && maybe(k['description'], 'string') && maybe(k['argumentHint'], 'string');
/** @param {Record<string, any>} c */
const isChat = (c) => isString(c['id']) && maybe(c['title'], 'string') && maybe(c['at'], 'number');

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

  /** @type {MediaRequest[]} asked for, no socket yet */
  #queue = [];
  /** @type {Set<() => void>} how to abandon each media request that has a socket */
  #active = new Set();

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
    this.#failMedia();
    this.#store.set({ connected: false });
  }

  #dial() {
    const socket = this.#makeSocket(this.#urlFor());
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;
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
    if (typeof data !== 'string') return; // media comes on sockets of its own: nothing is asked of this one in binary
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
        if (Array.isArray(f.items)) patch['corrections'] = keep(f.items, isCorrection).reverse(); // newest first
        break;
      case 'prompts':
        if (Array.isArray(f.prompts)) patch['prompts'] = keep(f.prompts, isPrompt);
        break;
      case 'models':
        if (Array.isArray(f.models)) patch['models'] = keep(f.models, isModel); // [] is an answer: none, which is not "not yet"
        break;
      case 'skills':
        if (Array.isArray(f.skills)) patch['skills'] = keep(f.skills, isSkill);
        break;
      case 'chats':
        if (Array.isArray(f.chats)) patch['chats'] = keep(f.chats, isChat); // already newest first
        break;
      case 'chat':
        if (typeof f.id === 'string' && Array.isArray(f.messages)) patch['loaded'] = { id: f.id, messages: f.messages, forked: f.forked === true };
        break;
    }
    this.#store.set(patch);
  }

  // MARK: clips and pictures

  /**
   * The audio of an utterance: a Blob, or null when the relay says it no longer has it. Rejects, with
   * an Error to be read aloud, when the relay could not be asked or did not answer — and asking again
   * is a new question.
   * @param {number} id
   * @returns {Promise<Blob | null>}
   */
  clip(id) {
    return this.#ask('clip_get', id, 'audio/wav');
  }

  /**
   * A picture that was attached: a Blob, or null when the relay has none; rejects as `clip` does.
   * @param {number} id
   * @returns {Promise<Blob | null>}
   */
  image(id) {
    return this.#ask('image_get', id, 'image/jpeg');
  }

  /** @param {'clip_get' | 'image_get'} type @param {number} id @param {string} mime @returns {Promise<Blob | null>} */
  #ask(type, id, mime) {
    return new Promise((resolve, reject) => {
      // Nobody wants the relay (never connected, or let go of): there is nothing to ask, which is
      // not the relay saying there is no file. A relay that is merely between a drop and its redial
      // is still worth asking.
      if (!this.#wanted) {
        reject(new Error(NOT_CONNECTED));
        return;
      }
      this.#queue.push({ type, id, mime, resolve, reject });
      this.#pump();
    });
  }

  /** Give the next waiting requests a socket, up to the few that may be open at once. */
  #pump() {
    while (this.#active.size < CONCURRENT) {
      const req = this.#queue.shift();
      if (!req) return;
      this.#fetch(req);
    }
  }

  /**
   * One request on one socket. Settled exactly once — by an answer, a closed or failed socket, or
   * the timeout — and then the socket is let go of, so nothing it says later is anybody's.
   * @param {MediaRequest} req
   */
  #fetch(req) {
    /** @type {SocketLike} */
    let socket;
    try {
      socket = this.#makeSocket(this.#urlFor());
    } catch {
      req.reject(new Error(UNREACHABLE)); // an address the browser will not dial: the relay was never asked
      return;
    }
    socket.binaryType = 'arraybuffer';
    let cancelTimer = () => {};
    let settled = false;
    let opened = false;
    /** @param {Blob | null | Error} outcome the relay's answer, or why there was none */
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      cancelTimer();
      this.#active.delete(abandon);
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch {
        // already gone
      }
      this.#pump(); // before the answer is told, so a caller that asks for more finds the slot free
      if (outcome instanceof Error) req.reject(outcome);
      else req.resolve(outcome);
    };
    /** The socket went before the relay said anything: refused if it never opened. */
    const lost = () => settle(new Error(opened ? LOST : UNREACHABLE));
    const abandon = () => settle(new Error(NOT_CONNECTED));
    this.#active.add(abandon);
    cancelTimer = this.#setTimer(() => settle(new Error(TOO_SLOW)), MEDIA_TIMEOUT);

    socket.onopen = () => {
      opened = true;
      socket.send(JSON.stringify({ type: req.type, id: req.id }));
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        settle(new Blob([/** @type {BlobPart} */ (ev.data)], { type: req.mime }));
        return;
      }
      // Text before any audio. The state frames of an answer start with `corrections`, so that one
      // means the relay had no file; the greeting, and a chat list pushed to every data connection,
      // are about something else and are waited past.
      let type;
      try {
        type = JSON.parse(ev.data)?.type;
      } catch {
        return;
      }
      if (type === 'corrections') settle(null);
    };
    // A failure is always followed by a close, but there is no reason to wait for it.
    socket.onerror = lost;
    socket.onclose = lost;
  }

  /** Nobody is going to be answered: everything asked, with a socket or without, is a failure. */
  #failMedia() {
    const queued = this.#queue;
    this.#queue = [];
    for (const abandon of [...this.#active]) abandon();
    for (const req of queued) req.reject(new Error(NOT_CONNECTED));
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
