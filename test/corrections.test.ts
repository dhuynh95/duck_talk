import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blankCorrection, isCorrectionComplete } from '../web/corrections.js';

// The rules the corrections editor goes by. The sheet itself is looked at in Chrome.

describe('blankCorrection: a correction that does not exist yet', () => {
  it('is empty, and has no clip, because one made by hand was never heard', () => {
    const c = blankCorrection(1_700_000_000_000);
    assert.equal(c.heard, '');
    assert.equal(c.meant, '');
    assert.equal(c.clip, undefined);
  });

  it('is its own id from the moment it is made: `at` is the time it was started, so saving twice edits one row', () => {
    assert.equal(blankCorrection(1_700_000_000_123).at, 1_700_000_000_123);
  });

  it('is a new object each time, so two blanks never share an edit', () => {
    const a = blankCorrection(1);
    const b = blankCorrection(1);
    a.heard = 'changed';
    assert.equal(b.heard, '');
  });
});

describe('isCorrectionComplete: when Save may be pressed', () => {
  it('needs both what it heard and what you meant', () => {
    assert.equal(isCorrectionComplete({ at: 1, heard: 'delete the cash', meant: 'delete the cache' }), true);
    assert.equal(isCorrectionComplete({ at: 1, heard: '', meant: 'delete the cache' }), false);
    assert.equal(isCorrectionComplete({ at: 1, heard: 'delete the cash', meant: '' }), false);
  });

  it('does not count spaces, tabs or new lines as words', () => {
    assert.equal(isCorrectionComplete({ at: 1, heard: '   ', meant: 'delete the cache' }), false);
    assert.equal(isCorrectionComplete({ at: 1, heard: 'delete the cash', meant: ' \n\t ' }), false);
  });

  it('is not put off by a word with spaces round it', () => {
    assert.equal(isCorrectionComplete({ at: 1, heard: '  cash ', meant: ' cache  ' }), true);
  });

  it('is false for a blank, and for a seed whose words are the same until someone edits one only if one is empty', () => {
    assert.equal(isCorrectionComplete(blankCorrection(1)), false);
    // A line sent here to be fixed starts as `heard === meant`: both are there, so it can be saved.
    assert.equal(isCorrectionComplete({ at: 1, heard: 'open the lock in', meant: 'open the lock in' }), true);
  });
});
