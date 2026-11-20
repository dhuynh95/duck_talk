import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autocorrectLocked, menuItems } from '../web/ui/settings-menu.js';

// What the gear's menu holds, in what order, and what it will not let you change. The popover,
// its keys and its focus are looked at in Chrome.

const state = (status: string, settings: Record<string, unknown> = {}) => ({
  status,
  settings: { autocorrect: false, gate: true, ...settings },
});

describe('menuItems', () => {
  it('are Prompts, Corrections, Auto-correct, Mute mic, a divider, then Connection', () => {
    const items = menuItems(state('idle'));
    assert.deepEqual(items.map((i) => i.id), ['prompts', 'corrections', 'autocorrect', 'gate', 'divider', 'connection']);
    assert.deepEqual(
      items.filter((i) => i.kind !== 'divider').map((i) => i.title),
      ['Prompts', 'Corrections', 'Auto-correct', 'Mute mic while Claude speaks', 'Connection'],
    );
  });

  it('the two switches are checkboxes that say what they are bound to', () => {
    const on = menuItems(state('idle', { autocorrect: true, gate: true }));
    const off = menuItems(state('idle', { autocorrect: false, gate: false }));
    const by = (items: ReturnType<typeof menuItems>, id: string) => items.find((i) => i.id === id);
    assert.equal(by(on, 'autocorrect')?.kind, 'toggle');
    assert.equal(by(on, 'autocorrect')?.checked, true);
    assert.equal(by(on, 'gate')?.checked, true);
    assert.equal(by(off, 'autocorrect')?.checked, false);
    assert.equal(by(off, 'gate')?.checked, false);
    assert.equal(by(on, 'prompts')?.kind, 'item');
  });

  it('explains the mic gate where it is chosen: what it stops, and when to turn it off', () => {
    const gate = menuItems(state('idle')).find((i) => i.id === 'gate');
    assert.equal(gate?.detail, 'Stops the microphone hearing the reply (echo). Turn off with headphones to interrupt by voice.');
  });

  it('Auto-correct is not changeable while the microphone is connecting or live: it rides the socket address', () => {
    for (const status of ['connecting', 'live']) {
      const row = menuItems(state(status)).find((i) => i.id === 'autocorrect');
      assert.equal(row?.disabled, true, status);
    }
    assert.equal(menuItems(state('idle')).find((i) => i.id === 'autocorrect')?.disabled, false);
  });

  it('nor while Claude is working, since changing it redials the socket a turn is running on', () => {
    for (const working of [{ inFlight: true }, { working: true }, { lines: [{ kind: 'tools', running: true }] }]) {
      const row = menuItems({ ...state('idle'), ...working }).find((i) => i.id === 'autocorrect');
      assert.equal(row?.disabled, true, JSON.stringify(working));
    }
    // A finished run of tools is not work.
    assert.equal(menuItems({ ...state('idle'), lines: [{ kind: 'tools', running: false }] }).find((i) => i.id === 'autocorrect')?.disabled, false);
  });

  it('and says why when it is not changeable', () => {
    const row = menuItems(state('live')).find((i) => i.id === 'autocorrect');
    assert.match(row?.detail ?? '', /microphone is off/i);
    assert.doesNotMatch(menuItems(state('idle')).find((i) => i.id === 'autocorrect')?.detail ?? '', /microphone is off/i);
  });

  it('nothing else is ever disabled: the gate can be flipped mid-conversation, and the screens open any time', () => {
    const items = menuItems(state('live')).filter((i) => i.id !== 'autocorrect' && i.kind !== 'divider');
    assert.deepEqual(items.map((i) => i.disabled === true), items.map(() => false));
  });

  it('copes with a store that has no status or settings yet', () => {
    const items = menuItems({});
    assert.equal(items.find((i) => i.id === 'autocorrect')?.disabled, false);
    assert.equal(items.find((i) => i.id === 'autocorrect')?.checked, false);
    assert.equal(items.find((i) => i.id === 'gate')?.checked, true);
  });
});

describe('autocorrectLocked', () => {
  it('is true for anything but an idle microphone', () => {
    assert.equal(autocorrectLocked({ status: 'idle' }), false);
    assert.equal(autocorrectLocked({ status: 'connecting' }), true);
    assert.equal(autocorrectLocked({ status: 'live' }), true);
    assert.equal(autocorrectLocked({}), false);
  });

  it('is true while a turn is in flight, and not otherwise', () => {
    assert.equal(autocorrectLocked({ status: 'idle', inFlight: true }), true);
    assert.equal(autocorrectLocked({ status: 'idle', inFlight: false, working: false }), false);
  });
});
