// @ts-check
// One conversation with Claude, on one socket, reached by talking or by typing: the plumbing
// half of `VoiceSession.swift` (the rules are transcript.js). Typing is a text frame on the
// socket, talking is the AudioPipe's frames on the same socket, and watching is just being
// connected — a working chat streams its turn as it goes.
//
// The socket is held while there is a reason to: the microphone is open, a turn this screen
// sent is in flight, or the relay says the chat is working. When none is true it closes, and
// the relay keeps the chat's work going without it. A drop while one is wanted costs a
// reconnect, not the conversation: the new socket carries `resume=<chatId>`, and is told what
// Claude should be (`claude`), what is attached, and then what was said while there was no
// socket — in that order, on `open`.
//
// The socket, the pipe, the timers and the clock are all handed in, so a test can play the
// relay by hand; importing this touches no browser global. Every callback from the pipe is
// handled synchronously, because the pipe only catches a synchronous throw.

import { Transcript } from './transcript.js';

/** @typedef {import('./transcript.js').Attachment} Attachment */
/** @typedef {import('./transcript.js').ChatMessage} ChatMessage */
/** @typedef {import('./transcript.js').TranscriptState} TranscriptState */
/** @typedef {Pick<WebSocket, 'send' | 'close' | 'readyState' | 'binaryType' | 'onopen' | 'onmessage' | 'onclose' | 'onerror'>} SocketLike */
/** @typedef {Pick<import('./audio.js').AudioPipe, 'onChunk' | 'onLevel' | 'onDrained' | 'onProblem' | 'onAudio' | 'muted' | 'output' | 'gate' | 'chimes' | 'waiting' | 'start' | 'stop' | 'play' | 'flush' | 'expectReply'>} PipeLike */

/**
 * What the screen reads. `status` is the microphone only: `connecting` is the call being placed.
 * @typedef {TranscriptState & {
 *   status: 'idle' | 'connecting' | 'live',
 *   notice: string | null,
 *   level: number,
 *   muted: boolean,
 *   working: boolean,
 * }} SessionState
 */

/**
 * @typedef {{
 *   store: { get: () => Partial<SessionState>, set: (patch: Partial<SessionState>) => void },
 *   urlFor: (params: { resume?: string }) => string,
 *   makeSocket: (url: string) => SocketLike,
 *   makePipe: () => PipeLike,
 *   setTimer: (fn: () => void, ms: number) => () => void,
 *   now: () => number,
 * }} SessionDeps
 */

const OPEN = 1; // WebSocket.OPEN, without reaching for the global
const FIRST_BACKOFF = 250;
const MAX_BACKOFF = 5000;
/** A connection that lasted longer than this was not a failing one. */
const LASTED = 5000;
/** A drop healed inside this is not an event. */
const HEAL_QUIET = 3000;
/** The one notice this class clears on its own, so it can never take down a message someone else put up. */
const HEALING = 'Reconnecting — Claude keeps working.';

export class VoiceSession {
  #store;
  #urlFor;
  #makeSocket;
  #makePipe;
  #setTimer;
  #now;

  #t = new Transcript();
  /** @type {SessionState['status']} */
  #status = 'idle';
  #working = false;

  /** @type {SocketLike | null} the current socket, open or still connecting */
  #socket = null;
  /** Something wants a socket and this class is keeping one: connected, connecting, or waiting to redial. */
  #holding = false;
  #backoff = FIRST_BACKOFF;
  /** @type {number | null} when the current socket opened */
  #openedAt = null;
  /** @type {(() => void) | null} */
  #cancelRetry = null;
  /** @type {(() => void) | null} */
  #cancelHeal = null;
  /**
   * What was said while there was no open socket. It goes out the moment one opens, after the
   * frames that say what Claude should be — the frame that made a socket wanted (a typed
   * instruction, a stop) always arrives before there is a socket to put it on.
   * @type {object[]}
   */
  #outbox = [];

  /** @type {PipeLike | null} from `listen` until `stopListening`, starting or started */
  #pipe = null;

  #model = '';
  #permission = '';
  #effort = '';

  /** The pipe's output, gate and chimes, as chosen: kept here because every `listen` makes a new pipe. */
  #output = true;
  #gate = true;
  #chimes = false;

  /** @param {SessionDeps} deps */
  constructor({ store, urlFor, makeSocket, makePipe, setTimer, now }) {
    this.#store = store;
    this.#urlFor = urlFor;
    this.#makeSocket = makeSocket;
    this.#makePipe = makePipe;
    this.#setTimer = setTimer;
    this.#now = now;
    this.#store.set({ ...this.#t.state, status: 'idle', notice: null, level: 0, muted: false, working: false });
  }

  // MARK: what the screen reads

  /**
   * Everything the transcript holds, plus what this class holds, into the store at once.
   * `notice` is not among them: it is written only when it changes, and the store is its one
   * copy, because others may put one up too.
   */
  #sync() {
    this.#store.set({ ...this.#t.state, status: this.#status, working: this.#working });
  }

  get #wantSocket() {
    return this.#status !== 'idle' || this.#t.state.inFlight || this.#working;
  }

  get #open() {
    return this.#socket !== null && this.#socket.readyState === OPEN;
  }

  // MARK: the one socket

  /** Open or close the socket to match `#wantSocket`. Every path that changes one of its inputs lands here. */
  #reconcile() {
    const want = this.#wantSocket;
    if (want && !this.#holding) {
      this.#holding = true;
      this.#backoff = FIRST_BACKOFF;
      this.#dial();
    } else if (!want && this.#holding) {
      this.#drop();
    }
  }

  /** Close the socket now. The relay keeps the chat's work going without it. */
  #drop() {
    this.#holding = false;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#cancelHeal?.();
    this.#cancelHeal = null;
    const socket = this.#socket;
    this.#socket = null; // first, so its close is not mistaken for a drop
    socket?.close();
    this.#outbox = []; // said to the chat being left, not the next one
    this.#t.forget();
    this.#sync();
  }

  #dial() {
    const chatId = this.#t.state.chatId;
    const socket = this.#makeSocket(this.#urlFor(chatId ? { resume: chatId } : {}));
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;
    this.#openedAt = null;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#openedAt = this.#now();
      this.#sendClaude(); // what Claude should be, before anything is said on it
      for (const a of this.#t.state.attached) this.#sendAttachment(a); // and what is attached
      const queued = this.#outbox; // then what was said while there was no socket
      this.#outbox = [];
      for (const msg of queued) socket.send(JSON.stringify(msg));
      this.#cancelHeal?.();
      this.#cancelHeal = null;
      if (this.#store.get().notice === HEALING) this.#store.set({ notice: null });
      this.#t.setError(null);
      this.#sync();
    };
    socket.onmessage = (ev) => {
      if (this.#socket === socket) this.#receive(ev.data);
    };
    // a failure is followed by a close, which is where it is answered
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.#socket === socket) this.#lost();
    };
  }

  /**
   * The socket went from under a session that still wanted it — a relay restart, a dropped
   * network, a sleeping laptop. Redial, backing off only while connections keep failing fast.
   */
  #lost() {
    const openedAt = this.#openedAt;
    this.#socket = null;
    this.#openedAt = null;
    if (!this.#holding || !this.#wantSocket) {
      this.#holding = false;
      return;
    }
    if (openedAt !== null && this.#now() - openedAt > LASTED) this.#backoff = FIRST_BACKOFF;
    // Silent unless it lasts: counted from the first drop since the socket was last open.
    this.#cancelHeal ??= this.#setTimer(() => {
      this.#cancelHeal = null;
      if (this.#holding && !this.#open) this.#store.set({ notice: HEALING });
    }, HEAL_QUIET);
    const wait = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF);
    this.#cancelRetry = this.#setTimer(() => {
      this.#cancelRetry = null;
      if (this.#holding) this.#dial();
    }, wait);
  }

  /** @param {unknown} data */
  #receive(data) {
    if (typeof data !== 'string') {
      if (data instanceof ArrayBuffer) this.#pipe?.play(data);
      return;
    }
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return; // not a frame this client can read
    }
    const fx = this.#t.handle(event);
    const pipe = this.#pipe;
    if (pipe) {
      if (fx.waiting !== undefined) pipe.waiting = fx.waiting;
      if (fx.expectReply) pipe.expectReply();
      if (fx.flush) pipe.flush();
    }
    this.#sync();
    this.#reconcile(); // a turn_end with nothing else holding the socket closes it
  }

  /**
   * Anything said to the relay. On the open socket now, or in the outbox for the next one — but
   * only while a socket is wanted, so nothing said to no chat lands on the next.
   * @param {object} msg
   */
  #send(msg) {
    if (this.#open) this.#socket?.send(JSON.stringify(msg));
    else if (this.#holding) this.#outbox.push(msg);
  }

  /** The one frame that says what Claude should be. Nothing before `use`: the relay's defaults hold. */
  #sendClaude() {
    if (!this.#model || !this.#permission) return;
    /** @type {Record<string, string>} */
    const msg = { type: 'claude', model: this.#model, permission: this.#permission };
    if (this.#effort) msg['effort'] = this.#effort;
    this.#send(msg);
  }

  /** @param {Attachment} a */
  #sendAttachment(a) {
    this.#send('data' in a ? { type: 'attach', id: a.id, data: a.data } : { type: 'attach', id: a.id, text: a.text });
  }

  /**
   * The pending pieces are about to be moved onto a line. Any not yet on an open socket go
   * into the outbox here, ahead of the frame that follows, since once moved they are no longer
   * pending and a socket opening later would not be told them.
   */
  #queueUnsent() {
    if (this.#open) return;
    for (const a of this.#t.state.attached) {
      this.#outbox.push('data' in a ? { type: 'attach', id: a.id, data: a.data } : { type: 'attach', id: a.id, text: a.text });
    }
  }

  /** A note-only mark: a moment the relay narrates in its log. No timing marks — this clock is not the relay's. @param {string} name @param {string} note */
  #mark(name, note) {
    this.#send({ type: 'mark', name, note });
  }

  // MARK: the conversation on screen

  /**
   * Put a conversation on screen without starting one — opening a past chat, or clearing for a
   * new one. Leaving a chat mid-turn is detaching, never stopping.
   * @param {ChatMessage[]} past
   * @param {string | null} id
   */
  show(past, id) {
    this.stopListening();
    this.#working = false; // the new chat's own word arrives with the next list
    this.#drop();
    this.#t.show(past, id);
    this.#sync();
    this.#reconcile();
  }

  /** Type an instruction: history at once, and the socket opens if nothing held it. @param {string} text */
  send(text) {
    const said = text.trim();
    if (!said) return;
    this.#queueUnsent();
    this.#t.sendTyped(said);
    this.#sync();
    this.#reconcile();
    this.#send({ type: 'text', text: said });
  }

  /** Run the held instruction, as edited on screen. @param {string} text */
  approve(text) {
    if (this.#t.state.pending === null) return;
    this.#queueUnsent();
    this.#t.approve(text);
    this.#sync();
    this.#send({ type: 'approve', text });
  }

  /** Stop Claude's work in this chat — the turn and its background tasks — and the microphone. */
  stopAll() {
    this.#send({ type: 'stop' });
    this.stopListening();
  }

  /** The relay's word that this chat has work in flight: the third reason to hold the socket. */
  get working() {
    return this.#working;
  }
  set working(on) {
    if (on === this.#working) return;
    this.#working = on;
    this.#sync();
    this.#reconcile();
  }

  /** Drop the socket and redial, with whatever `urlFor` now says (mode, auto-correct). */
  reconnect() {
    this.#drop();
    this.#reconcile();
  }

  // MARK: frames out

  /** Say what Claude should be: on the open socket now, and on every one after. @param {{ model: string, permission: string, effort: string }} choice */
  use({ model, permission, effort }) {
    this.#model = model;
    this.#permission = permission;
    this.#effort = effort;
    if (this.#open) this.#sendClaude();
  }

  /**
   * Keep a picture or a pasted text for the next instruction, and tell the socket if one is
   * open. Attachments are state, not events: every socket opening is told all that are
   * pending, so this one is not queued as well — that sent it twice.
   * @param {Attachment} item
   */
  attach(item) {
    this.#t.attach(item);
    this.#sync();
    if (this.#open) this.#sendAttachment(item);
  }

  /**
   * Take one back before it is sent with an instruction, for real. If it is still pending and a
   * socket is open, the relay already holds it — it went out when it was attached, or when the
   * socket opened — so it is told to let go with a `drop` frame. With no socket open it was never
   * sent and nothing is: the next socket is only told what is still pending. A piece already moved
   * onto a line, or one never attached, is no longer pending and says nothing.
   * @param {number} id
   */
  drop(id) {
    if (!this.#t.state.attached.some((a) => a.id === id)) return;
    this.#t.drop(id);
    this.#sync();
    if (this.#open) this.#send({ type: 'drop', id });
  }

  // MARK: the microphone

  /** Play the spoken reply, or not. Held for the next pipe, and told to a live one only on a change. */
  get output() {
    return this.#output;
  }
  set output(on) {
    if (on === this.#output) return;
    this.#output = on;
    if (this.#pipe) this.#pipe.output = on;
  }

  /** Keep the microphone quiet while the reply plays (see AudioPipe `gate`). Held and told like `output`. */
  get gate() {
    return this.#gate;
  }
  set gate(on) {
    if (on === this.#gate) return;
    this.#gate = on;
    if (this.#pipe) this.#pipe.gate = on;
  }

  /** Fill a wait with the chime loop (see AudioPipe `chimes`). Held and told like `output`. */
  get chimes() {
    return this.#chimes;
  }
  set chimes(on) {
    if (on === this.#chimes) return;
    this.#chimes = on;
    if (this.#pipe) this.#pipe.chimes = on;
  }

  /**
   * Start talking. Call it from the tap: the pipe is started here, synchronously, because a
   * browser only opens audio for a page the person has just touched. The socket opens if
   * nothing held it, and the relay opens its ears on the first buffer.
   */
  listen() {
    if (this.#status !== 'idle') return;
    this.#status = 'connecting';
    this.#t.setError(null);
    this.#sync();
    this.#reconcile();

    const pipe = this.#makePipe();
    this.#pipe = pipe;
    if (pipe.output !== this.#output) pipe.output = this.#output;
    if (pipe.gate !== this.#gate) pipe.gate = this.#gate;
    if (pipe.chimes !== this.#chimes) pipe.chimes = this.#chimes;
    pipe.onLevel = (level) => this.#store.set({ level });
    // What the speaker really played: the relay's only way to tell a reply heard from one cut off.
    pipe.onDrained = (ms) => this.#send({ type: 'played', ms: Math.round(ms) });
    pipe.onAudio = (note) => this.#mark('audio', note);
    pipe.onProblem = (message) => {
      this.#t.setError(message);
      this.#sync();
    };
    // Whichever socket is current when the buffer arrives; with none open it is not sent.
    pipe.onChunk = (chunk) => {
      if (this.#open) this.#socket?.send(chunk);
    };

    /** @type {Promise<void>} */
    let started;
    try {
      started = pipe.start();
    } catch (e) {
      started = Promise.reject(e);
    }
    started.then(
      () => {
        if (this.#pipe !== pipe || this.#status !== 'connecting') {
          pipe.stop(); // stopped while starting
          return;
        }
        this.#status = 'live';
        this.#sync();
      },
      (e) => {
        if (this.#pipe !== pipe) return; // a stop came first, and is owed no error
        this.#t.setError(e instanceof Error ? e.message : String(e));
        this.stopListening();
      },
    );
  }

  /**
   * Stop talking. The socket stays if a turn is running — the reply keeps arriving as text —
   * and closes otherwise. Idempotent.
   */
  stopListening() {
    if (this.#status === 'idle') return;
    this.#pipe?.stop();
    this.#pipe = null;
    this.#status = 'idle';
    this.#store.set({ level: 0, muted: false, notice: null }); // the next session starts hearing
    this.#sync();
    this.#reconcile();
  }

  /**
   * Stop being heard, or start again. The pipe keeps sending frames at the same rate, zeroed:
   * the relay reads a gap as the client going away.
   */
  toggleMute() {
    const pipe = this.#pipe;
    if (!pipe || this.#status !== 'live') return;
    const on = !pipe.muted;
    pipe.muted = on;
    this.#mark(on ? 'mute' : 'unmute', 'you');
    this.#store.set({ muted: on, notice: null }); // a mute asked for here makes any notice untrue
  }
}
