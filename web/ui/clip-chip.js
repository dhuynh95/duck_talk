// @ts-check
// A chip that plays the audio an utterance was heard from: what the relay kept of it, fetched
// when someone presses play and not before, so a chat of forty heard lines costs nothing until
// one is listened to. `Clip.swift`'s `ClipChip`, ported — and shared with whatever else shows a
// clip (the review card, a correction), which is why it is a module and not part of a line.
//
// One press plays, the next pauses, and a later one carries on. Only one clip is ever heard at a
// time: starting one stops whichever was playing. The audio comes down as a Blob, and an object
// URL is made for it only while it is being listened to: it is let go of when the clip ends, when
// another takes its place, and when the chip is removed, so a long session leaves none behind.
// A clip the relay says it no longer has (it keeps them a week, unless a correction was taught from
// one) is said once, quietly, and the chip goes inert. A clip the relay could not be asked for — a
// phone on a bad network, a relay that is asleep — is a different thing and is never kept as "gone":
// the chip says Retry, and a press asks again.

import { h } from '../dom.js';
import { icon } from './icons.js';

/** @typedef {{ el: HTMLButtonElement, destroy: () => void }} ClipChip */

/** What the chip is called, whether it is playing or not. */
const PLAY = 'Play audio';
/** Said on hover when the failure came with nothing readable to say. */
const COULD_NOT_LOAD = "The audio couldn't be loaded.";

/** The glyph each state wears, where it is not the play triangle. @type {Record<string, import('./icons.js').IconName>} */
const GLYPH = { playing: 'pause', gone: 'waveform', failed: 'retry' };

/** @type {{ stop: () => void } | null} whichever chip is playing or paused with audio in hand */
let current = null;

/**
 * A length of audio as a person reads it: minutes and two-digit seconds, rounded down.
 * @param {number} seconds
 */
export function clipTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * @param {{ id: number, load: (id: number) => Promise<Blob | null> }} options `load` fetches the audio: null is a clip the relay says is gone; a rejection (with a sentence to read) is a failure to ask, which is retried
 * @returns {ClipChip}
 */
export function clipChip({ id, load }) {
  const label = h('span', { class: 'clip-label' }, 'Play');
  // A toggle keeps its name and says which way it is with `aria-pressed`: a label that also became
  // "Pause" would be read out as "Pause, pressed" while it plays — a pause that is already on.
  const el = h('button', { class: 'clip-chip', type: 'button', 'aria-pressed': 'false', 'aria-label': PLAY });

  /** @type {'idle' | 'loading' | 'ready' | 'playing' | 'gone' | 'failed'} ready: the audio is in hand and not playing; failed: could not be fetched, and may be again */
  let state = 'idle';
  /** Why the last fetch failed, said on hover while the chip says Retry. */
  let failure = '';
  /** @type {Blob | null} */
  let blob = null;
  /** @type {HTMLAudioElement | null} */
  let audio = null;
  /** @type {string | null} */
  let url = null;
  let duration = 0;
  let destroyed = false;
  let drawn = '';

  /** What the chip says in the state it is in. @param {number} at */
  const say = (at) => {
    if (state === 'gone') return 'No audio';
    if (state === 'failed') return 'Retry';
    if (state === 'loading') return '…';
    if (state === 'playing') return `${clipTime(at)} / ${clipTime(duration)}`;
    return duration > 0 ? clipTime(duration) : 'Play';
  };

  const draw = () => {
    const text = say(state === 'playing' && audio ? audio.currentTime : 0);
    const key = `${state}|${text}`;
    if (key === drawn) return;
    const stateChanged = !drawn.startsWith(`${state}|`);
    drawn = key;
    if (label.textContent !== text) label.textContent = text;
    if (!stateChanged) return;
    el.dataset['state'] = state;
    // Not disabled while it asks: a button that becomes disabled loses the keyboard's focus, and a
    // press on Retry must leave the person where they were. A press while it asks is ignored below.
    el.disabled = state === 'gone';
    if (state === 'loading') el.setAttribute('aria-busy', 'true');
    else el.removeAttribute('aria-busy');
    // Pressing it while it is failed is not a toggle: it is a plain button that asks again.
    if (state === 'failed') el.removeAttribute('aria-pressed');
    else el.setAttribute('aria-pressed', String(state === 'playing'));
    el.setAttribute('aria-label', state === 'gone' ? 'No audio for this line' : state === 'failed' ? 'Retry loading audio' : PLAY);
    if (state === 'failed') el.setAttribute('title', failure);
    else el.removeAttribute('title');
    el.replaceChildren(state === 'loading' ? h('span', { class: 'spinner small', 'aria-hidden': 'true' }) : icon(GLYPH[state] ?? 'play'), label);
  };

  /** Let go of the audio and its URL; the blob is kept, so playing again costs no fetch. */
  const release = () => {
    const a = audio;
    audio = null;
    if (a) {
      a.onended = a.onerror = a.onloadedmetadata = a.ontimeupdate = null;
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
    if (url !== null) {
      URL.revokeObjectURL(url);
      url = null;
    }
  };

  const me = {
    /** Another clip has the speaker, or this chip is going: stop and put the position back to the start. */
    stop() {
      release();
      if (current === me) current = null;
      if (state === 'playing' || state === 'ready') state = 'ready';
      draw();
    },
  };

  const start = () => {
    if (!blob || destroyed) return;
    if (current && current !== me) current.stop();
    current = me;
    if (!audio) {
      url = URL.createObjectURL(blob);
      const a = new Audio(url);
      audio = a;
      a.onloadedmetadata = () => {
        if (Number.isFinite(a.duration)) duration = a.duration;
        draw();
      };
      a.ontimeupdate = draw;
      a.onended = () => me.stop();
      a.onerror = () => {
        release();
        if (current === me) current = null;
        state = 'gone'; // bytes the browser cannot play are as good as none
        draw();
      };
    }
    state = 'playing';
    draw();
    audio.play().catch(() => {
      // Not allowed to start (a browser that wants a tap closer to the sound), or interrupted.
      if (audio) me.stop();
    });
  };

  el.addEventListener('click', async () => {
    if (state === 'loading' || state === 'gone') return;
    if (state === 'playing') {
      audio?.pause();
      state = 'ready';
      draw();
      return;
    }
    if (blob) {
      start();
      return;
    }
    state = 'loading';
    draw();
    /** @type {Blob | null} */
    let got;
    try {
      got = await load(id);
    } catch (e) {
      if (destroyed) return;
      failure = e instanceof Error && e.message ? e.message : COULD_NOT_LOAD;
      state = 'failed'; // not the relay's word that there is none: pressing again asks again
      draw();
      return;
    }
    if (destroyed) return;
    if (!got) {
      state = 'gone';
      draw();
      return;
    }
    blob = got;
    state = 'ready';
    start();
  });

  draw();
  return {
    el,
    destroy() {
      destroyed = true;
      release();
      if (current === me) current = null;
    },
  };
}
