import assert from 'node:assert/strict';
import { afterEach, describe, it, type TestContext } from 'node:test';
import { AudioPipe, micErrorMessage } from '../web/audio.js';

// What can be tested here is what does not need a browser: the words a refusal turns into,
// and the bookkeeping around the speaker, which is the same PlayQueue the browser uses with
// no AudioContext under it. The microphone path and the scheduling of buffers are only ever
// real in Chrome; that is checked there, by hand, and not pretended at here.

describe('micErrorMessage', () => {
  const dom = (name: string) => new DOMException('whatever the browser said', name);

  it('tells a refused microphone to allow it in the site settings', () => {
    for (const name of ['NotAllowedError', 'SecurityError']) {
      const message = micErrorMessage(dom(name));
      assert.match(message, /microphone permission/i, name);
      assert.match(message, /site settings/i, name);
    }
  });

  it('says there is no microphone when none was found', () => {
    for (const name of ['NotFoundError', 'OverconstrainedError']) {
      assert.match(micErrorMessage(dom(name)), /no microphone/i, name);
    }
  });

  it('says another app may be holding the microphone when it cannot be opened', () => {
    for (const name of ['NotReadableError', 'AbortError']) {
      assert.match(micErrorMessage(dom(name)), /in use by another app/i, name);
    }
  });

  it('goes by the error name, not by what class carries it', () => {
    const plain = Object.assign(new Error('x'), { name: 'NotAllowedError' });
    assert.equal(micErrorMessage(plain), micErrorMessage(dom('NotAllowedError')));
    assert.equal(micErrorMessage({ name: 'NotFoundError' }), micErrorMessage(dom('NotFoundError')));
  });

  it('gives each of the four causes its own words', () => {
    const messages = [
      micErrorMessage(dom('NotAllowedError')),
      micErrorMessage(dom('NotFoundError')),
      micErrorMessage(dom('NotReadableError')),
      micErrorMessage(undefined),
    ];
    assert.equal(new Set(messages).size, 4);
  });

  it('falls back to a generic message for anything it does not know, and never throws', () => {
    const hostile = new Proxy({}, { get() { throw new Error('no looking'); } });
    const getter = { get name(): string { throw new Error('no looking'); } };
    for (const odd of ['NotAllowedError', undefined, null, 0, 42, {}, [], () => {}, dom('SomethingElseError'), new TypeError('boom'), hostile, getter, { name: 7 }]) {
      assert.match(micErrorMessage(odd), /could not start the microphone/i);
    }
  });
});

describe('AudioPipe.requestMic', () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const setNavigator = (value: unknown) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  afterEach(() => {
    if (real) Object.defineProperty(globalThis, 'navigator', real);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });

  it('asks for one channel with the browser echo cancellation, noise suppression and gain control on', async () => {
    const asked: unknown[] = [];
    const stream = {};
    setNavigator({ mediaDevices: { getUserMedia: async (c: unknown) => (asked.push(c), stream) } });
    assert.equal(await AudioPipe.requestMic(), stream);
    assert.deepEqual(asked, [{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }]);
  });

  it('throws an Error whose message is the one micErrorMessage chose', async () => {
    const denied = new DOMException('Permission denied', 'NotAllowedError');
    setNavigator({ mediaDevices: { getUserMedia: async () => { throw denied; } } });
    await assert.rejects(AudioPipe.requestMic(), (e: unknown) => e instanceof Error && e.message === micErrorMessage(denied));
  });

  it('says the page needs to be secure where the browser offers no microphone at all', async () => {
    setNavigator({});
    await assert.rejects(AudioPipe.requestMic(), (e: unknown) => e instanceof Error && /https|secure/i.test(e.message));
  });
});

describe('AudioPipe with no audio context', () => {
  // Nothing here has called start(), so there is no AudioContext and no speaker: what is left
  // is the pipe's own part, which is what it tells the queue, and when.
  const rig = () => {
    const pipe = new AudioPipe();
    const drained: number[] = [];
    pipe.onDrained = (ms) => drained.push(ms);
    return { pipe, drained };
  };
  const bytes = (n: number) => new ArrayBuffer(n);

  it('is built, and torn down, without touching a browser', () => {
    const { pipe } = rig();
    assert.equal(pipe.muted, false);
    assert.equal(pipe.output, true);
    assert.equal(pipe.waiting, false);
    pipe.stop();
    pipe.stop();
  });

  it('reports the speaker dry once per real change of output, not once per assignment', () => {
    const { pipe, drained } = rig();
    pipe.output = true; // already on
    assert.equal(drained.length, 0);
    pipe.output = false;
    pipe.output = false;
    pipe.output = false;
    assert.equal(drained.length, 1);
    pipe.output = true;
    assert.equal(drained.length, 1);
    pipe.output = false;
    assert.equal(drained.length, 2);
  });

  it('with the output off, counts a chunk as heard on arrival, at 24 samples a millisecond', () => {
    const { pipe, drained } = rig();
    pipe.output = false;
    drained.length = 0;
    pipe.play(bytes(4800)); // 2400 samples: 100 ms
    pipe.play(bytes(2400)); // 1200 samples: 50 ms more
    assert.deepEqual(drained, [100, 150]);
  });

  it('forgets what the last reply played when a new one is expected', () => {
    const { pipe, drained } = rig();
    pipe.output = false;
    drained.length = 0;
    pipe.play(bytes(4800));
    pipe.expectReply();
    pipe.play(bytes(2400));
    assert.deepEqual(drained, [100, 50]);
  });

  it('takes an odd byte count, and a chunk of nothing, without throwing or crediting a half sample', () => {
    const { pipe, drained } = rig();
    pipe.output = false;
    drained.length = 0;
    pipe.play(bytes(0));
    assert.deepEqual(drained, []);
    pipe.play(bytes(5)); // two whole samples and a stray byte
    assert.deepEqual(drained, [2 / 24]);
  });

  it('drops a chunk that arrives before there is anything to play it on, and says nothing about it', () => {
    const { pipe, drained } = rig();
    pipe.play(bytes(4800));
    assert.deepEqual(drained, []);
    // ...and the queue is not left believing it holds a buffer: it still goes dry on a flush.
    pipe.flush();
    assert.deepEqual(drained, [0]);
  });

  it('flush reports what was played so far, and expectReply starts the count again', () => {
    const { pipe, drained } = rig();
    pipe.output = false;
    pipe.play(bytes(4800));
    drained.length = 0;
    pipe.flush();
    assert.deepEqual(drained, [100]);
    pipe.expectReply();
    pipe.flush();
    assert.deepEqual(drained, [100, 0]);
  });
});

// The rest is the pipe's lifecycle and its callbacks, run against a stand-in for the few parts
// of Web Audio it touches. The stand-in has no sound in it: what is asserted is what the pipe
// does to its nodes, tracks and callbacks, in the orders a real page can produce.

type Deferred<T = void> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}
const named = (name: string) => Object.assign(new Error(`stub ${name}`), { name });

const GLOBALS = ['AudioContext', 'AudioWorkletNode', 'fetch', 'document', 'navigator'] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

interface Stub {
  contexts: { closed: boolean }[];
  tracks: { stopped: boolean; onended: (() => void) | null }[];
  /** Every buffer source made: the reply's, since nothing here waits and so nothing chimes. */
  sources: { stopped: number }[];
  worklets: { port: { onmessage: ((e: { data: unknown }) => void) | null } }[];
}

/** Puts the stand-in in the globals the pipe reads; `restoreGlobals` puts them back. */
function installWebAudio(opts: { getUserMedia: (stub: Stub) => Promise<unknown>; addModule?: (ctx: { closed: boolean }) => Promise<void> }): Stub {
  for (const name of GLOBALS) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const stub: Stub = { contexts: [], tracks: [], sources: [], worklets: [] };
  class Node {
    connect() {}
    disconnect() {}
  }
  class Gain extends Node {
    gain = { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} };
  }
  class Source extends Node {
    stopped = 0;
    onended: unknown = null;
    constructor() {
      super();
      stub.sources.push(this);
    }
    start() {}
    stop() {
      this.stopped++;
    }
  }
  const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define('AudioContext', class {
    state = 'running';
    currentTime = 0;
    sampleRate = 48000;
    closed = false;
    destination = new Node();
    audioWorklet = { addModule: () => (opts.addModule ?? (async () => {}))(this) };
    constructor() {
      stub.contexts.push(this);
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
    addEventListener() {}
    removeEventListener() {}
    createMediaStreamSource() {
      return new Node();
    }
    createGain() {
      return new Gain();
    }
    createBuffer(_channels: number, length: number) {
      return { duration: length / 24000, copyToChannel() {} };
    }
    createBufferSource() {
      return new Source();
    }
    decodeAudioData() {
      return Promise.resolve({});
    }
  });
  define('AudioWorkletNode', class extends Node {
    port = { onmessage: null };
    onprocessorerror: unknown = null;
    constructor() {
      super();
      stub.worklets.push(this);
    }
  });
  define('fetch', async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }));
  define('document', { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' });
  define('navigator', { mediaDevices: { getUserMedia: () => opts.getUserMedia(stub) } });
  return stub;
}

function restoreGlobals() {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  saved.clear();
}

/** A microphone stream with one track, recorded in `stub.tracks`. */
function micStream(stub: Stub) {
  const track = { stopped: false, onended: null as (() => void) | null, stop() { this.stopped = true; }, getSettings: () => ({}) };
  stub.tracks.push(track);
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}

/** Tells a start() that settled with an error from one that did not, whichever way it went. */
const outcome = (p: Promise<unknown>) => p.then(() => 'resolved', (e: Error) => `rejected: ${e.message}`);

/** console.error, replaced for the test and handed back so what it was told can be read. */
const quietConsole = (t: TestContext) => t.mock.method(console, 'error', () => {});

describe('AudioPipe.start and stop, in the orders a page can produce', () => {
  afterEach(restoreGlobals);

  it('resolves quietly when stop() came during the permission prompt and the prompt was then granted', async () => {
    const prompt = deferred<unknown>();
    const stub = installWebAudio({ getUserMedia: () => prompt.promise });
    const pipe = new AudioPipe();
    const started = outcome(pipe.start());
    pipe.stop();
    prompt.resolve(micStream(stub));
    assert.equal(await started, 'resolved');
    assert.equal(stub.tracks[0]?.stopped, true, 'the microphone that arrived late is let go');
    assert.equal(stub.contexts[0]?.closed, true);
  });

  it('resolves quietly when stop() came during the permission prompt and the prompt was then refused', async () => {
    const prompt = deferred<unknown>();
    const stub = installWebAudio({ getUserMedia: () => prompt.promise });
    const pipe = new AudioPipe();
    const started = outcome(pipe.start());
    pipe.stop();
    prompt.reject(named('NotAllowedError'));
    assert.equal(await started, 'resolved', 'the call was already ended; a refusal is not news');
    assert.equal(stub.contexts[0]?.closed, true);
  });

  it('resolves quietly when stop() came while the worklet module was loading, and loading then failed because of it', async () => {
    const loading = deferred();
    const entered = deferred();
    const stub = installWebAudio({
      getUserMedia: async (s) => micStream(s),
      addModule: (ctx) => (entered.resolve(), loading.promise.then(() => { if (ctx.closed) throw named('InvalidStateError'); })),
    });
    const pipe = new AudioPipe();
    const started = outcome(pipe.start());
    await entered.promise;
    pipe.stop();
    loading.resolve();
    assert.equal(await started, 'resolved', 'a context closed under it is why the load failed, and who closed it is no mystery');
    assert.equal(stub.tracks[0]?.stopped, true);
    assert.equal(stub.contexts[0]?.closed, true);
  });

  it('still rejects with the reason when nothing stopped it: a refusal, and a worklet that will not load', async () => {
    const denied = installWebAudio({ getUserMedia: async () => { throw named('NotAllowedError'); } });
    assert.equal(await outcome(new AudioPipe().start()), `rejected: ${micErrorMessage(named('NotAllowedError'))}`);
    assert.equal(denied.contexts[0]?.closed, true);
    restoreGlobals();

    const broken = installWebAudio({ getUserMedia: async (s) => micStream(s), addModule: async () => { throw named('AbortError'); } });
    assert.match(await outcome(new AudioPipe().start()), /^rejected: Could not load the microphone processor/);
    assert.equal(broken.tracks[0]?.stopped, true);
    assert.equal(broken.contexts[0]?.closed, true);
  });
});

describe('AudioPipe when a callback throws', () => {
  afterEach(restoreGlobals);

  /** A started pipe on the stand-in, and the way to hand it one frame as the worklet would. */
  async function started() {
    const stub = installWebAudio({ getUserMedia: async (s) => micStream(s) });
    const pipe = new AudioPipe();
    await pipe.start();
    const frame = (first: number) => {
      const samples = new Int16Array(640);
      samples[0] = first;
      stub.worklets[0]?.port.onmessage?.({ data: samples.buffer });
    };
    return { pipe, stub, frame };
  }
  const firstSamples = (chunks: ArrayBuffer[]) => chunks.map((c) => new Int16Array(c)[0]);

  it('still delivers every frame, in order, when onLevel throws (a UI that cannot draw must not silence the relay)', async (t) => {
    const reported = quietConsole(t);
    const { pipe, frame } = await started();
    const chunks: ArrayBuffer[] = [];
    pipe.onChunk = (c) => chunks.push(c);
    pipe.onLevel = () => { throw new Error('the waveform broke'); };
    frame(11);
    frame(22);
    frame(33);
    assert.deepEqual(firstSamples(chunks), [11, 22, 33]);
    assert.equal(reported.mock.calls.length, 3, 'each throw is reported, not swallowed');
    assert.match(String(reported.mock.calls[0]?.arguments.join(' ')), /onLevel/);
    pipe.stop();
  });

  it('still delivers the zeroed frame when muted and onLevel throws', async (t) => {
    quietConsole(t);
    const { pipe, frame } = await started();
    const chunks: ArrayBuffer[] = [];
    pipe.onChunk = (c) => chunks.push(c);
    pipe.onLevel = () => { throw new Error('the waveform broke'); };
    pipe.muted = true;
    frame(7);
    frame(8);
    assert.equal(chunks.length, 2);
    for (const c of chunks) {
      assert.equal(c.byteLength, 1280);
      assert.ok(new Int16Array(c).every((v) => v === 0));
    }
    pipe.stop();
  });

  it('still tells onLevel, and still takes the next frame, when onChunk throws', async (t) => {
    const reported = quietConsole(t);
    const { pipe, frame } = await started();
    const levels: number[] = [];
    let calls = 0;
    pipe.onLevel = (l) => levels.push(l);
    pipe.onChunk = () => { if (calls++ === 0) throw new Error('the socket broke'); };
    frame(1);
    frame(2);
    assert.equal(levels.length, 2);
    assert.equal(calls, 2);
    assert.equal(reported.mock.calls.length, 1);
    assert.match(String(reported.mock.calls[0]?.arguments.join(' ')), /onChunk/);
    pipe.muted = true;
    frame(3);
    assert.deepEqual(levels.slice(2), [0], 'muted: the level still drops to nothing');
    pipe.stop();
  });

  it('flush() still stops what is playing when onDrained throws (barge-in must not leave the reply running)', async (t) => {
    const reported = quietConsole(t);
    const { pipe, stub } = await started();
    pipe.play(new ArrayBuffer(4800));
    pipe.play(new ArrayBuffer(4800));
    assert.equal(stub.sources.length, 2);
    pipe.onDrained = () => { throw new Error('the session broke'); };
    pipe.flush();
    assert.deepEqual(stub.sources.map((s) => s.stopped), [1, 1]);
    assert.equal(reported.mock.calls.length, 1);
    assert.match(String(reported.mock.calls[0]?.arguments.join(' ')), /onDrained/);
    pipe.stop();
  });

  it('switching the output off still stops what is playing when onDrained throws', async (t) => {
    quietConsole(t);
    const { pipe, stub } = await started();
    pipe.play(new ArrayBuffer(4800));
    pipe.play(new ArrayBuffer(4800));
    pipe.onDrained = () => { throw new Error('the session broke'); };
    pipe.output = false;
    assert.equal(pipe.output, false);
    assert.deepEqual(stub.sources.map((s) => s.stopped), [1, 1]);
    pipe.stop();
  });

  it('keeps counting after an onDrained that threw: the next reply is credited from nothing', async (t) => {
    quietConsole(t);
    const { pipe } = await started();
    const drained: number[] = [];
    pipe.onDrained = (ms) => { drained.push(ms); throw new Error('the session broke'); };
    pipe.output = false; // consumed on arrival, so the count needs no clock
    pipe.play(new ArrayBuffer(4800));
    pipe.expectReply();
    pipe.play(new ArrayBuffer(2400));
    assert.deepEqual(drained, [0, 100, 50]);
    pipe.stop();
  });

  it('does not let a throwing onAudio fail the start, or a throwing onProblem escape the track', async (t) => {
    const reported = quietConsole(t);
    const stub = installWebAudio({ getUserMedia: async (s) => micStream(s) });
    const pipe = new AudioPipe();
    pipe.onAudio = () => { throw new Error('the log broke'); };
    pipe.onProblem = () => { throw new Error('the banner broke'); };
    assert.equal(await outcome(pipe.start()), 'resolved');
    assert.equal(stub.contexts[0]?.closed, false, 'the pipe is still running');
    stub.tracks[0]?.onended?.();
    assert.deepEqual(reported.mock.calls.map((c) => /onAudio|onProblem/.exec(String(c.arguments.join(' ')))?.[0]), ['onAudio', 'onProblem']);
    pipe.stop();
  });
});

describe('AudioPipe gate: the microphone goes quiet while the reply is on the speaker', () => {
  afterEach(restoreGlobals);

  /** A started pipe on a clock the test moves, and the way to hand it one frame as the worklet would. */
  async function gated() {
    let time = 10_000;
    const stub = installWebAudio({ getUserMedia: async (s) => micStream(s) });
    const pipe = new AudioPipe({ now: () => time });
    await pipe.start();
    const chunks: ArrayBuffer[] = [];
    const levels: number[] = [];
    pipe.onChunk = (c) => chunks.push(c);
    pipe.onLevel = (l) => levels.push(l);
    const frame = () => {
      const samples = new Int16Array(640).fill(8000); // loud: a level well above the floor
      stub.worklets[0]?.port.onmessage?.({ data: samples.buffer });
    };
    /** The reply buffer the browser says it played to the end. */
    const ended = (i: number) => (stub.sources[i] as unknown as { onended: () => void }).onended();
    const advance = (ms: number) => void (time += ms);
    const lastSilent = () => new Int16Array(chunks.at(-1)!).every((v) => v === 0);
    return { pipe, stub, chunks, levels, frame, ended, advance, lastSilent };
  }

  it('is on by default, and passes the room while no reply is playing', async () => {
    const { pipe, frame, chunks, levels, lastSilent } = await gated();
    assert.equal(pipe.gate, true);
    frame();
    assert.equal(chunks.length, 1);
    assert.equal(lastSilent(), false);
    assert.ok(levels.at(-1)! > 0);
    pipe.stop();
  });

  it('zero-fills frames, same length and same cadence, while reply audio is queued', async () => {
    const { pipe, frame, chunks, levels, lastSilent } = await gated();
    pipe.play(new ArrayBuffer(4800));
    frame();
    frame();
    assert.equal(chunks.length, 2, 'a frame still goes out for every frame captured');
    assert.ok(chunks.every((c) => c.byteLength === 1280));
    assert.equal(lastSilent(), true);
    assert.deepEqual(levels, [0, 0]);
    pipe.stop();
  });

  it('holds the gate for 300 ms after the speaker last ran dry, then lets the room through', async () => {
    const { pipe, frame, ended, advance, lastSilent } = await gated();
    pipe.play(new ArrayBuffer(4800));
    pipe.play(new ArrayBuffer(4800));
    ended(0);
    frame();
    assert.equal(lastSilent(), true, 'one buffer still queued');
    ended(1); // dry now
    advance(299);
    frame();
    assert.equal(lastSilent(), true, 'the room still carries the tail of the reply');
    advance(1);
    frame();
    assert.equal(lastSilent(), false);
    pipe.stop();
  });

  it('holds after a flush too: a barge-in that stops the reply still leaves its echo in the room', async () => {
    const { pipe, frame, advance, lastSilent } = await gated();
    pipe.play(new ArrayBuffer(4800));
    pipe.flush();
    frame();
    assert.equal(lastSilent(), true);
    advance(300);
    frame();
    assert.equal(lastSilent(), false);
    pipe.stop();
  });

  it('passes real audio throughout when the gate is off', async () => {
    const { pipe, frame, levels, lastSilent } = await gated();
    pipe.gate = false;
    pipe.play(new ArrayBuffer(4800));
    frame();
    assert.equal(lastSilent(), false);
    assert.ok(levels.at(-1)! > 0);
    pipe.stop();
  });

  it('does not gate a reply that is not being played: with the output off nothing reaches the room', async () => {
    const { pipe, frame, lastSilent } = await gated();
    pipe.output = false;
    pipe.play(new ArrayBuffer(4800));
    frame();
    assert.equal(lastSilent(), false);
    pipe.stop();
  });

  it('never double-counts with mute: one zeroed frame per frame, and still zero once the gate opens', async () => {
    const { pipe, frame, ended, advance, chunks, levels, lastSilent } = await gated();
    pipe.muted = true;
    pipe.play(new ArrayBuffer(4800));
    frame();
    assert.equal(chunks.length, 1);
    assert.deepEqual(levels, [0]);
    assert.equal(lastSilent(), true);
    ended(0);
    advance(1000);
    frame();
    assert.equal(chunks.length, 2);
    assert.equal(lastSilent(), true, 'muted is muted, gate or no gate');
    pipe.muted = false;
    frame();
    assert.equal(lastSilent(), false);
    pipe.stop();
  });
});

describe('AudioPipe wait chimes', () => {
  afterEach(restoreGlobals);

  /** The loop's sound file loads in the background, so a test lets that finish before a wait begins. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  async function started() {
    const stub = installWebAudio({ getUserMedia: async (s) => micStream(s) });
    const pipe = new AudioPipe();
    await pipe.start();
    await settle();
    return { pipe, stub };
  }

  it('are off until asked for: a wait that would chime at once makes no sound', async () => {
    const { pipe, stub } = await started();
    assert.equal(pipe.chimes, false);
    pipe.waiting = true; // a reply is owed and nothing has played yet
    assert.equal(stub.sources.length, 0);
    pipe.stop();
  });

  it('start the loop for that same wait when they are on', async () => {
    const { pipe, stub } = await started();
    pipe.chimes = true;
    pipe.waiting = true;
    assert.equal(stub.sources.length, 1);
    assert.equal(stub.sources[0]?.stopped, 0);
    pipe.stop();
  });

  it('turning them on in the middle of a wait starts the loop, and turning them off fades it out', async () => {
    const { pipe, stub } = await started();
    pipe.waiting = true;
    assert.equal(stub.sources.length, 0);
    pipe.chimes = true;
    assert.equal(stub.sources.length, 1);
    pipe.chimes = false;
    await new Promise((resolve) => setTimeout(resolve, 300)); // past the fade-out
    assert.equal(stub.sources[0]?.stopped, 1);
    pipe.stop();
  });
});
