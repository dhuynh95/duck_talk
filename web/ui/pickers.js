// @ts-check
// The things you pick rather than type: what happens to what you say (mode), which model
// answers (and how hard it thinks), and what it may do (permission). `Choices.swift` and the
// bar under the composer in `ContentView.swift`, ported.
//
// Mode and model are small words in the bar — capsules — each opening a sheet that says what
// every choice means, because a name you can read beats an icon nobody can read without being
// told. Permission is not in the bar — you set it once and forget it — but behind the plus
// (context-sheet.js), which opens `permissionSheet` from here. Two of the three lists are known
// by heart, since the answers are the same on every machine; the model list only the relay can
// know, so it arrives down the data socket and is drawn by the same rows.
//
// The choices live in the store as `settings`; a pick asks `change` for a new one, and
// whatever owns them (main.js) keeps them, applies them and writes them down. Capsules read the
// store and update in place: it is written 25 times a second while the microphone is open.

import { h } from '../dom.js';
import { isWorking } from './transcript-view.js';
import { choiceSheet } from './sheet.js';

/** @typedef {import('../relay.js').ClaudeModel} ClaudeModel */
/** @typedef {import('../settings.js').Settings} Settings */
/** @typedef {import('./sheet.js').Choice} Choice */
/** @typedef {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} Store */
/** The one way a picker changes anything: ask for a different choice, by the names `Settings` uses. @typedef {(patch: Partial<Settings>) => void} Change */

// MARK: the words

/**
 * The one word the capsule shows: the family out of the id the row actually runs
 * (`claude-opus-5[1m]` is Opus), taken from what it resolves to rather than what it is called,
 * because an alias names no model — "Default" in the bar would leave you not knowing whether
 * Opus or Sonnet is answering.
 * @param {Pick<ClaudeModel, 'value' | 'displayName' | 'resolvedModel'>} model
 */
export function modelShortName(model) {
  const id = model.resolvedModel ?? model.value;
  const family = id.replaceAll('claude-', '').split('-').find(Boolean) ?? '';
  return family ? family.charAt(0).toUpperCase() + family.slice(1) : model.displayName;
}

/**
 * What the relay has said about its models: nothing yet (`loading`), a list with nothing in it
 * (`none` — the CLI is not signed in, or could not say), or rows to pick from (`loaded`). The
 * relay answers with `[]` for the second, so it must not be read as the first: a spinner that is
 * never going to stop tells a person nothing, and the reason is the thing they can act on.
 * @param {ClaudeModel[] | undefined} models
 * @returns {'loading' | 'none' | 'loaded'}
 */
export function modelsState(models) {
  if (!models) return 'loading';
  return models.length === 0 ? 'none' : 'loaded';
}

/** What the capsule says, and the sheet shows where the rows would be, when the relay has no model to offer. */
export const NO_MODELS = 'No models available — is Claude Code signed in?';

/**
 * What the model capsule says: "…" until the relay has sent its list, "None" if it sent an empty
 * one, the family of the selected row once it has rows, and the stored value as it is for a model
 * the list no longer has — the relay's list can change under a choice made last week, and the
 * capsule must still say something.
 * @param {ClaudeModel[] | undefined} models
 * @param {string} value
 */
export function modelLabel(models, value) {
  if (!models) return '…';
  if (models.length === 0) return 'None';
  const row = models.find((m) => m.value === value);
  return row ? modelShortName(row) : value;
}

/** The word a level wears on screen. The wire says "xhigh"; nobody should read that. @param {string} level */
export function effortTitle(level) {
  if (level === 'xhigh') return 'Extra';
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/** @param {string} level */
function effortDetail(level) {
  switch (level) {
    case 'low': return 'Fastest, minimal thinking';
    case 'medium': return 'Moderate thinking';
    case 'high': return 'Deep reasoning — what Default usually means';
    case 'xhigh': return 'Deeper than High, slower';
    case 'max': return 'The most thorough, and the slowest';
    default: return '';
  }
}

/**
 * How hard this model can think, as rows to pick from: built from the levels the relay says it
 * takes — never a list written into the page — with "Default" first, because not choosing is
 * itself the ordinary choice. No model, no rows.
 * @param {Pick<ClaudeModel, 'supportedEffortLevels'> | undefined} model
 * @returns {Choice[]}
 */
export function effortChoices(model) {
  if (!model) return [];
  const rows = (model.supportedEffortLevels ?? []).map((level) => ({ id: level, title: effortTitle(level), detail: effortDetail(level) }));
  return [{ id: 'default', title: 'Default', detail: 'Let Claude Code decide' }, ...rows];
}

/**
 * The effort to keep when the model changes: the same one if the new model takes it, otherwise
 * the CLI's own choice — the relay would refuse a level the model does not have.
 * @param {Pick<ClaudeModel, 'supportsEffort' | 'supportedEffortLevels'> | undefined} model
 * @param {string} effort
 */
export function effortFor(model, effort) {
  if (effort === 'default') return 'default';
  return model?.supportsEffort === true && model.supportedEffortLevels?.includes(effort) ? effort : 'default';
}

/** What happens to what you say. Two answers, and the difference matters enough to spell out. @type {readonly (Choice & { id: Settings['mode'] })[]} */
export const MODES = Object.freeze([
  { id: 'direct', title: 'Direct', detail: 'Runs as soon as you stop talking', icon: 'bolt-circle' },
  { id: 'review', title: 'Review', detail: 'Shows you the text first, so you can fix it', icon: 'check-circle' },
]);

/**
 * What Claude may do while it answers: three rungs of the SDK's six, because the others wait for
 * someone to answer "can I run this?" and nothing here can. The words say what each does rather
 * than what it is called, because the middle one's name misleads: acceptEdits deletes files.
 * @type {readonly (Choice & { id: Settings['permission'] })[]}
 */
export const PERMISSIONS = Object.freeze([
  { id: 'plan', title: 'Plan', detail: 'Reads and thinks. Changes nothing.', icon: 'eye' },
  { id: 'acceptEdits', title: 'Edit files', detail: 'Writes and deletes files. No network, no git.', icon: 'pencil' },
  { id: 'bypassPermissions', title: 'Full access', detail: 'Anything runs, including git push.', icon: 'bolt' },
]);

/**
 * Mode rides the chat socket's address, so it is fixed while a socket is wanted: while the
 * microphone is open or being opened, and while a turn is running.
 * @param {Record<string, any>} state
 */
export function modeLocked(state) {
  return (state['status'] ?? 'idle') !== 'idle' || isWorking(state);
}

// MARK: the bar

/**
 * A word you can press. Every choice in the bar wears this one face, so which of them you are
 * looking at is the word rather than the shape. The button is 44 px to touch and the capsule is
 * smaller to look at. Redrawn in place, touching only what moved.
 * @param {string} name what it chooses, for a screen reader ("Model")
 */
function capsule(name) {
  const text = h('span', { class: 'capsule-text' });
  const el = h('button', { class: 'capsule', type: 'button', 'aria-haspopup': 'dialog' }, text);
  let drawn = '';
  return {
    el,
    /** @param {{ label: string, title: string, disabled?: boolean, loading?: boolean }} look */
    draw({ label, title, disabled = false, loading = false }) {
      const key = `${label}|${title}|${disabled}|${loading}`;
      if (key === drawn) return;
      drawn = key;
      if (text.textContent !== label) text.textContent = label;
      el.setAttribute('aria-label', `${name}: ${label}`);
      el.title = title;
      el.disabled = disabled;
      el.classList.toggle('loading', loading);
    },
  };
}

/**
 * The model that will answer, in one word. Always open to change: the relay takes a new one
 * mid-conversation, from the next turn.
 * @param {Store} store
 * @param {Change} change
 * @returns {HTMLButtonElement}
 */
export function modelCapsule(store, change) {
  const c = capsule('Model');
  /** @param {Record<string, any>} state */
  const draw = (state) => {
    /** @type {ClaudeModel[] | undefined} */
    const models = state['models'];
    /** @type {Settings} */
    const settings = state['settings'];
    const row = models?.find((m) => m.value === settings.model);
    const known = modelsState(models);
    c.draw({ label: modelLabel(models, settings.model), title: known === 'none' ? NO_MODELS : (row?.displayName ?? 'Model'), loading: known === 'loading' });
  };
  draw(store.get());
  store.subscribe(draw);
  c.el.addEventListener('click', () => modelSheet(store, change, c.el));
  return c.el;
}

/**
 * What happens to what you say. Disabled with the reason while a socket is wanted (the bar
 * hides it then, but it must not say it can be used if it is ever drawn).
 * @param {Store} store
 * @param {Change} change
 * @returns {HTMLButtonElement}
 */
export function modeCapsule(store, change) {
  const c = capsule('Mode');
  /** @param {Record<string, any>} state */
  const draw = (state) => {
    const mode = MODES.find((m) => m.id === state['settings'].mode) ?? MODES[0];
    const locked = modeLocked(state);
    c.draw({ label: mode.title, title: locked ? 'Stop listening and wait for Claude to finish to change the mode' : 'Mode', disabled: locked });
  };
  draw(store.get());
  store.subscribe(draw);
  c.el.addEventListener('click', () => modeSheet(store, change, c.el));
  return c.el;
}

// MARK: the sheets

/**
 * `opener` in each of these is the button to give focus back to; left out, it is whatever had focus.
 * @param {Store} store
 * @param {Change} change
 * @param {HTMLElement | null} [opener]
 */
export function modeSheet(store, change, opener) {
  if (modeLocked(store.get())) return null;
  return choiceSheet({
    opener,
    title: 'Mode',
    choices: [...MODES],
    picked: store.get()['settings'].mode,
    onPick: (id) => change({ mode: /** @type {Settings['mode']} */ (id) }),
  });
}

/**
 * What Claude may do, as a sheet of its own: the context sheet's Permission row opens it.
 * @param {Store} store
 * @param {Change} change
 * @param {HTMLElement | null} [opener]
 */
export function permissionSheet(store, change, opener) {
  return choiceSheet({
    opener,
    title: 'What Claude may do',
    choices: [...PERMISSIONS],
    picked: store.get()['settings'].permission,
    onPick: (id) => change({ permission: /** @type {Settings['permission']} */ (id) }),
  });
}

/**
 * The only list the page does not know by heart. Effort rides along as a row under the models
 * rather than a fourth capsule in the bar: it is a property of the model chosen — which levels
 * exist is the model's own — and this is where that choice is being made. Picking it swaps this
 * sheet's rows for the levels, in place.
 *
 * The rows are drawn again only when what the sheet can say changes — the list arriving, or
 * turning out empty — and not whenever a new array of the same rows comes in: the relay sends
 * the whole list again on every reconnect, and redrawing then would take the focus off a row
 * someone is reading.
 * @param {Store} store
 * @param {Change} change
 * @param {HTMLElement | null} [opener]
 * @param {typeof choiceSheet} [open] how the sheet is put on the page; a test hands in its own
 */
export function modelSheet(store, change, opener, open = choiceSheet) {
  /** @type {'model' | 'effort'} */
  let view = 'model';
  /** @type {ReturnType<typeof modelsState>} what the model rows were last drawn as */
  let drawn = 'loading';
  let unsubscribe = () => {};

  const models = () => /** @type {ClaudeModel[] | undefined} */ (store.get()['models']);
  const settings = () => /** @type {Settings} */ (store.get()['settings']);

  /** @returns {import('./sheet.js').ChoiceOptions} */
  const modelOptions = () => {
    drawn = modelsState(models());
    const list = models() ?? [];
    const row = list.find((m) => m.value === settings().model);
    return {
      title: 'Model',
      choices: list.map((m) => ({ id: m.value, title: m.displayName, detail: m.description })),
      picked: settings().model,
      loading: drawn === 'loading',
      empty: drawn === 'none' ? NO_MODELS : undefined,
      // Read when it is picked, not when the rows were drawn: the list may have been sent again since.
      onPick: (id) => change({ model: id, effort: effortFor(models()?.find((m) => m.value === id), settings().effort) }),
      trailing: row?.supportsEffort === true
        ? {
            title: 'Effort',
            value: effortTitle(settings().effort),
            open: () => {
              view = 'effort';
              sheet.swap(effortOptions());
            },
          }
        : undefined,
    };
  };

  /** @returns {import('./sheet.js').ChoiceOptions} */
  const effortOptions = () => ({
    title: 'Effort',
    choices: effortChoices(models()?.find((m) => m.value === settings().model)),
    picked: settings().effort,
    onPick: (id) => change({ effort: id }),
  });

  const sheet = open({ ...modelOptions(), opener, onClose: () => unsubscribe() });
  // The list may still be on its way when this opens: the rows replace the spinner when it lands.
  unsubscribe = store.subscribe((state) => {
    if (view === 'model' && modelsState(state['models']) !== drawn) sheet.swap(modelOptions());
  });
  return sheet;
}
