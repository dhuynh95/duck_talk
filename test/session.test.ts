import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStore } from '../web/store.js';
import { VoiceSession } from '../web/session.js';

// The session is handed its socket, its audio pipe, its timers and its clock, so a test plays
// the relay by hand: it opens and drops sockets, feeds them frames, and moves time.

class FakeSocket {
  url: string;
  sent: (string | ArrayBuffer)[] = [];
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
  send(data: string | ArrayBuffer) {
    if (this.readyState !== 1) throw new Error('send on a socket that is not open');
    this.sent.push(data);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }
  receiveBinary(buf: ArrayBuffer) {
    this.onmessage?.({ data: buf });
  }
  /** Closed by the session. */
  close() {
    this.closedByClient = true;
    this.drop();
  }
  /** Dropped from the far end: the relay restarted, the network went. */
  drop() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
  /** The JSON frames sent, parsed. */
  get frames() {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d));
  }
}

class FakePipe {
  onChunk: (b: ArrayBuffer) => void = () => {};
  onLevel: (n: number) => void = () => {};
  onDrained: (ms: number) => void = () => {};
  onProblem: (m: string) => void = () => {};
  onAudio: (n: string) => void = () => {};
  muted = false;
  output = true;
  waiting = false;
  gate = true;
  startCalls = 0;
  stopCalls = 0;
  flushes = 0;
  expects = 0;
  played: ArrayBuffer[] = [];
  resolve: () => void = () => {};
  reject: (e: Error) => void = () => {};
  start() {
    this.startCalls++;
    return new Promise<void>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
  stop() {
    this.stopCalls++;
  }
  play(b: ArrayBuffer) {
    this.played.push(b);
  }
  flush() {
    this.flushes++;
  }
  expectReply() {
    this.expects++;
  }
  /** One mic frame, as AudioPipe hands it over: zeroed, same length, while muted. */
  frame(buf: ArrayBuffer) {
    this.onChunk(this.muted ? new ArrayBuffer(buf.byteLength) : buf);
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function rig() {
  let time = 1_000_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const sockets: FakeSocket[] = [];
  const pipes: FakePipe[] = [];
  const store = createStore<Record<string, any>>({});
  const session = new VoiceSession({
    store,
    urlFor: (p: { resume?: string }) => 'ws://relay/?mode=direct' + (p.resume ? `&resume=${p.resume}` : ''),
    makeSocket: (url: string) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s as any;
    },
    makePipe: () => {
      const p = new FakePipe();
      pipes.push(p);
      return p as any;
    },
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: time + ms, fn, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
    now: () => time,
  });
  /** Moves the clock, running each timer that comes due on the way, in order. */
  const advance = (ms: number) => {
    const end = time + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      time = Math.max(time, next.at);
      next.fn();
    }
    time = end;
  };
  const last = () => sockets.at(-1)!;
  const state = () => store.get();
  return { session, store, state, sockets, pipes, advance, last };
}

/** A session with the mic live on an open socket. */
async function live() {
  const r = rig();
  r.session.listen();
  r.pipes[0]!.resolve();
  await tick();
  r.last().open();
  return { ...r, pipe: r.pipes[0]! };
}

describe('VoiceSession: frames out', () => {
  it('delivers a send() made before the socket exists after the claude frame', () => {
    const { session, sockets, last } = rig();
    session.use({ model: 'opus', permission: 'plan', effort: '' });
    assert.equal(sockets.length, 0, 'choosing a model opens nothing');
    session.send('hello');
    assert.equal(sockets.length, 1);
    assert.deepEqual(last().sent, []);
    last().open();
    assert.deepEqual(last().frames, [
      { type: 'claude', model: 'opus', permission: 'plan' },
      { type: 'text', text: 'hello' },
    ]);
  });

  it('carries effort when it is set, and sends no claude frame before one is chosen', () => {
    const { session, last } = rig();
    session.send('a');
    last().open();
    assert.deepEqual(last().frames, [{ type: 'text', text: 'a' }]);
    session.use({ model: 'sonnet', permission: 'acceptEdits', effort: 'high' });
    assert.deepEqual(last().frames.at(-1), { type: 'claude', model: 'sonnet', permission: 'acceptEdits', effort: 'high' });
  });

  it('sends a pending attachment once per socket open, never twice', () => {
    const { session, sockets, last, advance } = rig();
    session.attach({ id: 7, data: 'JPEG' });
    assert.equal(sockets.length, 0, 'an attachment alone opens nothing');
    session.send('look');
    last().open();
    assert.deepEqual(last().frames, [
      { type: 'attach', id: 7, data: 'JPEG' },
      { type: 'text', text: 'look' },
    ]);

    // attached while a socket is up: on it at once; still pending, so a new socket is told too
    session.attach({ id: 8, text: 'pasted' });
    assert.deepEqual(last().frames.at(-1), { type: 'attach', id: 8, text: 'pasted' });
    assert.equal(last().frames.filter((f) => f.type === 'attach' && f.id === 8).length, 1);
    last().drop();
    advance(250);
    last().open();
    assert.deepEqual(last().frames, [{ type: 'attach', id: 8, text: 'pasted' }]);
  });

  it('holds an attachment made while the socket is still connecting until it opens, and sends it once', () => {
    const { session, last } = rig();
    session.send('go');
    session.attach({ id: 3, data: 'J' });
    last().open();
    assert.deepEqual(last().frames, [
      { type: 'attach', id: 3, data: 'J' },
      { type: 'text', text: 'go' },
    ]);
  });

  it('drop() takes a pending attachment back', () => {
    const { session, state } = rig();
    session.attach({ id: 1, data: 'x' });
    session.drop(1);
    assert.deepEqual(state().attached, []);
  });

  // Taking one back is real: with a socket open the relay already holds the attachment, so
  // removing it says so with a `drop` frame; with none open it was never sent and still is not.
  it('drop() of an attachment on an open socket tells the relay to let go of it', () => {
    const { session, last, state } = rig();
    session.send('go');
    last().open();
    session.attach({ id: 7, data: 'JPEG' });
    session.drop(7);
    assert.deepEqual(state().attached, []);
    assert.deepEqual(last().frames.slice(-2), [
      { type: 'attach', id: 7, data: 'JPEG' },
      { type: 'drop', id: 7 },
    ]);
  });

  it('drop() of a pasted text on an open socket sends the same frame', () => {
    const { session, last, state } = rig();
    session.send('go');
    last().open();
    session.attach({ id: 5, text: 'sensitive' });
    session.drop(5);
    assert.deepEqual(state().attached, []);
    assert.deepEqual(last().frames.slice(-2), [
      { type: 'attach', id: 5, text: 'sensitive' },
      { type: 'drop', id: 5 },
    ]);
  });

  it('drop() of an attachment that no socket has seen sends nothing, then or later', () => {
    const { session, sockets, last, state } = rig();
    session.attach({ id: 1, data: 'x' });
    session.drop(1);
    assert.deepEqual(state().attached, []);
    assert.equal(sockets.length, 0, 'nothing wanted a socket');
    session.send('go');
    last().open();
    assert.deepEqual(last().frames, [{ type: 'text', text: 'go' }], 'neither the attach nor a drop for it');
  });

  it('drop() made while the socket is still connecting sends nothing: the attach never went', () => {
    const { session, last } = rig();
    session.send('go');
    session.attach({ id: 2, text: 'held' });
    session.drop(2);
    last().open();
    assert.deepEqual(last().frames, [{ type: 'text', text: 'go' }]);
  });

  it('drop() of an id that is not pending sends nothing', () => {
    const { session, last } = rig();
    session.send('go');
    last().open();
    const before = last().frames.length;
    session.drop(99);
    assert.equal(last().frames.length, before);
  });

  it('drop() of an attachment already given to an instruction sends nothing: it is on a line now, not pending', () => {
    const { session, last } = rig();
    session.attach({ id: 4, data: 'J' });
    session.send('look');
    last().open();
    const before = last().frames.length;
    session.drop(4);
    assert.equal(last().frames.length, before);
  });

  it('drop() of a piece a retract handed back tells the relay, which still holds it for the re-run', async () => {
    const { session, last, state } = await live();
    session.attach({ id: 3, data: 'J' });
    last().receive({ type: 'user', text: 'look at this', partial: false });
    last().receive({ type: 'turn_start', session: 'c1' });
    assert.deepEqual(state().attached, [], 'given to the line');
    last().receive({ type: 'interrupted', retract: true });
    assert.deepEqual(state().attached, [{ id: 3, data: 'J' }], 'handed back under the same id');
    session.drop(3);
    assert.deepEqual(state().attached, []);
    assert.deepEqual(last().frames.at(-1), { type: 'drop', id: 3 });
    assert.equal(last().frames.filter((f) => f.type === 'attach').length, 1, 'never sent again');
  });

  it('a dropped attachment is not sent again when the socket reconnects', () => {
    const { session, last, advance } = rig();
    session.send('go');
    last().open();
    session.attach({ id: 8, text: 'pasted' });
    session.attach({ id: 9, data: 'J' });
    session.drop(8);
    last().drop();
    advance(250);
    last().open();
    assert.deepEqual(last().frames, [{ type: 'attach', id: 9, data: 'J' }], 'only what is still pending');
  });

  it('drop() while the socket is down sends nothing, and the reconnect leaves it out', () => {
    const { session, last, advance } = rig();
    session.send('go');
    last().open();
    session.attach({ id: 6, text: 't' });
    last().drop();
    session.drop(6);
    advance(250);
    last().open();
    assert.deepEqual(last().frames, []);
  });
});

describe('VoiceSession: the socket', () => {
  it('reconnects after 250 ms with resume=<chatId>, doubling to 5000 ms, and resets after a connection that lasted > 5 s', () => {
    const { session, sockets, last, advance } = rig();
    session.send('hi');
    last().open();
    last().receive({ type: 'turn_start', session: 'c1' });
    assert.ok(!sockets[0]!.url.includes('resume'));

    last().drop();
    advance(249);
    assert.equal(sockets.length, 1);
    advance(1);
    assert.equal(sockets.length, 2);
    assert.equal(last().url, 'ws://relay/?mode=direct&resume=c1');

    // each fast failure waits twice as long, up to 5 s
    for (const wait of [500, 1000, 2000, 4000, 5000, 5000]) {
      const n = sockets.length;
      last().drop();
      advance(wait - 1);
      assert.equal(sockets.length, n, `not before ${wait} ms`);
      advance(1);
      assert.equal(sockets.length, n + 1, `after ${wait} ms`);
    }

    // a connection that lasted is not a failing one
    last().open();
    advance(5001);
    const n = sockets.length;
    last().drop();
    advance(250);
    assert.equal(sockets.length, n + 1);
  });

  it('after a mid-turn drop, resumes the chat, sends the claude frame first, and turn_end leaves one user and one model line', () => {
    const { session, state, sockets, last, advance } = rig();
    session.use({ model: 'opus', permission: 'plan', effort: 'low' });
    session.send('hi');
    last().open();
    last().receive({ type: 'turn_start', session: 'c1' });
    last().receive({ type: 'model', text: 'Hello.' });
    last().drop();
    advance(250);
    assert.equal(sockets.length, 2);
    last().open();
    assert.equal(last().url, 'ws://relay/?mode=direct&resume=c1');
    assert.deepEqual(last().frames[0], { type: 'claude', model: 'opus', permission: 'plan', effort: 'low' });
    // the relay attaches the new socket to the running turn, which then ends
    last().receive({ type: 'turn_start', session: 'c1' });
    last().receive({ type: 'turn_end', session: 'c1', user: { uuid: 'u1' }, model: { uuid: 'm1' } });
    const lines = state().lines as { kind: string; uuid?: string; text: string }[];
    assert.deepEqual(
      lines.map((l) => [l.kind, l.text, l.uuid]),
      [
        ['user', 'hi', 'u1'],
        ['model', 'Hello.', 'm1'],
      ],
    );
  });

  it('queues a typed frame while the socket is down and sends it right after the claude frame on the next one', () => {
    const { session, last, advance } = rig();
    session.use({ model: 'opus', permission: 'plan', effort: '' });
    session.send('one');
    last().open();
    last().receive({ type: 'turn_start', session: 'c1' });
    last().drop();
    session.send('two');
    advance(250);
    last().open();
    assert.deepEqual(last().frames, [
      { type: 'claude', model: 'opus', permission: 'plan' },
      { type: 'text', text: 'two' },
    ]);
  });

  it('closes the socket at turn_end when the mic is closed and the chat is not working', () => {
    const { session, sockets, last, advance } = rig();
    session.send('hi');
    last().open();
    last().receive({ type: 'turn_start', session: 'c1' });
    last().receive({ type: 'turn_end', session: 'c1' });
    assert.equal(last().closedByClient, true);
    advance(10_000);
    assert.equal(sockets.length, 1, 'a socket nothing wants is not redialled');
  });

  it('keeps the socket while the chat is working, and closes it when working ends', () => {
    const { session, sockets, last, state } = rig();
    session.working = true;
    assert.equal(state().working, true);
    assert.equal(sockets.length, 1, 'a working chat is watched');
    last().open();
    last().receive({ type: 'turn_start', session: 'c1' });
    last().receive({ type: 'turn_end', session: 'c1' });
    assert.equal(last().closedByClient, false);
    session.working = false;
    assert.equal(last().closedByClient, true);
  });

  it('says it is reconnecting only after 3 s down, clears that on reconnect, and never clears a notice it did not set', () => {
    const { session, store, state, last, advance } = rig();
    session.send('hi');
    last().open();
    last().drop();
    advance(250);
    assert.equal(state().notice, null, 'a drop healed inside a breath is not an event');
    last().drop();
    advance(500);
    last().drop();
    advance(1000);
    last().drop();
    advance(2000);
    assert.equal(state().notice, 'Reconnecting — Claude keeps working.');
    last().open();
    assert.equal(state().notice, null);

    store.set({ notice: 'Someone else' });
    last().open();
    assert.equal(state().notice, 'Someone else');
  });

  it('reconnect() redials with the current url', () => {
    const { session, sockets, last } = rig();
    session.send('hi');
    last().open();
    last().receive({ type: 'turn_start', session: 'c9' });
    session.reconnect();
    assert.equal(sockets[0]!.closedByClient, true);
    assert.equal(sockets.length, 2);
    assert.equal(last().url, 'ws://relay/?mode=direct&resume=c9');
  });

  it('ignores malformed JSON and unknown event types', () => {
    const { session, state, last } = rig();
    session.send('hi');
    last().open();
    const before = state().lines;
    assert.doesNotThrow(() => last().receive('{not json'));
    assert.doesNotThrow(() => last().receive({ type: 'from_the_future', text: 'x' }));
    assert.doesNotThrow(() => last().receive('null'));
    assert.equal(state().lines, before);
  });
});

describe('VoiceSession: the microphone', () => {
  it('listen() calls pipe.start() synchronously, in the tap that asked for it', () => {
    const { session, pipes, state, sockets } = rig();
    session.listen();
    assert.equal(pipes.length, 1);
    assert.equal(pipes[0]!.startCalls, 1);
    assert.equal(state().status, 'connecting');
    assert.equal(sockets.length, 1);
  });

  it('goes live when start() resolves', async () => {
    const { state } = await live();
    assert.equal(state().status, 'live');
  });

  it('on a start() rejection shows the message and stops listening', async () => {
    const { session, pipes, state, sockets } = rig();
    session.listen();
    pipes[0]!.reject(new Error('Microphone permission was denied.'));
    await tick();
    assert.equal(state().error, 'Microphone permission was denied.');
    assert.equal(state().status, 'idle');
    assert.equal(sockets[0]!.closedByClient, true);
  });

  it('a pipe stopped while starting stays stopped when start() resolves', async () => {
    const { session, pipes, state } = rig();
    session.listen();
    session.stopListening();
    assert.equal(pipes[0]!.stopCalls, 1);
    pipes[0]!.resolve();
    await tick();
    assert.equal(state().status, 'idle');
    assert.equal(state().error, null);
  });

  it('sends mic frames on the current socket, and toggleMute makes them the same length and all zero', async () => {
    const { session, pipe, last, state } = await live();
    pipe.frame(new Int16Array([100, -200, 300]).buffer);
    session.toggleMute();
    assert.equal(pipe.muted, true);
    assert.equal(state().muted, true);
    assert.deepEqual(last().frames.at(-1), { type: 'mark', name: 'mute', note: 'you' });
    pipe.frame(new Int16Array([100, -200, 300]).buffer);
    const audio = last().sent.filter((d): d is ArrayBuffer => d instanceof ArrayBuffer);
    assert.equal(audio.length, 2);
    assert.deepEqual([...new Int16Array(audio[0]!)], [100, -200, 300]);
    assert.equal(audio[1]!.byteLength, audio[0]!.byteLength);
    assert.deepEqual([...new Int16Array(audio[1]!)], [0, 0, 0]);
    session.toggleMute();
    assert.equal(pipe.muted, false);
    assert.deepEqual(last().frames.at(-1), { type: 'mark', name: 'unmute', note: 'you' });
  });

  it('drops a mic frame when no socket is open', async () => {
    const { pipe, last } = await live();
    last().drop();
    assert.doesNotThrow(() => pipe.frame(new ArrayBuffer(4)));
  });

  it('stopListening resets mute and the level, and is idempotent', async () => {
    const { session, pipe, state } = await live();
    session.toggleMute();
    pipe.onLevel(0.5);
    assert.equal(state().level, 0.5);
    session.stopListening();
    session.stopListening();
    assert.equal(pipe.stopCalls, 1);
    assert.equal(state().muted, false);
    assert.equal(state().level, 0);
    assert.equal(state().status, 'idle');
  });

  it('sends played with the milliseconds the pipe reports when it drains', async () => {
    const { pipe, last } = await live();
    pipe.onDrained(500);
    pipe.onDrained(1200.4);
    assert.deepEqual(
      last().frames.filter((f) => f.type === 'played'),
      [
        { type: 'played', ms: 500 },
        { type: 'played', ms: 1200 },
      ],
    );
  });

  it('plays reply audio and drives waiting, expectReply and flush from the frames', async () => {
    const { pipe, last } = await live();
    last().receive({ type: 'turn_start', session: 'c' });
    assert.equal(pipe.waiting, true);
    assert.equal(pipe.expects, 1);
    const pcm = new ArrayBuffer(8);
    last().receiveBinary(pcm);
    assert.deepEqual(pipe.played, [pcm]);
    last().receive({ type: 'interrupted' });
    assert.equal(pipe.waiting, false);
    assert.equal(pipe.flushes, 1);
  });

  it('reports pipe problems as the error and audio notes as marks', async () => {
    const { pipe, last, state } = await live();
    pipe.onProblem('The microphone was disconnected.');
    assert.equal(state().error, 'The microphone was disconnected.');
    pipe.onAudio('audio context suspended');
    assert.deepEqual(last().frames.at(-1), { type: 'mark', name: 'audio', note: 'audio context suspended' });
  });

  it('stopAll sends stop and stops listening', async () => {
    const { session, last, state } = await live();
    session.stopAll();
    assert.deepEqual(last().frames.at(-1), { type: 'stop' });
    assert.equal(state().status, 'idle');
  });
});

describe('VoiceSession: output and gate, held for the pipe', () => {
  /** Records every assignment to `output` and `gate` on a pipe, so a needless one shows. */
  const watch = (pipe: Record<string, unknown>) => {
    const sets: string[] = [];
    for (const name of ['output', 'gate']) {
      let value = pipe[name];
      Object.defineProperty(pipe, name, {
        get: () => value,
        set: (v) => {
          sets.push(`${name}=${v}`);
          value = v;
        },
      });
    }
    return sets;
  };

  it('are on until told otherwise, and say so', () => {
    const { session } = rig();
    assert.equal(session.output, true);
    assert.equal(session.gate, true);
  });

  it('hands what was chosen before listening to the pipe that listen() makes', async () => {
    const { session, pipes } = rig();
    session.output = false;
    session.gate = false;
    session.listen();
    assert.equal(pipes[0]!.output, false);
    assert.equal(pipes[0]!.gate, false);
    session.stopListening();
    session.listen(); // a fresh pipe each time, told the same
    assert.equal(pipes[1]!.output, false);
    assert.equal(pipes[1]!.gate, false);
  });

  it('applies a change to the live pipe at once, and only a change', async () => {
    const { session, pipe } = await live();
    const sets = watch(pipe as unknown as Record<string, unknown>);
    session.output = true; // already on
    session.gate = true;
    assert.deepEqual(sets, []);
    session.output = false;
    session.gate = false;
    session.output = false;
    assert.deepEqual(sets, ['output=false', 'gate=false']);
    assert.equal(pipe.output, false);
    assert.equal(pipe.gate, false);
    session.output = true;
    assert.equal(pipe.output, true);
  });

  it('touches no pipe when there is none', () => {
    const { session, pipes } = rig();
    session.output = false;
    session.gate = false;
    assert.equal(pipes.length, 0);
  });
});

describe('VoiceSession: show and approve', () => {
  it('show() puts a stored chat on screen and resets the turn, the mic and the socket', async () => {
    const { session, state, last, pipe } = await live();
    session.attach({ id: 1, data: 'x' });
    last().receive({ type: 'user', text: 'half', partial: true });
    last().receive({ type: 'error', text: 'bad' });
    session.show([{ uuid: 'u1', role: 'user', text: 'old' }], 'chat-2');
    assert.equal(pipe.stopCalls, 1);
    assert.equal(state().status, 'idle');
    assert.equal(state().chatId, 'chat-2');
    assert.equal(state().inFlight, false);
    assert.equal(state().working, false);
    assert.equal(state().utterance, null);
    assert.equal(state().error, null);
    assert.deepEqual(state().attached, []);
    assert.deepEqual(
      (state().lines as { text: string }[]).map((l) => l.text),
      ['old'],
    );
    assert.equal(last().closedByClient, true);
  });

  it('approve() commits the held instruction as edited and sends it', () => {
    const { session, state, last } = rig();
    session.working = true; // watching a review-mode chat
    last().open();
    last().receive({ type: 'user', text: 'rm logs', partial: false });
    last().receive({ type: 'approval', text: 'rm logs' });
    assert.equal(state().pending, 'rm logs');
    session.approve('rm old logs');
    assert.equal(state().pending, null);
    assert.equal((state().lines as { text: string }[]).at(-1)?.text, 'rm old logs');
    assert.deepEqual(last().frames.at(-1), { type: 'approve', text: 'rm old logs' });
  });
});
