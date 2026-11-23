// @ts-check
// What the ears keep mishearing, and what you actually said: the list of corrections the relay
// has learned, each opening to be edited or deleted, and a + to add one by hand.
// `CorrectionsView` and `CorrectionDetail` in Corrections.swift, ported.
//
// One sheet that changes its mind where the phone pushes onto a NavigationStack: the list, one
// correction being written, and the question that comes before deleting it. Back goes to the list
// and leaves the correction as it was: Save is what writes, and what it writes is the whole of the
// pair (the relay trims both sides and files it under `at`). "Fix what was heard" on a line opens
// the same sheet straight into the detail, seeded with what the line said and the audio it was
// heard from — a correction is a correction, wherever you noticed you needed one.
//
// The list is the relay's, newest first, and is drawn from the store: it is what the relay echoes
// back after every save and delete, so nothing here remembers what it just did or undoes it when the
// relay disagrees. A save made with no relay answering would go nowhere and say nothing, so while the
// relay is away Save and Delete are off, and the sheet says why.
//
// The two fields are never autocorrected: a phone's keyboard rewriting the very words being fixed
// would be teaching the relay its own mistakes. Everything shown is somebody else's text, set as text.

import { blankCorrection, isCorrectionComplete } from '../corrections.js';
import { h } from '../dom.js';
import { clipChip } from './clip-chip.js';
import { autosize } from './field.js';
import { icon } from './icons.js';
import { backButton, confirmPane, loadingPane, offlineNote, paneBar, paneNote, watchKeys } from './panes.js';
import { openSheet } from './sheet.js';

/** @typedef {import('../relay.js').Correction} Correction */
/** @typedef {import('./panes.js').Store} Store */
/** @typedef {Pick<import('../relay.js').RelayStore, 'saveCorrection' | 'deleteCorrection' | 'clip'>} Relay */

const FOOTER = 'Used to bias the recogniser when a session starts, and to auto-correct what you said.';
const EMPTY_TITLE = 'Nothing learned yet.';
const EMPTY_DETAIL = 'Turn on Review, and when the ears mishear you, fix the text before you accept it. That edit lands here.';

/** @param {Record<string, any>} state */
const offline = (state) => state['connected'] === false;

/**
 * Open the corrections sheet. With a `seed` it opens straight into that correction, as new unless
 * the relay already has one by that `at`.
 * @param {{ store: Store, relay: Relay }} deps
 * @param {Correction} [seed]
 */
export function openCorrections({ store, relay }, seed) {
  /** @type {'list' | 'detail' | 'confirm'} */
  let view = 'list';
  /** @type {{ el: HTMLElement, destroy: () => void, show: () => void } | null} the correction being written, kept while its delete is being asked */
  let detail = null;
  /** Where the delete question's own listener on the relay is stopped: when it is answered, and when the sheet goes. */
  let stopAsking = () => {};
  const endAsk = () => {
    stopAsking();
    stopAsking = () => {};
  };

  // MARK: the list

  const addButton = h('button', { class: 'round plain', type: 'button', 'aria-label': 'Add correction', onclick: () => openDetail(blankCorrection(Date.now()), true) }, icon('plus'));
  const body = h('div', { class: 'pane-body' });
  const list = h('div', { class: 'pane' }, paneBar(null, addButton), body);

  /** @param {Correction} c */
  const row = (c) =>
    h(
      'button',
      { class: 'choice correction-row', type: 'button', dataset: { at: String(c.at) }, onclick: () => openDetail(c, false) },
      h(
        'span',
        { class: 'choice-text' },
        h(
          'span',
          { class: 'correction-heard' },
          c.clip !== undefined ? [icon('waveform'), h('span', { class: 'sr' }, 'Has audio. ')] : null,
          h('span', null, c.heard),
        ),
        h('span', { class: 'correction-meant' }, icon('arrow-turn'), h('span', { class: 'sr' }, 'Meant: '), h('span', null, c.meant)),
      ),
      icon('chevron-right'),
    );

  /** What stands where the rows would be, and where there are none. @param {string} title @param {string} detailText @param {HTMLElement | null} [action] */
  const empty = (title, detailText, action) =>
    h('div', { class: 'pane-empty' }, h('p', { class: 'empty-title' }, title), detailText ? h('p', { class: 'empty-detail' }, detailText) : null, action ?? null);

  /** @param {Record<string, any>} state */
  const drawList = (state) => {
    /** @type {Correction[] | undefined} */
    const items = Array.isArray(state['corrections']) ? state['corrections'].filter((c) => c && typeof c.at === 'number') : undefined;
    const active = document.activeElement;
    const keep = active instanceof HTMLElement && body.contains(active) ? active.dataset['at'] : undefined;

    if (!items) {
      body.replaceChildren(
        offline(state) && state['relayError']
          ? empty("Can't reach the relay.", 'Corrections will appear here when it answers.')
          : loadingPane(),
      );
    } else if (items.length === 0) {
      body.replaceChildren(
        empty(
          EMPTY_TITLE,
          EMPTY_DETAIL,
          h('button', { class: 'button', type: 'button', onclick: () => openDetail(blankCorrection(Date.now()), true) }, 'Add one by hand'),
        ),
      );
    } else {
      const note = offlineNote();
      note.hidden = !offline(state); // a list as the relay last sent it, which cannot be changed until it answers
      body.replaceChildren(note, h('div', { class: 'choice-list' }, items.map(row)), paneNote(FOOTER));
    }
    if (keep !== undefined) /** @type {HTMLElement | null} */ (body.querySelector(`[data-at="${CSS.escape(keep)}"]`))?.focus({ preventScroll: true });
  };

  // MARK: one correction

  /**
   * @param {Correction} c
   * @param {boolean} isNew not yet in the relay's list: titled "New correction", and with nothing to delete
   */
  function openDetail(c, isNew) {
    detail?.destroy();
    const draft = { ...c };
    const chip = c.clip !== undefined ? clipChip({ id: c.clip, load: (id) => relay.clip(id) }) : null;

    // Never "corrected": a phone's autocorrect rewrites the very words you are here to fix.
    const field = (/** @type {string} */ id, /** @type {string} */ placeholder, /** @type {string} */ value, /** @type {'heard' | 'meant'} */ side) => {
      const input = h('textarea', {
        id,
        class: 'field area',
        rows: 2,
        placeholder,
        autocomplete: 'off',
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
      });
      input.value = value;
      input.addEventListener('input', () => {
        draft[side] = input.value;
        autosize(input);
        sync();
      });
      return input;
    };
    const heard = field('correction-heard', 'what the ears produced', draft.heard, 'heard');
    const meant = field('correction-meant', 'what you actually said', draft.meant, 'meant');
    // A blank starts on the first side; one seeded from a line is about to be fixed, so the cursor is
    // where the fix goes. One opened from the list is not being typed into yet.
    if (isNew) (draft.heard.trim() ? meant : heard).dataset['autofocus'] = '';

    const save = h('button', { class: 'button primary', type: 'button', onclick: () => {
      const { at, clip, proposed } = draft;
      relay.saveCorrection({ at, heard: draft.heard.trim(), meant: draft.meant.trim(), ...(clip !== undefined ? { clip } : {}), ...(proposed ? { proposed } : {}) });
      showList();
    } }, 'Save');
    const note = offlineNote();
    const remove = h('button', { class: 'button danger-quiet', type: 'button', onclick: () => askDelete(c) }, 'Delete');
    remove.hidden = isNew;

    const sync = () => {
      const away = offline(store.get());
      save.disabled = !isCorrectionComplete(draft) || away;
      remove.disabled = away;
      note.hidden = !away;
    };

    const el = h(
      'div',
      { class: 'pane' },
      paneBar(backButton('Corrections', showList), save),
      chip ? h('div', { class: 'pane-clip' }, chip.el, h('p', { class: 'pane-note' }, 'What the ears were given, exactly as they got it.')) : null,
      h('label', { class: 'pane-label', for: 'correction-heard' }, 'What it heard'),
      heard,
      h('label', { class: 'pane-label', for: 'correction-meant' }, 'What you meant'),
      meant,
      note,
      remove,
    );

    const stop = watchKeys(store, ['connected'], sync);
    detail = {
      el,
      destroy() {
        stop();
        chip?.destroy();
        if (detail?.el === el) detail = null;
      },
      show() {
        endAsk();
        view = 'detail';
        sheet.setContent(el, isNew ? 'New correction' : 'Correction');
        autosize(heard);
        autosize(meant);
      },
    };
    detail.show();
  }

  /** @param {Correction} c the correction as the relay has it, not as it is being edited */
  function askDelete(c) {
    endAsk();
    view = 'confirm';
    // With the relay gone Delete is off and says why: a delete sent to no socket is dropped without a word.
    const question = confirmPane({
      subject: `${c.heard.trim()} → ${c.meant.trim()}`,
      text: 'It will no longer bias the recogniser or auto-correct what you said.',
      cancel: 'Cancel',
      confirm: 'Delete',
      store,
      onCancel: () => detail?.show(),
      onConfirm: () => {
        relay.deleteCorrection(c.at);
        showList();
      },
    });
    stopAsking = question.destroy;
    sheet.setContent(question.el, 'Delete this correction?');
  }

  function showList() {
    endAsk();
    detail?.destroy();
    view = 'list';
    sheet.setContent(list, 'Corrections');
  }

  // Drawn before the sheet opens, so that focus lands on what is in it.
  const stop = watchKeys(store, ['corrections', 'connected', 'relayError'], drawList);
  const sheet = openSheet({
    title: 'Corrections',
    content: list,
    onClose: () => {
      stop();
      endAsk();
      detail?.destroy();
    },
    // Esc and a tap outside on the question are "no", not "leave without answering".
    beforeDismiss: () => {
      if (view !== 'confirm') return true;
      detail?.show();
      return false;
    },
  });

  if (seed) {
    const known = store.get()['corrections'];
    openDetail(seed, !(Array.isArray(known) && known.some((/** @type {Correction} */ c) => c.at === seed.at)));
  }
  return sheet;
}
