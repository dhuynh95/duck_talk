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

function rig(opts: { mode?: 'direct' | 'review'; ai?: unknown; autocorrect?: boolean } = {}) {
  const log: string[] = [];
  const sent: { instruction: string; given: any[] }[] = [];
  const events: any[] = [];
  const records: any[] = [];
  const session: any = new Session(
    { pcm: () => {}, event: (e: unknown) => void events.push(e) },
    // The Gemini client: never called unless a test hands one in, because nothing here opens the ears or the voice
    (opts.ai ?? {}) as never,
    opts.mode ?? 'direct',
    { sttModel: 'stt', voiceModel: 'voice', autocorrect: opts.autocorrect ?? false, readback: false },
    (m: string) => void log.push(m),
  );
  session.claude = { send: (instruction: string, given: any[]) => void sent.push({ instruction, given }), interrupt: () => {} };
  session.voice = { interrupt: () => {}, say: () => {}, finish: () => {} };
  session.record = async (t: unknown) => void records.push(t); // the turn log is not what is under test
  return { session, log, sent, events, records };
}

/** A correction call that answers when the test says so, so a test can stand inside the wait for it. */
function slowCorrection(answer: string) {
  let answerNow: () => void = () => {};
  const waiting = new Promise<{ text: string }>((resolve) => { answerNow = () => resolve({ text: answer }); });
  return { ai: { models: { generateContent: () => waiting } }, answerNow };
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
    assert.ok(log.some((l) => l.includes('turn already sent with attachment 30')));
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

  // A retract puts the turn back in the user's hands, but the joined sentence is not run at once:
  // with auto-correct on, `propose` takes the floor again and waits for the correction first. The
  // turn has not been sent in that wait, so a picture handed back can still be taken back.
  it('takes one back while the re-run waits for its correction, and the re-run is not given it', async () => {
    const { ai, answerNow } = slowCorrection('look at this, as meant');
    const { session, sent, log } = rig({ ai, autocorrect: true });
    session.corrections = [{ at: 1, heard: 'look', proposed: 'look', meant: 'look at' }];
    session.frame({ type: 'attach', id: 50, data: JPEG });
    session.frame({ type: 'attach', id: 51, data: JPEG });
    session.frame({ type: 'text', text: 'look at' });
    await tick();
    assert.equal(sent.length, 1, 'the fragment ran with both pictures');
    session.retract();
    const proposing = session.propose('look at this');
    assert.equal(session.state, 'claude', 'the floor is taken again, but nothing has been sent');
    session.frame({ type: 'drop', id: 50 });
    assert.deepEqual(session.attached.map((a: { id: number }) => a.id), [51]);
    assert.equal(existsSync(image(50)), false);
    assert.equal(log.some((l) => l.includes('drop ignored')), false, 'a turn that has not been sent holds nothing');
    answerNow();
    await proposing;
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], { instruction: 'look at this, as meant', given: [{ image: JPEG }] });
    assert.deepEqual(session.turn.images, [51]);
  });

  it('records no picture that was taken back after a retract, even when the re-run is then refused', async () => {
    const { session, records } = rig({ mode: 'review' });
    session.frame({ type: 'attach', id: 60, data: JPEG });
    await session.propose('look at');
    session.frame({ type: 'approve' });
    assert.deepEqual(session.turn.images, [60], 'the fragment ran with it');
    session.retract();
    await session.propose('look at this');
    assert.equal(session.state, 'held');
    session.frame({ type: 'drop', id: 60 });
    assert.equal(existsSync(image(60)), false);
    session.decide(false);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].images, [], 'the record does not name a picture that no longer exists');
  });
});
