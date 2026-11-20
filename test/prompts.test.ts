import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOCKED_NOTE, liveNote, promptDirty, promptEditable, promptNote } from '../web/prompts.js';

// The rules the prompts screen goes by: when a prompt may be opened, when it has been changed,
// and what it says about when it takes effect. The sheet itself is looked at in Chrome.

const prompt = (live: boolean, text = 'Speak plainly.') => ({ name: live ? 'voice' : 'claude', title: 'T', detail: 'D', live, text });

describe('promptEditable: a prompt that binds when a session opens is not yours to change while one is running', () => {
  it('a live prompt can always be opened', () => {
    assert.equal(promptEditable(prompt(true), false), true);
    assert.equal(promptEditable(prompt(true), true), true);
  });

  it('a fixed prompt can be opened when nothing is running', () => {
    assert.equal(promptEditable(prompt(false), false), true);
  });

  it('a fixed prompt cannot be opened while a session is running', () => {
    assert.equal(promptEditable(prompt(false), true), false);
  });
});

describe('promptDirty: whether there is anything to save', () => {
  it('is false for the text it opened with, and true once it differs', () => {
    assert.equal(promptDirty(prompt(true), 'Speak plainly.'), false);
    assert.equal(promptDirty(prompt(true), 'Speak briskly.'), true);
  });

  it('is true when everything was deleted: an empty prompt is a choice', () => {
    assert.equal(promptDirty(prompt(true), ''), true);
  });

  it('is false for a change the relay would not keep: it stores the text trimmed', () => {
    assert.equal(promptDirty(prompt(true), 'Speak plainly.\n'), false);
    assert.equal(promptDirty(prompt(true), '  Speak plainly.'), false);
    assert.equal(promptDirty(prompt(true, ''), '   \n'), false);
  });

  it('is true for a change inside the text, whitespace or not', () => {
    assert.equal(promptDirty(prompt(true, 'a b'), 'a  b'), true);
  });
});

describe('liveNote: when an edit takes effect', () => {
  it('a live prompt is re-read on the next sentence', () => {
    assert.equal(liveNote(prompt(true)), 'Takes effect on the next sentence.');
  });

  it('a fixed prompt waits for the next session', () => {
    assert.equal(liveNote(prompt(false)), 'Fixed when a session starts — takes effect the next time you press listen.');
  });
});

describe('promptNote: what a row says under it', () => {
  it('says when it takes effect when it can be opened', () => {
    assert.equal(promptNote(prompt(true), true), liveNote(prompt(true)));
    assert.equal(promptNote(prompt(false), false), liveNote(prompt(false)));
  });

  it('says why it cannot be opened when it cannot', () => {
    assert.equal(promptNote(prompt(false), true), LOCKED_NOTE);
    assert.match(LOCKED_NOTE, /stop listening/i);
  });
});
