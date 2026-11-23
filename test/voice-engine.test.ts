import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openVoice, VoiceError, type VoiceEngine } from '../server/voice.ts';

// Which engine reads a sentence is decided when the sentence is read, so the page can switch
// between Gemini and the local voice in the middle of a conversation. Everything else the voice
// does — order, retries, cancelling — is the same for both and is not asked again here.

const pcm = (n = 96) => Buffer.alloc(n, 1);

/** An engine that records what it was asked to read, and answers from `behave`. */
function engine(name: string, spoken: string[], behave: (text: string, signal: AbortSignal) => AsyncIterable<Buffer> = async function* () { yield pcm(); }): VoiceEngine {
  return {
    name,
    speak(text, signal) {
      spoken.push(`${name}: ${text}`);
      return behave(text, signal);
    },
  };
}

function rig(current: () => VoiceEngine) {
  const events: string[] = [];
  const failures: [string, unknown][] = [];
  let over!: () => void;
  let done = new Promise<void>((resolve) => (over = resolve));
  const voice = openVoice(current, {
    onPcm: () => events.push('pcm'),
    onDone: () => { over(); done = new Promise<void>((resolve) => (over = resolve)); },
    onFail: (name, failure) => failures.push([name, failure]),
  });
  return { voice, events, failures, next: () => done };
}

describe('openVoice with an engine', () => {
  it('reads each sentence with the engine that is current when it is read', async () => {
    const spoken: string[] = [];
    let now = engine('Gemini', spoken);
    const { voice, next } = rig(() => now);
    const first = next();
    voice.say('Hello there.');
    voice.finish();
    await first;
    now = engine('Kokoro', spoken); // switched between turns, as the page's Settings does
    const second = next();
    voice.say('Hello again.');
    voice.finish();
    await second;
    assert.deepEqual(spoken, ['Gemini: Hello there.', 'Kokoro: Hello again.']);
    voice.close();
  });

  it('passes what the engine yields to the phone, in order', async () => {
    const spoken: string[] = [];
    const { voice, events, next } = rig(() => engine('Kokoro', spoken, async function* () { yield pcm(); yield pcm(); }));
    const over = next();
    voice.say('One.');
    voice.finish();
    await over;
    assert.deepEqual(events, ['pcm', 'pcm']);
    voice.close();
  });

  it('tells the caller which engine failed, once the attempts are used up, and carries on to the next sentence', async () => {
    const spoken: string[] = [];
    const broken = new VoiceError('the local voice is not installed');
    const { voice, failures, next } = rig(() => engine('Kokoro', spoken, () => (async function* (): AsyncGenerator<Buffer> { throw broken; })()));
    const over = next();
    voice.say('Nobody hears this.');
    voice.finish();
    await over;
    assert.equal(spoken.length, 3, 'three attempts at the one sentence');
    assert.deepEqual(failures, [['Kokoro', broken]]);
    voice.close();
  });

  it('counts an engine that answers with no audio as a failure too', async () => {
    const spoken: string[] = [];
    const { voice, failures, next } = rig(() => engine('Gemini', spoken, async function* () {}));
    const over = next();
    voice.say('Silence.');
    voice.finish();
    await over;
    assert.equal(failures.length, 1);
    assert.match(String(failures[0]?.[1]), /no audio/);
    voice.close();
  });

  it('does not call a cancelled turn a failure', async () => {
    const spoken: string[] = [];
    const { voice, failures } = rig(() => engine('Kokoro', spoken, async function* (_text, signal) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('aborted');
    }));
    voice.say('Interrupted.');
    voice.finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    voice.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(failures, []);
    voice.close();
  });
});
