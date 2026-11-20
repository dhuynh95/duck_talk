// @ts-check
// The composer: the field and its send arrow, and under them the microphone, centred. On its
// left is what Claude is — the model and what it may do — and on its right what is running:
// mute, the speaker, and the one stop, or, while nothing is, how what you say will run (the
// mode). Glass, floating over the end of the conversation, as on the phone.
//
// While the relay holds an instruction back for review, the field gives way to the review card
// (review-card.js): the same box, asking a different question.
//
// The microphone is one value drawn as seven bars: the level, 0…1, set as a custom property
// on the button, and CSS shapes the bars from it. Nothing is rebuilt for a level; the store is
// written with one 25 times a second.
//
// One stop, because there is one question — "make it stop" — whatever is running: Claude, the
// microphone, or both. Esc asks it too.

import { h } from '../dom.js';
import { autosize, enterSends } from './field.js';
import { icon } from './icons.js';
import { modeCapsule, modeLocked, modelCapsule, permissionButton } from './pickers.js';
import { reviewCard } from './review-card.js';
import { isWorking } from './transcript-view.js';

/** @typedef {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} Store */
/** @typedef {Pick<import('../session.js').VoiceSession, 'send' | 'approve' | 'listen' | 'stopListening' | 'stopAll' | 'toggleMute' | 'output'>} SessionLike */

const BARS = 7;

/**
 * @param {Store} store
 * @param {SessionLike} session
 * @param {import('./pickers.js').Change} change how a choice is made: the speaker's, and the pickers'
 * @returns {{ el: HTMLElement, stop: () => boolean, setDraft: (text: string, focus?: boolean) => void }} `stop` stops whatever is running, and says whether anything was; `setDraft` puts words in the field — editing a line puts it back there, a new chat empties it — and, if asked, the cursor after them
 */
export function composer(store, session, change) {
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

  const row = h('div', { class: 'compose-row' }, input, send);
  const review = reviewCard(session);
  const mode = modeCapsule(store, change);

  const el = h(
    'form',
    { class: 'composer floating', dataset: { status: 'idle' } },
    row,
    review.el,
    h(
      'div',
      { class: 'compose-bar' },
      h('div', { class: 'bar-start' }, modelCapsule(store, change), permissionButton(store, change)), // what Claude is
      listen,
      h('div', { class: 'bar-end' }, mute, output, stopButton, mode), // what is running, or how it will run
    ),
  );

  // MARK: typing

  const sync = () => {
    send.disabled = !input.value.trim();
  };
  const submit = () => {
    const text = input.value;
    if (!text.trim()) return;
    session.send(text); // mid-turn too: the session makes that a barge-in
    input.value = '';
    autosize(input);
    sync();
  };

  input.addEventListener('input', () => {
    autosize(input);
    sync();
  });
  input.addEventListener('keydown', (event) => {
    if (!enterSends(event)) return;
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
  // The speaker is a setting like the rest: kept, and applied to the session, by whoever owns them.
  output.addEventListener('click', () => change({ output: !session.output }));

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
    const held = typeof state['pending'] === 'string' ? state['pending'] : null;
    if (held !== null || !review.el.hidden) {
      const hadFocus = held === null && review.focused();
      review.set(held);
      row.hidden = held !== null;
      // Accepted by keyboard: the keyboard goes back to the field. A touch screen is left alone,
      // because focus there is what raises the on-screen keyboard.
      if (hadFocus && typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches) input.focus();
    }
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
    mode.hidden = modeLocked(state);
    stopButton.setAttribute('aria-label', busy ? (status !== 'idle' ? 'Stop Claude and listening' : 'Stop Claude') : 'Stop listening');
  }

  draw(state, true);
  store.subscribe((next) => draw(next));
  return {
    el,
    stop,
    setDraft(text, focus = false) {
      input.value = text;
      autosize(input);
      sync();
      if (!focus) return;
      input.focus();
      input.setSelectionRange(text.length, text.length);
    },
  };
}
