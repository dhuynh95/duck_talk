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

  it('a relay started with --open: not required, and nothing to forget', () => {
    assert.deepEqual(keyLine({ inUse: false, kept: false, required: false }), {
      text: 'Not required (this relay was started with --open)',
      canForget: false,
    });
  });

  it('a relay that is open says so whatever the browser holds', () => {
    assert.equal(keyLine({ inUse: true, kept: true, required: false }).canForget, false);
    assert.equal(keyLine({ inUse: false, kept: true, required: false }).text, 'Not required (this relay was started with --open)');
  });

  it('only a false `required` means open: unknown is the same as before', () => {
    assert.deepEqual(keyLine({ inUse: true, kept: true, required: undefined }), { text: 'Saved in this browser', canForget: true });
    assert.deepEqual(keyLine({ inUse: false, kept: false, required: true }), { text: 'No access key saved', canForget: false });
  });
});
