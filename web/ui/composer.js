// @ts-check
// The composer: the field and its send arrow, and under them the microphone, centred. On its
// left is what you add (the plus: a picture, and what Claude may do with it) and what Claude is —
// the model — and on its right what is running: mute, the speaker, and the one stop, or, while
// nothing is, how what you say will run (the mode). Glass, floating over the end of the
// conversation, as on the phone.
//
// Above the field: the list of skills while you type "/…" (skill-list.js), what the next
// instruction will carry (attach-chips.js) and, in a line of its own, how adding one is going.
// A picture or a long text pasted into the field joins that list instead of the words
// (intake.js does the work; the plus sheet, context-sheet.js, is the other way in).
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

import { isLongPaste } from '../attach.js';
import { h } from '../dom.js';
import { createIntake } from '../intake.js';
import { attachChips } from './attach-chips.js';
import { contextButton } from './context-sheet.js';
import { autosize, autosizeOnResize, enterSends } from './field.js';
import { icon } from './icons.js';
import { modeCapsule, modeLocked, modelCapsule } from './pickers.js';
import { reviewCard } from './review-card.js';
import { skillList } from './skill-list.js';
import { isWorking } from './transcript-view.js';

/** @typedef {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} Store */
/** @typedef {Pick<import('../session.js').VoiceSession, 'send' | 'approve' | 'attach' | 'drop' | 'listen' | 'stopListening' | 'stopAll' | 'toggleMute' | 'output'>} SessionLike */

const BARS = 7;
/** How long a reason something was not added stays up, in ms. */
const NOTE_FOR = 7000;

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

  // What a skill takes after its name, in muted type where the words will go: a placeholder shows
  // only in an empty field, and the field is not empty — it holds "/name ". The ghost is a copy of
  // that text, invisible, with the hint written after it, behind the field.
  const ghostText = h('span', { class: 'ghost-text' });
  const ghostHint = h('span', { class: 'ghost-hint' });
  const ghost = h('div', { class: 'compose-ghost', 'aria-hidden': 'true', hidden: true }, ghostText, ghostHint);
  const field = h('div', { class: 'compose-field' }, ghost, input);
  const row = h('div', { class: 'compose-row' }, field, send);
  const review = reviewCard(session);
  const mode = modeCapsule(store, change);

  // How adding something is going: working on it, or why it was not added. Always in the page, so
  // a screen reader hears it change; empty, it takes no room.
  const note = h('div', { class: 'compose-note', role: 'status', dataset: { kind: '' } }, h('span', { class: 'spinner small', 'aria-hidden': 'true' }), h('span', { class: 'note-text' }));
  const noteText = /** @type {HTMLElement} */ (note.lastElementChild);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let noteTimer;
  /** @param {string} text @param {'busy' | 'error'} kind */
  const say = (text, kind) => {
    noteText.textContent = text;
    note.dataset['kind'] = text ? kind : '';
  };
  const intake = createIntake({
    session,
    status: {
      busy(text) {
        clearTimeout(noteTimer);
        if (text !== null) say(text, 'busy');
        else if (note.dataset['kind'] === 'busy') say('', 'busy');
      },
      error(text) {
        clearTimeout(noteTimer);
        say(text, 'error');
        noteTimer = setTimeout(() => say('', 'error'), NOTE_FOR);
      },
    },
  });

  const chips = attachChips(store, { drop: (id) => session.drop(id), focusField: () => input.focus() });

  const skills = skillList(input, store, (skill) => {
    const typed = `/${skill.name} `;
    input.value = typed;
    input.setSelectionRange(typed.length, typed.length);
    autosize(input);
    sync();
    ghostText.textContent = typed;
    ghostHint.textContent = skill.argumentHint ?? '';
    ghost.hidden = !skill.argumentHint;
  });

  const el = h(
    'form',
    { class: 'composer floating', dataset: { status: 'idle' } },
    skills.el,
    chips,
    note,
    row,
    review.el,
    review.note,
    h(
      'div',
      { class: 'compose-bar' },
      h('div', { class: 'bar-start' }, contextButton(store, change, intake), modelCapsule(store, change)), // what you add, and what Claude is
      listen,
      h('div', { class: 'bar-end' }, mute, output, stopButton, mode), // what is running, or how it will run
    ),
  );

  // MARK: typing

  const sync = () => {
    send.disabled = !input.value.trim();
  };
  /** The hint under a chosen skill lasts until the words are anything but what the pick wrote. */
  const clearGhost = () => {
    if (ghost.hidden || input.value === ghostText.textContent) return;
    ghost.hidden = true;
  };
  const submit = () => {
    const text = input.value;
    if (!text.trim()) return;
    session.send(text); // mid-turn too: the session makes that a barge-in
    input.value = '';
    clearGhost();
    autosize(input);
    sync();
  };

  input.addEventListener('input', () => {
    clearGhost();
    autosize(input);
    sync();
  });
  autosizeOnResize(input);
  input.addEventListener('keydown', (event) => {
    if (skills.keydown(event)) return; // the list is open and took the key: Enter picks, it does not send
    if (!enterSends(event)) return;
    event.preventDefault();
    submit();
  });

  // The arrow must not take the keyboard from the field: on a phone the keyboard is the field's
  // focus, and a tap that moved it to the button would put the keyboard away between two
  // messages. A press is kept off the button while the field has focus (`held`); a send by key
  // (Tab to the arrow, Enter) leaves focus on a button that is about to be disabled, and so
  // takes it back to the field. A tap made with the keyboard already away leaves it away.
  /** Whether the field had focus when the arrow was pressed; null when no pointer pressed it. @type {boolean | null} */
  let held = null;
  send.addEventListener('pointerdown', () => {
    held = document.activeElement === input;
  });
  send.addEventListener('mousedown', (event) => {
    if (held) event.preventDefault();
  });
  send.addEventListener('pointercancel', () => (held = null));
  send.addEventListener('keydown', () => (held = null));
  el.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
    if (event.submitter === send && (held ?? true)) input.focus({ preventScroll: true });
    held = null;
  });

  // A picture on the clipboard, or a text too long to be a sentence, goes with the instruction
  // instead of into the field. Anything else pastes as it always did, and is left alone here.
  input.addEventListener('paste', (event) => {
    const data = event.clipboardData;
    if (!data) return;
    const pictures = [...data.items].flatMap((item) => (item.kind === 'file' && item.type.startsWith('image/') ? (item.getAsFile() ?? []) : []));
    if (pictures.length > 0) {
      event.preventDefault();
      void intake.addFiles(pictures);
      return;
    }
    const text = data.getData('text/plain');
    if (isLongPaste(text)) {
      event.preventDefault();
      intake.addPaste(text);
    }
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
      if (held !== null) skills.close(); // the field is away: so is what it was offering
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
      clearGhost();
      autosize(input);
      sync();
      skills.update();
      if (!focus) return;
      input.focus();
      input.setSelectionRange(text.length, text.length);
    },
  };
}
