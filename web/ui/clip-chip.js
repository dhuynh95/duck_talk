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
// A clip the relay no longer has (it keeps them a week, unless a correction was taught from
// one) is said once, quietly, and the chip goes inert.

import { h } from '../dom.js';
import { icon } from './icons.js';

/** @typedef {{ el: HTMLButtonElement, destroy: () => void }} ClipChip */

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
 * @param {{ id: number, load: (id: number) => Promise<Blob | null> }} options `load` fetches the audio: null, a clip that is gone
 * @returns {ClipChip}
 */
export function clipChip({ id, load }) {
  const label = h('span', { class: 'clip-label' }, 'Play');
  const el = h('button', { class: 'clip-chip', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Play what was heard' });

  /** @type {'idle' | 'loading' | 'ready' | 'playing' | 'gone'} ready: the audio is in hand and not playing */
  let state = 'idle';
  /** @type {Blob | null} */
  let blob = null;
  /** @type {HTMLAudioElement | null} */
  let audio = null;
  /** @type {string | null} */
  let url = null;
  let duration = 0;
  let destroyed = false;
  let drawn = '';

  const draw = () => {
    const at = state === 'playing' && audio ? audio.currentTime : 0;
    const text =
      state === 'gone' ? 'No audio' : state === 'loading' ? '…' : state === 'playing' ? `${clipTime(at)} / ${clipTime(duration)}` : duration > 0 ? clipTime(duration) : 'Play';
    const key = `${state}|${text}`;
    if (key === drawn) return;
    const stateChanged = !drawn.startsWith(`${state}|`);
    drawn = key;
    if (label.textContent !== text) label.textContent = text;
    if (!stateChanged) return;
    el.dataset['state'] = state;
    el.disabled = state === 'loading' || state === 'gone';
    el.setAttribute('aria-pressed', String(state === 'playing'));
    el.setAttribute('aria-label', state === 'gone' ? 'No audio for this line' : state === 'playing' ? 'Pause' : 'Play what was heard');
    el.replaceChildren(state === 'loading' ? h('span', { class: 'spinner small', 'aria-hidden': 'true' }) : icon(state === 'playing' ? 'pause' : state === 'gone' ? 'waveform' : 'play'), label);
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
    const got = await load(id);
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
