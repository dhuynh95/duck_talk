import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clipTime } from '../web/ui/clip-chip.js';
import { streamingId, verbsOf } from '../web/ui/line-actions.js';
import { pasteLabel } from '../web/ui/pieces.js';

// The rules the verbs under a line are drawn by: which a line has, and when it has none. The
// buttons themselves, the clip chip and the thumbnails are looked at in Chrome.

const line = (kind: 'user' | 'model' | 'tools', rest: Record<string, unknown> = {}) => ({
  id: 1,
  kind,
  text: 'words',
  tools: [],
  running: false,
  given: [],
  ...rest,
});

describe('verbsOf: what can be done to a line', () => {
  it('a line of yours that is in the store can be edited, and copied', () => {
    assert.deepEqual(verbsOf(line('user', { uuid: 'u1', after: 'p0' }), false), ['edit', 'copy']);
  });

  it('a line of yours with no place in the store (just said) can only be copied', () => {
    assert.deepEqual(verbsOf(line('user'), false), ['copy']);
  });

  it('a line that was heard has its clip, and can be fixed: the clip first, then the fix, then the rest', () => {
    assert.deepEqual(verbsOf(line('user', { uuid: 'u1', clip: 12 }), false), ['clip', 'fix', 'edit', 'copy']);
    assert.deepEqual(verbsOf(line('user', { clip: 12 }), false), ['clip', 'fix', 'copy']);
  });

  it('a clip id of 0 is still a clip: the check is for presence, not truthiness', () => {
    assert.deepEqual(verbsOf(line('user', { clip: 0 }), false), ['clip', 'fix', 'copy']);
  });

  it('a line of Claude\'s that is in the store can be forked from, and copied', () => {
    assert.deepEqual(verbsOf(line('model', { uuid: 'm1' }), false), ['fork', 'copy']);
  });

  it('a line of Claude\'s that is not in the store can only be copied', () => {
    assert.deepEqual(verbsOf(line('model'), false), ['copy']);
  });

  it('nothing is offered on a line that is still being written, whatever it holds', () => {
    assert.deepEqual(verbsOf(line('model', { uuid: 'm1' }), true), []);
    assert.deepEqual(verbsOf(line('user', { uuid: 'u1', clip: 3 }), true), []);
  });

  it('nothing is offered on a line with no words to copy and nothing to cut at', () => {
    assert.deepEqual(verbsOf(line('model', { text: '' }), false), []);
    assert.deepEqual(verbsOf(line('user', { text: '', uuid: 'u1' }), false), ['edit']);
  });

  it('a run of tools has no verbs', () => {
    assert.deepEqual(verbsOf(line('tools', { tools: ['Read'], text: '', uuid: 'x' }), false), []);
  });
});

describe('streamingId: the line that is still being written', () => {
  const lines = [line('user', { id: 1 }), line('tools', { id: 2 }), line('model', { id: 3 })];

  it('is the last line, if it is Claude\'s and a turn is in flight', () => {
    assert.equal(streamingId(lines as any, true), 3);
  });

  it('is none once the turn is over', () => {
    assert.equal(streamingId(lines as any, false), null);
  });

  it('is none while the last line is yours or a run of tools: nothing is being written yet', () => {
    assert.equal(streamingId(lines.slice(0, 1) as any, true), null);
    assert.equal(streamingId(lines.slice(0, 2) as any, true), null);
    assert.equal(streamingId([], true), null);
  });
});

describe('pasteLabel: the opening words of a pasted text, for its chip', () => {
  it('is the text itself when it is short', () => {
    assert.equal(pasteLabel('some log output'), 'some log output');
  });

  it('runs lines together and trims, so a chip is one line', () => {
    assert.equal(pasteLabel('\n\n  first line\n   second\tline  \n'), 'first line second line');
  });

  it('cuts a long text at 40 characters and says it was cut', () => {
    const label = pasteLabel('x'.repeat(100));
    assert.equal(label, `${'x'.repeat(40)}…`);
  });

  it('does not cut in the middle of a character made of two code units', () => {
    const label = pasteLabel('🦆'.repeat(50));
    assert.equal(label, `${'🦆'.repeat(40)}…`);
  });

  it('has a name for a paste with nothing visible in it', () => {
    assert.equal(pasteLabel(''), 'Pasted text');
    assert.equal(pasteLabel(' \n\t '), 'Pasted text');
  });

  it('says what a paste of megabytes opens with, and that it goes on, without reading all of it into pieces', () => {
    const words = 'word '.repeat(2_000_000); // ten million characters
    assert.equal(pasteLabel(words), 'word word word word word word word word …');
    assert.equal(pasteLabel(`${'\n'.repeat(3_000_000)}the stack trace begins`), 'the stack trace begins');
    assert.equal(pasteLabel('🦆'.repeat(5_000_000)), `${'🦆'.repeat(40)}…`);
  });

  it('does not say "…" for a text that ends in a great deal of blank, which is no more text', () => {
    assert.equal(pasteLabel(`done${' '.repeat(2_000_000)}`), 'done');
    assert.equal(pasteLabel(`done${' '.repeat(5000)}more`), 'done more');
    assert.equal(pasteLabel('a'.repeat(80) + ' ' + 'b'), `${'a'.repeat(40)}…`);
  });
});

describe('clipTime: a length of audio as a person reads it', () => {
  it('is minutes and two-digit seconds, rounding down', () => {
    assert.equal(clipTime(0), '0:00');
    assert.equal(clipTime(3.9), '0:03');
    assert.equal(clipTime(65), '1:05');
    assert.equal(clipTime(600), '10:00');
  });

  it('is 0:00 for a length that is not one', () => {
    assert.equal(clipTime(Number.NaN), '0:00');
    assert.equal(clipTime(Number.POSITIVE_INFINITY), '0:00');
    assert.equal(clipTime(-4), '0:00');
  });
});
