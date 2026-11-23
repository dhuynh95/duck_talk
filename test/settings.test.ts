import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadSettings, normalizeSettings, saveSettings } from '../web/settings.js';

const DEFAULTS = { mode: 'direct', model: 'default', effort: 'default', permission: 'plan', autocorrect: false, output: true, gate: true, chimes: false, lastChat: null };

/** A storage that holds what it is given, in memory. */
function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  };
}

const KEY = 'duck-talk-settings';

describe('loadSettings', () => {
  it('returns the defaults for a storage with nothing in it', () => {
    assert.deepEqual(loadSettings(memory()), DEFAULTS);
  });

  it('returns the defaults when there is no storage, or reading it throws', () => {
    assert.deepEqual(loadSettings(null), DEFAULTS);
    const throwing = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    assert.deepEqual(loadSettings(throwing), DEFAULTS);
  });

  it('gives each caller its own object', () => {
    const a = loadSettings(null);
    a.mode = 'review';
    assert.equal(loadSettings(null).mode, 'direct');
  });

  it('reads back what was saved', () => {
    const storage = memory();
    const chosen = { mode: 'review', model: 'claude-sonnet-5', effort: 'xhigh', permission: 'bypassPermissions', autocorrect: true, output: false, gate: false, chimes: true, lastChat: 'c0ffee-1' };
    assert.equal(saveSettings(storage, chosen as any), true);
    assert.deepEqual(loadSettings(storage), chosen);
  });

  it('falls back to the defaults for stored text that is not JSON, or not an object', () => {
    for (const bad of ['{nope', '', 'null', '7', '"direct"', '[1,2]', 'true']) {
      assert.deepEqual(loadSettings(memory({ [KEY]: bad })), DEFAULTS, bad);
    }
  });

  it('falls back field by field: a field of the wrong type does not cost the others', () => {
    const stored = JSON.stringify({ mode: 'review', model: 7, effort: 'high', permission: ['plan'], autocorrect: 'yes', output: 0, gate: null, chimes: 'loud' });
    assert.deepEqual(loadSettings(memory({ [KEY]: stored })), { ...DEFAULTS, mode: 'review', effort: 'high' });
  });

  it('falls back for a value outside what a field allows', () => {
    const stored = JSON.stringify({ mode: 'sideways', permission: 'default', model: '', effort: '', autocorrect: true });
    assert.deepEqual(loadSettings(memory({ [KEY]: stored })), { ...DEFAULTS, autocorrect: true });
  });

  it('takes each permission and mode the picker offers', () => {
    for (const permission of ['plan', 'acceptEdits', 'bypassPermissions']) {
      assert.equal(loadSettings(memory({ [KEY]: JSON.stringify({ permission }) })).permission, permission);
    }
    for (const mode of ['direct', 'review']) {
      assert.equal(loadSettings(memory({ [KEY]: JSON.stringify({ mode }) })).mode, mode);
    }
  });

  it('keeps the last open chat, and has none until one is kept', () => {
    assert.equal(loadSettings(null).lastChat, null);
    assert.equal(loadSettings(memory({ [KEY]: JSON.stringify({ lastChat: '4f1c-22' }) })).lastChat, '4f1c-22');
  });

  it('takes a last chat that is not a non-empty string for none, and costs no other field', () => {
    for (const bad of ['', 7, true, ['x'], { id: 'x' }, null]) {
      const loaded = loadSettings(memory({ [KEY]: JSON.stringify({ lastChat: bad, mode: 'review' }) }));
      assert.equal(loaded.lastChat, null, JSON.stringify(bad));
      assert.equal(loaded.mode, 'review');
    }
  });

  it('ignores keys it does not know, and does not hand them on', () => {
    const loaded = loadSettings(memory({ [KEY]: '{"mode":"review","color":"red","__proto__":{"polluted":true},"constructor":{"x":1}}' }));
    assert.deepEqual(loaded, { ...DEFAULTS, mode: 'review' });
    assert.equal(({} as any).polluted, undefined);
  });
});

describe('saveSettings', () => {
  it('writes JSON under duck-talk-settings, only the keys it knows', () => {
    const storage = memory();
    saveSettings(storage, { ...DEFAULTS, extra: 1 } as any);
    assert.deepEqual(JSON.parse(storage.items.get(KEY)!), DEFAULTS);
  });

  it('never stores what loadSettings would refuse', () => {
    const storage = memory();
    saveSettings(storage, { ...DEFAULTS, mode: 'sideways', model: 3 } as any);
    assert.deepEqual(JSON.parse(storage.items.get(KEY)!), DEFAULTS);
  });

  it('writes the last chat, and a last chat that is not a string as none', () => {
    const storage = memory();
    saveSettings(storage, { ...DEFAULTS, lastChat: 'abc' } as any);
    assert.equal(JSON.parse(storage.items.get(KEY)!).lastChat, 'abc');
    saveSettings(storage, { ...DEFAULTS, lastChat: 12 } as any);
    assert.equal(JSON.parse(storage.items.get(KEY)!).lastChat, null);
  });

  it('says false, and does not throw, when there is no storage or it refuses', () => {
    assert.equal(saveSettings(null, DEFAULTS as any), false);
    const full = {
      getItem: () => null,
      setItem() {
        throw new Error('QuotaExceededError');
      },
    };
    assert.equal(saveSettings(full, DEFAULTS as any), false);
  });
});

describe('normalizeSettings', () => {
  it('is the one rule load and save share, and keeps what is valid', () => {
    assert.deepEqual(normalizeSettings({ mode: 'review', output: false }), { ...DEFAULTS, mode: 'review', output: false });
    assert.deepEqual(normalizeSettings(undefined), DEFAULTS);
  });
});
