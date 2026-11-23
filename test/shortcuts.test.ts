import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installShortcuts, isTyping, KEYS, shortcutOf } from '../web/shortcuts.js';

// The rule for when a key is a shortcut, and what the page does with one. The keys themselves
// are drawn on the buttons from KEYS, so what is held to account here is also what is on screen.

const down = (key: string, extra: Record<string, unknown> = {}) => ({
  type: 'keydown', key, code: key === ' ' ? 'Space' : `Key${key.toUpperCase()}`, repeat: false,
  ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false, ...extra,
});
const up = (key: string, extra: Record<string, unknown> = {}) => ({ ...down(key, extra), type: 'keyup' });
const where = (extra: Record<string, unknown> = {}) => ({ pushToTalk: false, live: true, typing: false, modal: false, ...extra });
const run = (event: any, w = where()) => shortcutOf(event, w);

describe('shortcutOf', () => {
  it('L is listen, and M is mute while a call is up', () => {
    assert.deepEqual(run(down('l')), { action: 'listen', phase: 'down' });
    assert.deepEqual(run(down('L')), { action: 'listen', phase: 'down' }, 'caps lock');
    assert.deepEqual(run(down('m')), { action: 'mute', phase: 'down' });
  });

  it('M means nothing with no call to mute, or with push to talk, which keeps the microphone closed itself', () => {
    assert.equal(run(down('m'), where({ live: false })), null);
    assert.equal(run(down('m'), where({ pushToTalk: true })), null);
  });

  it('L works whether or not there is a call: it starts one, or ends it', () => {
    assert.deepEqual(run(down('l'), where({ live: false })), { action: 'listen', phase: 'down' });
    assert.deepEqual(run(down('l'), where({ pushToTalk: true })), { action: 'listen', phase: 'down' });
  });

  it('Space is talk only with push to talk on and a call up', () => {
    assert.deepEqual(run(down(' '), where({ pushToTalk: true })), { action: 'talk', phase: 'down' });
    assert.equal(run(down(' '), where({ pushToTalk: false })), null, 'the page scrolls as it always did');
    assert.equal(run(down(' '), where({ pushToTalk: true, live: false })), null, 'no call, so nothing to open');
  });

  it('answers every repeat of a held Space, so none of them scrolls the page', () => {
    assert.deepEqual(run(down(' ', { repeat: true }), where({ pushToTalk: true })), { action: 'talk', phase: 'down' });
  });

  it('does not let a held L or M flip back and forth', () => {
    assert.equal(run(down('l', { repeat: true })), null);
    assert.equal(run(down('m', { repeat: true })), null);
  });

  it('leaves Shift+letter and every Ctrl, Alt and Meta combination to the browser', () => {
    for (const mod of ['ctrlKey', 'altKey', 'metaKey']) {
      assert.equal(run(down('l', { [mod]: true })), null, mod);
      assert.equal(run(down('m', { [mod]: true })), null, mod);
      assert.equal(run(down(' ', { [mod]: true }), where({ pushToTalk: true })), null, mod);
    }
    assert.equal(run(down('L', { shiftKey: true })), null);
  });

  it('is not a shortcut while a field has the keyboard, or a menu or sheet is open, or an input method is composing', () => {
    for (const w of [where({ typing: true }), where({ modal: true })]) {
      assert.equal(run(down('l'), w), null);
      assert.equal(run(down('m'), w), null);
      assert.equal(run(down(' '), { ...w, pushToTalk: true }), null);
    }
    assert.equal(run(down('l', { isComposing: true })), null);
    assert.equal(run(down('l', { keyCode: 229 })), null);
  });

  it('hears Space let go wherever focus has gone, and under any modifier, because a microphone left open is the failure that matters', () => {
    const w = where({ pushToTalk: true, typing: true, modal: true });
    assert.deepEqual(run(up(' '), w), { action: 'talk', phase: 'up' });
    assert.deepEqual(run(up(' ', { ctrlKey: true }), w), { action: 'talk', phase: 'up' });
    assert.equal(run(up(' '), where({ pushToTalk: false })), null);
  });

  it('knows no other key, and no other kind of event', () => {
    for (const key of ['a', 'Enter', 'Escape', 'Tab', '/', '1']) assert.equal(run(down(key)), null, key);
    assert.equal(run({ ...down('l'), type: 'keypress' }), null);
    assert.equal(run(up('l')), null, 'L is acted on at the press');
  });

  it('draws the keys it answers to', () => {
    assert.deepEqual({ ...KEYS }, { listen: 'L', mute: 'M', talk: 'Space', stop: 'Esc' });
  });
});

describe('isTyping', () => {
  it('is true for fields and editable content, false for everything else', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(isTyping({ tagName } as never), true, tagName);
    assert.equal(isTyping({ tagName: 'DIV', isContentEditable: true } as never), true);
    for (const tagName of ['BUTTON', 'DIV', 'BODY', 'A']) assert.equal(isTyping({ tagName, isContentEditable: false } as never), false, tagName);
    assert.equal(isTyping(null), false);
  });
});

describe('installShortcuts', () => {
  function rig(state: Record<string, unknown> = {}, opts: { modal?: boolean } = {}) {
    const listeners = new Map<string, ((e: any) => void)[]>();
    const add = (type: string, fn: (e: any) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    const remove = (type: string, fn: (e: any) => void) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    const calls: string[] = [];
    const doc = { addEventListener: add, removeEventListener: remove, querySelector: () => (opts.modal ? {} : null), visibilityState: 'visible' };
    const win = { addEventListener: add, removeEventListener: remove };
    const store = { get: () => ({ status: 'live', settings: {}, ...state }) };
    const session = {
      listen: () => calls.push('listen'),
      stopListening: () => calls.push('stopListening'),
      toggleMute: () => calls.push('toggleMute'),
      talkDown: (s: string) => calls.push(`talkDown ${s}`),
      talkUp: (s: string) => calls.push(`talkUp ${s}`),
      releaseTalk: () => calls.push('releaseTalk'),
    };
    const off = installShortcuts({ doc: doc as never, win: win as never, store, session: session as never });
    const fire = (type: string, event: any) => {
      const e = { target: { tagName: 'BODY' }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
      for (const fn of listeners.get(type) ?? []) fn(e);
      return e;
    };
    return { calls, fire, off, listeners, doc };
  }

  it('L starts a call when there is none, and hangs up when there is, and swallows the key', () => {
    const idle = rig({ status: 'idle' });
    assert.equal(idle.fire('keydown', down('l')).defaultPrevented, true);
    assert.deepEqual(idle.calls, ['listen']);
    const live = rig({ status: 'live' });
    live.fire('keydown', down('l'));
    const connecting = rig({ status: 'connecting' });
    connecting.fire('keydown', down('l'));
    assert.deepEqual([...live.calls, ...connecting.calls], ['stopListening', 'stopListening']);
  });

  it('M toggles the mute of a live call', () => {
    const r = rig();
    r.fire('keydown', down('m'));
    assert.deepEqual(r.calls, ['toggleMute']);
  });

  it('Space down and up are talk down and up, from the key, with push to talk on', () => {
    const r = rig({ settings: { pushToTalk: true } });
    const pressed = r.fire('keydown', down(' '));
    r.fire('keyup', up(' '));
    assert.deepEqual(r.calls, ['talkDown key', 'talkUp key']);
    assert.equal(pressed.defaultPrevented, true, 'the page does not scroll');
  });

  it('does nothing, and swallows nothing, for a key that is not one', () => {
    const r = rig();
    const e = r.fire('keydown', down(' '));
    r.fire('keydown', down('a'));
    assert.deepEqual(r.calls, []);
    assert.equal(e.defaultPrevented, false);
  });

  it('lets a Space key-up through when there is no call, so a focused button still presses', () => {
    const r = rig({ status: 'idle', settings: { pushToTalk: true } });
    const e = r.fire('keyup', up(' '));
    assert.deepEqual(r.calls, ['talkUp key'], 'heard, which is harmless with nothing held');
    assert.equal(e.defaultPrevented, false);
  });

  it('does not act in a field or under an open menu', () => {
    const typing = rig();
    typing.fire('keydown', down('l'), );
    const inField = typing.fire('keydown', { ...down('l'), target: { tagName: 'TEXTAREA' } });
    assert.equal(inField.defaultPrevented, false);
    const modal = rig({}, { modal: true });
    modal.fire('keydown', down('m'));
    assert.deepEqual(modal.calls, []);
  });

  it('lets go when the window loses focus or the page is hidden, and not when it is shown', () => {
    const r = rig();
    r.fire('blur', {});
    assert.deepEqual(r.calls, ['releaseTalk']);
    (r.doc as any).visibilityState = 'hidden';
    r.fire('visibilitychange', {});
    (r.doc as any).visibilityState = 'visible';
    r.fire('visibilitychange', {});
    assert.deepEqual(r.calls, ['releaseTalk', 'releaseTalk']);
  });

  it('takes every listener off again', () => {
    const r = rig();
    r.off();
    r.fire('keydown', down('l'));
    r.fire('blur', {});
    assert.deepEqual(r.calls, []);
  });
});
