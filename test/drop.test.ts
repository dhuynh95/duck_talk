import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// `drop` takes back a picture or a paste that is waiting for the next instruction. The Session is
// real and everything it talks to is a stand-in: the state files land in a folder of their own,
// and nothing here reaches Claude or Gemini. The environment is set before the import because
// paths.ts reads it once, and the watchdog is off so no timer outlives a test.

const dir = mkdtempSync(join(tmpdir(), 'duck-talk-drop-'));
process.env['PROJECT_CWD'] = dir;
process.env['TURN_QUIET_MS'] = '0';
const { Session } = await import('../server/session.ts');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]).toString('base64');
const image = (id: number) => join(dir, '.duck-talk', 'images', `${id}.jpg`);
const tick = () => new Promise((r) => setImmediate(r));

function rig() {
  const log: string[] = [];
  const sent: { instruction: string; given: any[] }[] = [];
  const events: any[] = [];
  const session: any = new Session(
    { pcm: () => {}, event: (e: unknown) => void events.push(e) },
    {} as never, // the Gemini client: never called, because nothing here opens the ears or the voice
    'direct',
    { sttModel: 'stt', voiceModel: 'voice', autocorrect: false, readback: false },
    (m: string) => void log.push(m),
  );
  session.claude = { send: (instruction: string, given: any[]) => void sent.push({ instruction, given }), interrupt: () => {} };
  session.voice = { interrupt: () => {} };
  return { session, log, sent, events };
}

before(() => mkdirSync(join(dir, '.duck-talk'), { recursive: true }));
after(() => rmSync(dir, { recursive: true, force: true }));

describe('Session: a drop frame takes back a pending attachment', () => {
  it('forgets a picture and removes the file it was kept in', () => {
    const { session } = rig();
    session.frame({ type: 'attach', id: 5, data: JPEG });
    assert.deepEqual(session.attached, [{ id: 5, data: JPEG }]);
    assert.ok(existsSync(image(5)), 'filed when it was attached');
    session.frame({ type: 'drop', id: 5 });
    assert.deepEqual(session.attached, []);
    assert.equal(existsSync(image(5)), false, 'a picture that never went to Claude has no business in the chat history');
  });

  it('forgets a pasted text', () => {
    const { session } = rig();
    session.frame({ type: 'attach', id: 6, text: 'a very long paste' });
    session.frame({ type: 'drop', id: 6 });
    assert.deepEqual(session.attached, []);
  });

  it('takes back only the one it names', () => {
    const { session } = rig();
    session.frame({ type: 'attach', id: 1, data: JPEG });
    session.frame({ type: 'attach', id: 2, text: 'kept' });
    session.frame({ type: 'attach', id: 3, data: JPEG });
    session.frame({ type: 'drop', id: 1 });
    assert.deepEqual(session.attached.map((a: { id: number }) => a.id), [2, 3]);
    assert.equal(existsSync(image(1)), false);
    assert.ok(existsSync(image(3)), 'the other picture is still filed');
  });

  it('is idempotent, and an id it never held is ignored', () => {
    const { session, log } = rig();
    session.frame({ type: 'attach', id: 7, data: JPEG });
    session.frame({ type: 'drop', id: 7 });
    assert.doesNotThrow(() => session.frame({ type: 'drop', id: 7 }));
    assert.doesNotThrow(() => session.frame({ type: 'drop', id: 404 }));
    assert.equal(log.filter((l) => l.includes('dropped attachment')).length, 1, 'said once, for the one that was held');
  });

  it('ignores an id that is not a number', () => {
    const { session } = rig();
    session.frame({ type: 'attach', id: 8, text: 't' });
    session.frame({ type: 'drop', id: '8' });
    session.frame({ type: 'drop' });
    session.frame({ type: 'drop', id: null });
    assert.equal(session.attached.length, 1);
  });

  it('narrates the id and never the contents', () => {
    const { session, log } = rig();
    session.frame({ type: 'attach', id: 9, text: 'secret words' });
    session.frame({ type: 'attach', id: 10, data: JPEG });
    session.frame({ type: 'drop', id: 9 });
    session.frame({ type: 'drop', id: 10 });
    assert.ok(log.includes('dropped attachment 9'));
    assert.ok(log.includes('dropped attachment 10'));
    assert.equal(log.some((l) => l.includes('secret words') || l.includes(JPEG)), false);
  });

  it('survives a file that cannot be removed: the attachment is still forgotten, and the log says why', () => {
    const { session, log } = rig();
    session.frame({ type: 'attach', id: 11, data: JPEG });
    rmSync(image(11));
    mkdirSync(image(11)); // a directory where the picture was: unlinking it fails
    assert.doesNotThrow(() => session.frame({ type: 'drop', id: 11 }));
    assert.deepEqual(session.attached, []);
    assert.ok(log.some((l) => l.startsWith('image removal failed')));
    rmSync(image(11), { recursive: true });
  });

  it('keeps a dropped picture out of the instruction that runs next, and out of the turn record', async () => {
    const { session, sent } = rig();
    session.frame({ type: 'attach', id: 20, data: JPEG });
    session.frame({ type: 'attach', id: 21, data: JPEG });
    session.frame({ type: 'attach', id: 22, text: 'pasted' });
    session.frame({ type: 'drop', id: 20 });
    session.frame({ type: 'drop', id: 22 });
    session.frame({ type: 'text', text: 'look' });
    await tick();
    assert.deepEqual(sent, [{ instruction: 'look', given: [{ image: JPEG }] }]);
    assert.deepEqual(session.turn.images, [21]);
  });

  it('does not take a picture from the turn that is already running with it', async () => {
    const { session, log } = rig();
    session.frame({ type: 'attach', id: 30, data: JPEG });
    session.frame({ type: 'text', text: 'look' });
    await tick();
    assert.equal(session.state, 'claude');
    session.frame({ type: 'drop', id: 30 });
    assert.deepEqual(session.turn.images, [30], 'the record still names what Claude was given');
    assert.deepEqual(session.attached, [{ id: 30, data: JPEG }]);
    assert.ok(existsSync(image(30)), 'a chat reopened later still shows it');
    assert.ok(log.some((l) => l.includes('turn already carries attachment 30')));
  });

  it('takes one back after a retract, which re-runs the turn with whatever is still held', async () => {
    const { session, sent } = rig();
    session.frame({ type: 'attach', id: 40, data: JPEG });
    session.frame({ type: 'attach', id: 41, data: JPEG });
    session.frame({ type: 'text', text: 'look at' });
    await tick();
    session.retract();
    session.frame({ type: 'drop', id: 40 });
    assert.equal(existsSync(image(40)), false);
    session.run('look at this');
    assert.deepEqual(sent.at(-1), { instruction: 'look at this', given: [{ image: JPEG }] });
    assert.deepEqual(session.turn.images, [41]);
  });
});
