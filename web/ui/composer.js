// @ts-check
// The composer: the field and its send arrow, and under them the microphone, centred, with
// what is running on its right — mute, the speaker, and the one stop. Glass, floating over
// the end of the conversation, as on the phone. The left of that row is left empty for what
// Claude is (mode, model, permission), which arrives with its own controls.
//
// The microphone is one value drawn as seven bars: the level, 0…1, set as a custom property
// on the button, and CSS shapes the bars from it. Nothing is rebuilt for a level; the store is
// written with one 25 times a second.
//
// One stop, because there is one question — "make it stop" — whatever is running: Claude, the
// microphone, or both. Esc asks it too.

import { h } from '../dom.js';
import { icon } from './icons.js';
import { isWorking } from './transcript-view.js';

/** @typedef {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} Store */
/** @typedef {Pick<import('../session.js').VoiceSession, 'send' | 'listen' | 'stopListening' | 'stopAll' | 'toggleMute' | 'output'>} SessionLike */

/** The field grows with what is typed up to this, then scrolls. */
const MAX_FIELD = 168;
const BARS = 7;

/**
 * @param {Store} store
 * @param {SessionLike} session
 * @returns {{ el: HTMLElement, stop: () => boolean }} `stop` stops whatever is running, and says whether anything was
 */
export function composer(store, session) {
  const input = h('textarea', {
    class: 'compose-input',
    rows: 1,
    placeholder: 'Message',
    'aria-label': 'Message',
  });
  const send = h('button', { class: 'round accent send', type: 'submit', 'aria-label': 'Send', disabled: true }, icon('send'));

  const bars = Array.from({ length: BARS }, () => h('span', { class: 'bar' }));
  const listen = h(
    'button',
    { class: 'listen', type: 'button', 'aria-label': 'Listen' },
    h('span', { class: 'listen-face' }, icon('mic')),
    h('span', { class: 'wave', 'aria-hidden': 'true' }, bars),
  );
  const mute = h('button', { class: 'round plain', type: 'button', 'aria-label': 'Mute', 'aria-pressed': 'false', hidden: true }, icon('mic-off'));
  const output = h('button', { class: 'round plain', type: 'button', 'aria-label': 'Speaker off', 'aria-pressed': 'false', hidden: true }, icon('speaker-off'));
  const stopButton = h('button', { class: 'round plain stop', type: 'button', 'aria-label': 'Stop listening', hidden: true }, icon('stop'));

  const el = h(
    'form',
    { class: 'composer floating', dataset: { status: 'idle' } },
    h('div', { class: 'compose-row' }, input, send),
    h(
      'div',
      { class: 'compose-bar' },
      h('div', { class: 'bar-start' }), // what Claude is: mode, model, permission
      listen,
      h('div', { class: 'bar-end' }, mute, output, stopButton),
    ),
  );

  // MARK: typing

  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, MAX_FIELD)}px`;
    input.classList.toggle('scrolls', input.scrollHeight > MAX_FIELD);
  };
  const sync = () => {
    send.disabled = !input.value.trim();
  };
  const submit = () => {
    const text = input.value;
    if (!text.trim()) return;
    session.send(text); // mid-turn too: the session makes that a barge-in
    input.value = '';
    grow();
    sync();
  };

  input.addEventListener('input', () => {
    grow();
    sync();
  });
  // A keyboard with a fine pointer beside it sends on Enter, and Shift+Enter breaks the line.
  // On a touch screen Enter is the only way to break one, so it does that and the arrow sends.
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    if (typeof matchMedia !== 'function' || !matchMedia('(pointer: fine)').matches) return;
    event.preventDefault();
    submit();
  });
  el.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  // MARK: talking

  /** @type {Record<string, any>} */
  let state = store.get();

  // Listening is started here, in the tap, and not a moment later: a browser opens audio only
  // for a page that has just been touched.
  listen.addEventListener('click', () => {
    if ((state['status'] ?? 'idle') === 'idle') session.listen();
  });
  mute.addEventListener('click', () => session.toggleMute());
  output.addEventListener('click', () => {
    session.output = !session.output;
    draw(store.get(), true);
  });

  const stop = () => {
    const live = (state['status'] ?? 'idle') !== 'idle';
    if (isWorking(state)) session.stopAll();
    else if (live) session.stopListening();
    else return false;
    return true;
  };
  stopButton.addEventListener('click', () => {
    stop();
  });

  let level = -1;
  /** @type {string} */
  let drawn = '';
  /** @param {Record<string, any>} next @param {boolean} [force] */
  function draw(next, force = false) {
    state = next;
    const lv = Number(state['level']) || 0;
    if (lv !== level) {
      level = lv;
      listen.style.setProperty('--level', lv.toFixed(3));
    }

    const status = state['status'] ?? 'idle';
    const muted = !!state['muted'];
    const busy = isWorking(state);
    const key = `${status}|${muted}|${busy}|${session.output}`;
    if (key === drawn && !force) return;
    drawn = key;

    const live = status === 'live';
    el.dataset['status'] = status;
    listen.setAttribute('aria-label', status === 'idle' ? 'Listen' : status === 'connecting' ? 'Connecting' : 'Listening');
    mute.hidden = !live;
    output.hidden = !live;
    mute.setAttribute('aria-pressed', String(muted));
    mute.classList.toggle('lit', muted);
    output.setAttribute('aria-pressed', String(!session.output));
    output.classList.toggle('lit', !session.output);
    el.classList.toggle('muted', muted);
    stopButton.hidden = !(status !== 'idle' || busy);
    stopButton.setAttribute('aria-label', busy ? (status !== 'idle' ? 'Stop Claude and listening' : 'Stop Claude') : 'Stop listening');
  }

  draw(state, true);
  store.subscribe((next) => draw(next));
  return { el, stop };
}
