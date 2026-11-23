// @ts-check
// Keyboard shortcuts for the call, and what decides when a key is one.
//
//   L        start listening, or hang up — the call, and only the call
//   M        mute and unmute the microphone
//   Space    held: talk, with Push to talk on (the microphone is closed until it is down)
//   Esc      stop whatever is running — Claude, the call, or both (main.js, as it always was)
//
// A key is a shortcut only when it could not have been meant as anything else: no Ctrl, Alt or
// Meta (so the browser's own are left alone), not while a field has the keyboard (an "l" typed in
// the message is an "l"), not while a menu, sheet or the chat list is open (they are modal, and
// Space on a menu item is theirs), and not in the middle of an input method's composition.
//
// `shortcutOf` is the rule as a function of one event and where it fell, so it can be held to
// account without a page; `installShortcuts` is what reads the page and does the work.

/** The keys, as the page draws them on its buttons (ui/shortcut-hints.js). */
export const KEYS = Object.freeze({ listen: 'L', mute: 'M', talk: 'Space', stop: 'Esc' });

/** @typedef {{ action: 'listen' | 'mute' | 'talk', phase: 'down' | 'up' }} Shortcut */

/**
 * What an event means, if anything.
 * @param {Pick<KeyboardEvent, 'type' | 'key' | 'code' | 'repeat' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'isComposing'> & { keyCode?: number }} event
 * @param {{ pushToTalk: boolean, live: boolean, typing: boolean, modal: boolean }} where `live`: the call is up; `typing`: a field has the keyboard; `modal`: a menu, sheet or the chat list is open
 * @returns {Shortcut | null}
 */
export function shortcutOf(event, where) {
  const space = event.code === 'Space' || event.key === ' ';

  // Letting go is always heard — wherever focus has gone since the key went down, and whatever
  // else is held — because a microphone left open by a key-up that was ignored is the one
  // failure here that does harm. The caller ignores a release it has no press for.
  if (event.type === 'keyup') return space && where.pushToTalk ? { action: 'talk', phase: 'up' } : null;
  if (event.type !== 'keydown') return null;

  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.isComposing || event.keyCode === 229) return null;
  if (where.typing || where.modal) return null;

  // Held down, a key repeats, and each repeat of Space would scroll the page: they are all
  // answered, and the press they belong to is only counted once.
  if (space) return where.pushToTalk && where.live ? { action: 'talk', phase: 'down' } : null;

  // A toggle must not flip back and forth under a held key.
  if (event.repeat || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'l') return { action: 'listen', phase: 'down' };
  if (key === 'm') return where.live && !where.pushToTalk ? { action: 'mute', phase: 'down' } : null;
  return null;
}

/** Whether the keyboard is in something that takes text. @param {EventTarget | null} target */
export function isTyping(target) {
  const el = /** @type {{ tagName?: string, isContentEditable?: boolean } | null} */ (target);
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true;
}

/** A menu, a sheet or the chat list is open: each marks itself, and each takes the keyboard. @param {Pick<Document, 'querySelector'>} doc */
function modalOpen(doc) {
  return doc.querySelector('[aria-modal="true"], [role="menu"]') !== null;
}

/**
 * Listen for the shortcuts, on the document, and do what they ask of the session.
 * @param {{
 *   doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'querySelector' | 'visibilityState'>,
 *   win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
 *   store: { get: () => Record<string, any> },
 *   session: Pick<import('./session.js').VoiceSession, 'listen' | 'stopListening' | 'toggleMute' | 'talkDown' | 'talkUp' | 'releaseTalk'>,
 * }} deps
 * @returns {() => void} takes them off again
 */
export function installShortcuts({ doc, win, store, session }) {
  /** @param {KeyboardEvent} event */
  const onKey = (event) => {
    const state = store.get();
    const hit = shortcutOf(event, {
      pushToTalk: state['settings']?.pushToTalk === true,
      live: state['status'] === 'live',
      typing: isTyping(event.target),
      modal: modalOpen(doc),
    });
    if (!hit) return;
    // Space is the page's scroll, and on a focused button its click: not this time. A key-up is
    // let through when there is no call, so that Space on a button, with Push to talk on, still
    // presses it — the release is heard either way, which is all it is there for.
    if (hit.phase === 'down' || state['status'] === 'live') event.preventDefault();
    if (hit.action === 'talk') {
      if (hit.phase === 'down') session.talkDown('key');
      else session.talkUp('key');
    } else if (hit.action === 'mute') {
      session.toggleMute();
    } else if ((state['status'] ?? 'idle') === 'idle') {
      session.listen(); // a key press is a gesture, which is what a browser wants before it opens the microphone
    } else {
      session.stopListening();
    }
  };
  // A key-up that never comes — the window lost focus while the key was down — would leave the
  // microphone open, so losing the window or the screen lets go.
  const release = () => session.releaseTalk();
  const hidden = () => {
    if (doc.visibilityState === 'hidden') release();
  };

  doc.addEventListener('keydown', onKey);
  doc.addEventListener('keyup', onKey);
  win.addEventListener('blur', release);
  doc.addEventListener('visibilitychange', hidden);
  return () => {
    doc.removeEventListener('keydown', onKey);
    doc.removeEventListener('keyup', onKey);
    win.removeEventListener('blur', release);
    doc.removeEventListener('visibilitychange', hidden);
  };
}
