import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keyLine, reachOf } from '../web/ui/connection.js';

// What the Connection sheet says about the relay and the key. The sheet itself is looked at in Chrome.

describe('reachOf: one line about whether a relay is answering', () => {
  it('Reachable, once a frame has come back', () => {
    assert.deepEqual(reachOf({ connected: true }), { kind: 'reachable', text: 'Reachable' });
  });

  it('Offline, with the relay\'s own reason when it has given one', () => {
    assert.deepEqual(reachOf({ connected: false, relayError: 'The relay is not answering.' }), {
      kind: 'offline',
      text: 'Offline',
      detail: 'The relay is not answering.',
    });
  });

  it('Checking, before anything has answered or failed: the page opens with `connected` false', () => {
    assert.deepEqual(reachOf({ connected: false }), { kind: 'checking', text: 'Checking…' });
    assert.deepEqual(reachOf({}), { kind: 'checking', text: 'Checking…' });
  });

  it('connected wins over a stale error', () => {
    assert.equal(reachOf({ connected: true, relayError: 'old' }).kind, 'reachable');
  });
});

describe('keyLine: what the sheet says about the access key', () => {
  it('a key that is in use and kept: saved in this browser, and can be forgotten', () => {
    assert.deepEqual(keyLine({ inUse: true, kept: true }), { text: 'Saved in this browser', canForget: true });
  });

  it('a key that is in use but this browser would not keep: for this visit only', () => {
    assert.deepEqual(keyLine({ inUse: true, kept: false }), { text: 'Used for this visit only', canForget: true });
  });

  it('no key: nothing to forget', () => {
    assert.deepEqual(keyLine({ inUse: false, kept: false }), { text: 'No access key saved', canForget: false });
  });
});
