import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
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
