import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// The stop frame, on a real Session with stand-ins for everything it talks to (as in
// drop.test.ts). The case that matters is a page that thinks a turn is running when the
// relay knows none is — the relay was restarted mid-turn — and only a turn_end settles it.

const dir = mkdtempSync(join(tmpdir(), 'duck-talk-stop-'));
process.env['PROJECT_CWD'] = dir;
process.env['TURN_QUIET_MS'] = '0';
const { Session } = await import('../server/session.ts');

const tick = () => new Promise((r) => setImmediate(r));

function rig() {
  const events: any[] = [];
  const calls: string[] = [];
  const session: any = new Session(
    { pcm: () => {}, event: (e: unknown) => void events.push(e) },
    {} as never,
    'direct',
    { sttModel: 'stt', voiceModel: 'voice', autocorrect: false, readback: false },
    () => {},
  );
  session.claude = {
    send: () => void calls.push('send'),
    interrupt: () => void calls.push('interrupt'),
    stopTasks: () => void calls.push('stopTasks'),
  };
  session.voice = { interrupt: () => {}, say: () => {}, finish: () => {} };
  session.record = async () => {};
  session.saved = async () => ({}); // the store lookup is not what is under test
  session.sessionId = 'chat-1'; // what `open` learns from the resumed chat
  return { session, events, calls };
}

before(() => mkdirSync(join(dir, '.duck-talk'), { recursive: true }));
after(() => rmSync(dir, { recursive: true, force: true }));

describe('Session: a stop frame', () => {
  it('with nothing running, answers with one bare turn_end for this chat, and still stops the background tasks', async () => {
    const { session, events, calls } = rig();
    assert.equal(session.state, 'user');
    session.frame({ type: 'stop' });
    await tick();
    assert.deepEqual(events, [{ type: 'turn_end', session: 'chat-1' }]);
    assert.deepEqual(calls, ['stopTasks']);
    assert.equal(session.state, 'user');
  });

  it('with a turn running, ends it exactly as before: interrupted, then one turn_end', async () => {
    const { session, events, calls } = rig();
    session.frame({ type: 'text', text: 'go' });
    await tick();
    assert.equal(session.state, 'claude');
    events.length = 0;
    session.frame({ type: 'stop' });
    await tick();
    await tick();
    assert.deepEqual(events, [{ type: 'interrupted' }, { type: 'turn_end', session: 'chat-1' }]);
    assert.deepEqual(calls, ['send', 'interrupt', 'stopTasks']);
    assert.equal(session.state, 'user');
  });

  it('a second stop after the turn has ended is the idle case: one more bare turn_end', async () => {
    const { session, events } = rig();
    session.frame({ type: 'text', text: 'go' });
    await tick();
    session.frame({ type: 'stop' });
    await tick();
    await tick();
    events.length = 0;
    session.frame({ type: 'stop' });
    await tick();
    assert.deepEqual(events, [{ type: 'turn_end', session: 'chat-1' }]);
  });
});
