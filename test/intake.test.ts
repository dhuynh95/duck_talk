import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createIntake } from '../web/intake.js';

// What happens between "these files were chosen" and "they are waiting for the next
// instruction": one at a time, each under its own id, a failure costing only its own file, and the
// person told what is going on in words. The conversion itself is the browser's (attach.js).

type Item = { id: number; data: string } | { id: number; text: string };

function setup(convert: (blob: Blob) => Promise<string>, now = () => 1000) {
  const attached: Item[] = [];
  const events: string[] = [];
  const intake = createIntake({
    session: { attach: (item: Item) => void attached.push(item) },
    status: {
      busy: (text: string | null) => void events.push(`busy:${text}`),
      error: (text: string) => void events.push(`error:${text}`),
    },
    convert,
    now,
  });
  return { intake, attached, events };
}

const file = (name: string) => new File([name], name, { type: 'image/jpeg' });
const tick = () => new Promise((r) => setImmediate(r));

describe('createIntake: files', () => {
  it('converts each file and attaches its picture, in the order chosen', async () => {
    const { intake, attached } = setup(async (blob) => `jpeg-of-${(blob as File).name}`);
    await intake.addFiles([file('a.jpg'), file('b.png')]);
    assert.deepEqual(attached.map((a) => 'data' in a && a.data), ['jpeg-of-a.jpg', 'jpeg-of-b.png']);
  });

  it('gives every picture its own id, rising, though the clock has not moved', async () => {
    const { intake, attached } = setup(async () => 'x', () => 5000);
    await intake.addFiles([file('a'), file('b'), file('c')]);
    await intake.addFiles([file('d')]);
    const ids = attached.map((a) => a.id);
    assert.deepEqual([...ids].sort((p, q) => p - q), ids);
    assert.equal(new Set(ids).size, 4);
    assert.ok(ids[0]! >= 5000);
  });

  it('does one file at a time: the next is not started until the last is done', async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const { intake, attached } = setup((blob) => {
      started.push((blob as File).name);
      return new Promise((resolve) => release.push(() => resolve('ok')));
    });
    const done = intake.addFiles([file('a'), file('b')]);
    await tick();
    assert.deepEqual(started, ['a']);
    release[0]!();
    await tick();
    assert.deepEqual(started, ['a', 'b']);
    assert.equal(attached.length, 1);
    release[1]!();
    await done;
    assert.equal(attached.length, 2);
  });

  it('keeps two calls from overlapping: the second waits behind the first', async () => {
    const order: string[] = [];
    const release: Array<() => void> = [];
    const { intake } = setup((blob) => {
      order.push(`start ${(blob as File).name}`);
      return new Promise((resolve) => release.push(() => { order.push(`end ${(blob as File).name}`); resolve('ok'); }));
    });
    const first = intake.addFiles([file('a')]);
    const second = intake.addFiles([file('b')]);
    await tick();
    assert.deepEqual(order, ['start a']);
    release[0]!();
    await tick();
    release[1]!();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b']);
  });

  it('says it is processing while it works, and says nothing once it is done', async () => {
    const { intake, events } = setup(async () => 'x');
    await intake.addFiles([file('a')]);
    assert.deepEqual(events, ['busy:Processing…', 'busy:null']);
  });

  it('says how far along it is when there are several', async () => {
    const { intake, events } = setup(async () => 'x');
    await intake.addFiles([file('a'), file('b'), file('c')]);
    assert.deepEqual(events, ['busy:Processing 1 of 3…', 'busy:Processing 2 of 3…', 'busy:Processing 3 of 3…', 'busy:null']);
  });

  it('shows the readable reason when a file cannot be read, and attaches nothing for it', async () => {
    const { intake, attached, events } = setup(async () => {
      throw new Error('That file is empty.');
    });
    await intake.addFiles([file('a')]);
    assert.deepEqual(attached, []);
    assert.deepEqual(events, ['busy:Processing…', 'busy:null', 'error:That file is empty.']);
  });

  it('carries on past a bad file: only that one is lost', async () => {
    const { intake, attached, events } = setup(async (blob) => {
      if ((blob as File).name === 'bad') throw new Error('That file is empty.');
      return `ok-${(blob as File).name}`;
    });
    await intake.addFiles([file('one'), file('bad'), file('two')]);
    assert.deepEqual(attached.map((a) => 'data' in a && a.data), ['ok-one', 'ok-two']);
    assert.equal(events.at(-1), 'error:1 of 3 files could not be added. That file is empty.');
  });

  it('counts the failures when there are several, and still gives the first reason', async () => {
    const { intake, events } = setup(async () => {
      throw new Error("That file isn't a picture this browser can read. Try a JPEG or PNG.");
    });
    await intake.addFiles([file('a'), file('b')]);
    assert.equal(events.at(-1), "error:2 of 2 files could not be added. That file isn't a picture this browser can read. Try a JPEG or PNG.");
  });

  it('does not show a thing it was not told: a rejection that is not an Error has a plain sentence', async () => {
    const { intake, events } = setup(() => Promise.reject('boom'));
    await intake.addFiles([file('a')]);
    assert.equal(events.at(-1), 'error:That picture could not be added.');
  });

  it('a batch that breaks does not break the ones behind it', async () => {
    const attached: Item[] = [];
    let first = true;
    const intake = createIntake({
      session: { attach: (item: Item) => void attached.push(item) },
      status: {
        busy: () => {
          if (first) {
            first = false;
            throw new Error('the page broke');
          }
        },
        error: () => {},
      },
      convert: async () => 'x',
      now: () => 1000,
    });
    await assert.rejects(intake.addFiles([file('a')]), { message: 'the page broke' });
    await intake.addFiles([file('b')]);
    assert.equal(attached.length, 1);
  });

  it('is quiet about nothing: no files, no status', async () => {
    const { intake, events } = setup(async () => 'x');
    await intake.addFiles([]);
    assert.deepEqual(events, []);
  });
});

describe('createIntake: pastes', () => {
  it('attaches the whole text under an id', () => {
    const { intake, attached } = setup(async () => 'x', () => 7000);
    const text = 'line\n'.repeat(500);
    intake.addPaste(text);
    assert.deepEqual(attached, [{ id: 7000, text }]);
  });

  it('shares its ids with pictures, so nothing is ever attached under a name already used', async () => {
    const { intake, attached } = setup(async () => 'x', () => 9000);
    await intake.addFiles([file('a')]);
    intake.addPaste('long');
    await intake.addFiles([file('b')]);
    const ids = attached.map((a) => a.id);
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual([...ids].sort((p, q) => p - q), ids);
  });
});
