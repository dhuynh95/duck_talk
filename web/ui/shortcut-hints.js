// @ts-check
// What each control of the composer says about its key: the words a screen reader and a tooltip
// give it, the key to draw on its corner, and the key it answers to (`aria-keyshortcuts`). One
// function of the state, so the three can never disagree with each other or with shortcuts.js.

import { KEYS } from '../shortcuts.js';

/** @typedef {{ label: string, title: string, cap: string, keys: string }} Hint `cap` is what is drawn on the button, empty for none; `keys` is the value for aria-keyshortcuts */

/**
 * @param {{ status: string, muted: boolean, busy: boolean, pushToTalk: boolean }} s `busy`: Claude is working
 * @returns {{ listen: Hint, mute: Hint, stop: Hint }}
 */
export function controlHints({ status, muted, busy, pushToTalk }) {
  const live = status === 'live';

  /** @type {Hint} */
  let listen;
  if (live && pushToTalk) listen = { label: 'Hold to talk', title: `Hold to talk (${KEYS.talk})`, cap: KEYS.talk, keys: 'Space' };
  else if (status === 'idle') listen = { label: 'Listen', title: `Listen (${KEYS.listen})`, cap: KEYS.listen, keys: KEYS.listen };
  else {
    const label = status === 'connecting' ? 'Connecting' : 'Listening';
    // The middle of the box is not a button now, so there is nothing to draw on it; the key still works.
    listen = { label, title: `${label} — ${KEYS.listen} to hang up`, cap: '', keys: KEYS.listen };
  }

  /** @type {Hint} */
  const mute = { label: 'Mute', title: `${muted ? 'Unmute' : 'Mute'} (${KEYS.mute})`, cap: KEYS.mute, keys: KEYS.mute };

  const stopLabel = busy ? (status !== 'idle' ? 'Stop Claude and listening' : 'Stop Claude') : 'Stop listening';
  /** @type {Hint} */
  const stop = {
    label: stopLabel,
    // Esc stops what is running; L ends the call without touching what Claude is doing.
    title: busy ? `${stopLabel} (${KEYS.stop})` : `${stopLabel} (${KEYS.stop} or ${KEYS.listen})`,
    cap: KEYS.stop,
    keys: 'Escape',
  };
  return { listen, mute, stop };
}
