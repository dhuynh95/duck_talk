import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// The page chooses who reads the reply aloud, with a `voice` frame, and is told in words when
// the choice cannot speak. A real Session with stand-ins for everything it talks to (as in
// stop.test.ts); the local engine is pointed at a port nothing listens on and a home with nothing
// installed, so that choosing it can never start the real one from a test.

const dir = mkdtempSync(join(tmpdir(), 'duck-talk-pick-'));
process.env['PROJECT_CWD'] = dir;
process.env['KOKORO_URL'] = 'http://127.0.0.1:9';
process.env['KOKORO_HOME'] = join(dir, 'no-kokoro-here');
const { Session } = await import('../server/session.ts');

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function rig(voice?: 'gemini' | 'kokoro') {
  const events: any[] = [];
  const logs: string[] = [];
  const session: any = new Session(
    { pcm: () => {}, event: (e: unknown) => void events.push(e) },
    {} as never,
    'direct',
    { sttModel: 'stt', voiceModel: 'voice', ...(voice ? { voice } : {}), autocorrect: false, readback: false },
    (m: string) => void logs.push(m),
  );
  return { session, events, logs };
}

before(() => mkdirSync(join(dir, '.duck-talk'), { recursive: true }));
after(() => rmSync(dir, { recursive: true, force: true }));

describe('Session: the voice frame', () => {
  it('starts on Gemini, as the iPhone app and older pages expect', () => {
    assert.equal(rig().session.voiceName, 'gemini');
  });

  it('can be started on the local voice by the relay\'s default', () => {
    assert.equal(rig('kokoro').session.voiceName, 'kokoro');
  });

  it('switches who reads from the next sentence, and logs it', async () => {
    const { session, logs } = rig();
    session.frame({ type: 'voice', engine: 'kokoro' });
    assert.equal(session.voiceName, 'kokoro');
    assert.ok(logs.includes('voice: Kokoro'));
    session.frame({ type: 'voice', engine: 'gemini' });
    assert.equal(session.voiceName, 'gemini');
    await settle();
  });

  it('ignores a name it does not know, and one that is already chosen', () => {
    const { session, logs } = rig();
    for (const engine of ['espeak', '', undefined, 7, 'GEMINI']) session.frame({ type: 'voice', engine: engine as never });
    session.frame({ type: 'voice', engine: 'gemini' });
    assert.equal(session.voiceName, 'gemini');
    assert.deepEqual(logs, []);
  });
});

describe('Session: telling the page the voice cannot speak', () => {
  it('says so once, with what to run, when the local voice is chosen and is not installed', async () => {
    const { session, events } = rig();
    session.frame({ type: 'voice', engine: 'kokoro' });
    await settle();
    const errors = events.filter((e) => e.type === 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].text, /not installed/);
    assert.match(errors[0].text, /install\.sh/);
  });

  it('turns a Gemini daily-limit refusal into words that point at the local voice', () => {
    const { session, events } = rig();
    session.voiceFailed('Gemini', new Error('ApiError: 429 RESOURCE_EXHAUSTED You exceeded your current quota'));
    assert.equal(events.length, 1);
    assert.match(events[0].text, /Gemini's voice limit is reached/);
    assert.match(events[0].text, /Local voice \(Kokoro\)/);
  });

  it('says what failed for anything else, on one line', () => {
    const { session, events } = rig();
    session.voiceFailed('Kokoro', new Error('the local voice answered 500: boom\n  at somewhere'));
    assert.deepEqual(events, [{ type: 'error', text: 'Kokoro voice failed, so part of the reply goes unread: the local voice answered 500: boom' }]);
  });

  it('says it once for a run of failures, and again after the voice has spoken or been switched', () => {
    const { session, events } = rig();
    session.voiceFailed('Gemini', new Error('429'));
    session.voiceFailed('Gemini', new Error('429'));
    assert.equal(events.length, 1);
    session.voiceNoted = false; // what a sentence that gets spoken does
    session.voiceFailed('Gemini', new Error('429'));
    assert.equal(events.length, 2);
    session.frame({ type: 'voice', engine: 'kokoro' }); // a new choice is a new chance
    session.voiceFailed('Kokoro', new Error('x'));
    assert.ok(events.length >= 3);
  });
});
