import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { controlHints } from '../web/ui/shortcut-hints.js';

// What the composer's buttons say about their keys: to a screen reader, in a tooltip, and on the
// button. Held to account as one function so the three cannot drift apart.

const hints = (over: Partial<Parameters<typeof controlHints>[0]> = {}) => controlHints({ status: 'idle', muted: false, busy: false, pushToTalk: false, ...over });

describe('controlHints: the microphone', () => {
  it('is Listen, with L, until there is a call', () => {
    assert.deepEqual(hints().listen, { label: 'Listen', title: 'Listen (L)', cap: 'L', keys: 'L' });
  });

  it('says what it is doing during a call, with no key drawn on it — it is not a button now — but L still ends it', () => {
    for (const [status, label] of [['connecting', 'Connecting'], ['live', 'Listening']] as const) {
      assert.deepEqual(hints({ status }).listen, { label, title: `${label} — L to hang up`, cap: '', keys: 'L' });
    }
  });

  it('is the thing to hold under push to talk, with Space on it, once the call is up', () => {
    assert.deepEqual(hints({ status: 'live', pushToTalk: true }).listen, { label: 'Hold to talk', title: 'Hold to talk (Space)', cap: 'Space', keys: 'Space' });
    assert.equal(hints({ status: 'idle', pushToTalk: true }).listen.label, 'Listen', 'before the call it is the same Listen');
    assert.equal(hints({ status: 'connecting', pushToTalk: true }).listen.label, 'Connecting');
  });
});

describe('controlHints: mute and stop', () => {
  it('mute is M, and the tooltip says which way it flips', () => {
    assert.deepEqual(hints({ status: 'live' }).mute, { label: 'Mute', title: 'Mute (M)', cap: 'M', keys: 'M' });
    assert.equal(hints({ status: 'live', muted: true }).mute.title, 'Unmute (M)');
  });

  it('stop is Esc, and says what it stops', () => {
    assert.equal(hints({ status: 'live' }).stop.label, 'Stop listening');
    assert.equal(hints({ busy: true }).stop.label, 'Stop Claude');
    assert.equal(hints({ status: 'live', busy: true }).stop.label, 'Stop Claude and listening');
    assert.equal(hints({ status: 'live' }).stop.cap, 'Esc');
    assert.equal(hints({ status: 'live' }).stop.keys, 'Escape', 'aria-keyshortcuts uses the key\'s own name');
  });

  it('mentions L as the other way to hang up only when the call is all that stop would end', () => {
    assert.equal(hints({ status: 'live' }).stop.title, 'Stop listening (Esc or L)');
    assert.equal(hints({ status: 'live', busy: true }).stop.title, 'Stop Claude and listening (Esc)', 'L would leave Claude running');
    assert.equal(hints({ busy: true }).stop.title, 'Stop Claude (Esc)');
  });
});
