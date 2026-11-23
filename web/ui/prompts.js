// @ts-check
// What the relay says to each model, as words you can change: the list of prompts the relay has,
// each opening to an editor. `PromptsView` and `PromptDetail` in Prompts.swift, ported.
//
// This knows there are prompts but not which: the title, what it does, whether it is `live`, and
// its text all come from the relay, and one added there appears here with nothing to change. A
// prompt that is not live is read when a session starts, so while one is running its row is closed
// — greyed, not openable, and saying why on the row itself — rather than letting an edit promise
// what it cannot do. The rules are in prompts.js.
//
// The editor opens with the cursor in the text and says, under it, when an edit takes effect (once:
// the relay's own detail usually says it already, and then nothing is added). Its
// draft is seeded once, from the row as it was opened, and never from the socket: the
// relay's echo of your own save, or of anyone else's, cannot overwrite what you are typing. A draft
// that differs from the relay's text is not thrown away by accident: Back, the X, Esc and a tap
// outside each ask first, in the sheet (never with the browser's own dialogs). A save made with no
// relay answering would go nowhere and say nothing, so then Save is off and the sheet says why.

import { h } from '../dom.js';
import { liveNote, promptDirty, promptEditable, promptNote, showLiveNote } from '../prompts.js';
import { icon } from './icons.js';
import { backButton, confirmPane, loadingPane, offlineNote, paneBar, paneNote, watchKeys } from './panes.js';
import { openSheet } from './sheet.js';

/** @typedef {import('../relay.js').Prompt} Prompt */
/** @typedef {import('./panes.js').Store} Store */
/** @typedef {Pick<import('../relay.js').RelayStore, 'savePrompt'>} Relay */

const LIVE_FOOTER = 'A prompt that is fixed when a session starts can be changed once you stop this one.';

/** A session is connecting or running: the Swift's `VoiceSession.shared.status != .idle`. @param {Record<string, any>} state */
const sessionLive = (state) => (state['status'] ?? 'idle') !== 'idle';

/**
 * @param {{ store: Store, relay: Relay }} deps
 */
export function openPrompts({ store, relay }) {
  /** @type {'list' | 'editor' | 'confirm'} */
  let view = 'list';
  /** @type {{ show: () => void, dirty: () => boolean } | null} the prompt being edited, kept while the question about leaving it is asked */
  let editor = null;

  // MARK: the list

  const body = h('div', { class: 'pane-body' });
  const list = h('div', { class: 'pane' }, body);

  /** @param {Prompt} p @param {boolean} live */
  const row = (p, live) => {
    const open = promptEditable(p, live);
    return h(
      'button',
      {
        class: 'choice prompt-row',
        type: 'button',
        disabled: !open,
        title: open ? false : 'Fixed when a session starts: stop listening to change it',
        dataset: { name: p.name },
        onclick: () => openEditor(p),
      },
      h(
        'span',
        { class: 'choice-text' },
        h('span', { class: 'choice-title' }, p.title),
        h('span', { class: 'choice-detail' }, p.detail),
        h('span', { class: 'prompt-note' }, promptNote(p, live), p.text.trim() ? null : ' Not set.'),
      ),
      icon('chevron-right'),
    );
  };

  /** @param {Record<string, any>} state */
  const drawList = (state) => {
    /** @type {Prompt[] | undefined} */
    const items = Array.isArray(state['prompts'])
      ? state['prompts'].filter((p) => p && typeof p.name === 'string' && typeof p.title === 'string' && typeof p.text === 'string')
      : undefined;
    const live = sessionLive(state);
    const active = document.activeElement;
    const keep = active instanceof HTMLElement && body.contains(active) ? active.dataset['name'] : undefined;

    if (!items) {
      body.replaceChildren(
        state['connected'] === false && state['relayError']
          ? h('div', { class: 'pane-empty' }, h('p', { class: 'empty-title' }, "Can't reach the relay."), h('p', { class: 'empty-detail' }, 'Prompts will appear here when it answers.'))
          : loadingPane(),
      );
    } else {
      const rows = [h('div', { class: 'choice-list' }, items.map((p) => row(p, live)))];
      if (live) rows.push(paneNote(LIVE_FOOTER));
      body.replaceChildren(...rows);
    }
    if (keep !== undefined) {
      const again = /** @type {HTMLButtonElement | null} */ (body.querySelector(`[data-name="${CSS.escape(keep)}"]`));
      if (again && !again.disabled) again.focus({ preventScroll: true });
    }
  };

  // MARK: one prompt

  /** Where the editor's own store listener is stopped: as it is left, and when the sheet goes. */
  let stopEditor = () => {};
  const release = () => {
    stopEditor();
    stopEditor = () => {};
    editor = null;
  };

  /** @param {Prompt} p */
  function openEditor(p) {
    // What the relay says about the prompt, and — unless that already says when an edit takes effect — when it does.
    const about = paneNote(p.detail);
    about.id = 'prompt-about';
    const when = showLiveNote(p) ? paneNote(liveNote(p)) : null;
    if (when) when.id = 'prompt-when';
    const input = h('textarea', {
      id: 'prompt-text',
      class: 'field area prompt-text',
      rows: 14,
      'aria-label': p.title,
      'aria-describedby': when ? `${about.id} ${when.id}` : about.id,
      dataset: { autofocus: '' }, // you came here to write: the cursor is in it, and is back in it after "Keep editing"
      // Never "corrected": the words are an instruction, and a phone rewriting them changes what it says.
      autocomplete: 'off',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
    });
    input.value = p.text;

    const dirty = () => promptDirty(p, input.value);
    const save = h('button', { class: 'button primary', type: 'button', onclick: () => {
      relay.savePrompt(p.name, input.value);
      showList();
    } }, 'Save');
    const note = offlineNote();
    const sync = () => {
      const away = store.get()['connected'] === false;
      save.disabled = !dirty() || away;
      note.hidden = !away;
    };
    input.addEventListener('input', sync);

    const leave = () => {
      if (dirty()) askDiscard(showList);
      else showList();
    };
    const el = h('div', { class: 'pane' }, paneBar(backButton('Prompts', leave), save), input, about, when, note);

    const stop = watchKeys(store, ['connected'], sync);
    editor = {
      dirty,
      show() {
        view = 'editor';
        sheet.setContent(el, p.title);
      },
    };
    stopEditor = stop;
    editor.show();
  }

  /** @param {() => void} then what to do once the changes are given up */
  function askDiscard(then) {
    view = 'confirm';
    sheet.setContent(
      confirmPane({
        text: "These changes haven't been saved.",
        cancel: 'Keep editing',
        confirm: 'Discard',
        onCancel: () => editor?.show(),
        onConfirm: then,
      }).el,
      'Discard changes?',
    );
  }

  function showList() {
    release();
    view = 'list';
    sheet.setContent(list, 'Prompts');
  }

  // Drawn before the sheet opens, so that focus lands on the first row and not on the close button.
  const stop = watchKeys(store, ['prompts', 'status', 'connected', 'relayError'], drawList);
  const sheet = openSheet({
    title: 'Prompts',
    content: list,
    onClose: () => {
      stop();
      release();
    },
    beforeDismiss: () => {
      if (view === 'confirm') {
        editor?.show(); // Esc on the question is "no"
        return false;
      }
      if (view === 'editor' && editor?.dirty()) {
        askDiscard(() => sheet.close());
        return false;
      }
      return true;
    },
  });
  return sheet;
}
