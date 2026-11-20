import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dropKey, REFUSED_TEXT, REFUSED_TITLE, useKey } from '../web/ui/key-form.js';

// The key form's two acts, without a page: keep what was typed and reload, or forget and reload.
// The form and the dialog themselves are looked at in Chrome.

function memory(initial: Record<string, string> = {}, refuse: 'set' | 'remove' | null = null) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (name: string) => items.get(name) ?? null,
    setItem(name: string, value: string) {
      if (refuse === 'set') throw new Error('quota');
      items.set(name, value);
    },
    removeItem(name: string) {
      if (refuse === 'remove') return; // a storage that says nothing and keeps it
      items.delete(name);
    },
  };
}

describe('useKey: what the field does with what was typed', () => {
  it('keeps the key, trimmed, and reloads onto it', () => {
    const storage = memory();
    let reloads = 0;
    assert.equal(useKey('  abc  ', storage, () => void reloads++), null);
    assert.equal(storage.items.get('duck-talk-key'), 'abc');
    assert.equal(reloads, 1);
  });

  it('does nothing for an empty field', () => {
    const storage = memory();
    let reloads = 0;
    assert.equal(useKey('   ', storage, () => void reloads++), null);
    assert.equal(storage.items.size, 0);
    assert.equal(reloads, 0);
  });

  it('says so, and does not reload into the same refusal, when the browser will not keep it', () => {
    let reloads = 0;
    assert.match(useKey('abc', memory({}, 'set'), () => void reloads++) ?? '', /would not keep the key/);
    assert.equal(useKey('abc', null, () => void reloads++) === null, false);
    assert.equal(reloads, 0);
  });
});

describe('dropKey: Forget key', () => {
  it('drops the stored key and reloads, so the page asks for one', () => {
    const storage = memory({ 'duck-talk-key': 'old' });
    let reloads = 0;
    assert.equal(dropKey(storage, () => void reloads++), null);
    assert.equal(storage.items.has('duck-talk-key'), false);
    assert.equal(reloads, 1);
  });

  it('says so instead of reloading when the browser will not let go of it', () => {
    let reloads = 0;
    assert.match(dropKey(memory({ 'duck-talk-key': 'old' }, 'remove'), () => void reloads++) ?? '', /would not let go/);
    assert.equal(reloads, 0);
  });
});

describe('the refused-key dialog says what happened and what to do', () => {
  it('names the refusal and that the key is per project folder', () => {
    assert.equal(REFUSED_TITLE, 'Key refused');
    assert.match(REFUSED_TEXT, /^The relay refused this key — it may belong to another project\./);
    assert.match(REFUSED_TEXT, /per project folder/);
  });
});
