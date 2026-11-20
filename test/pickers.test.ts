import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ICON_NAMES } from '../web/ui/icons.js';
import { MODE_IDS, PERMISSION_IDS } from '../web/settings.js';
import { createStore } from '../web/store.js';
import { MODES, NO_MODELS, PERMISSIONS, effortChoices, effortFor, effortTitle, modeLocked, modelLabel, modelShortName, modelSheet, modelsState } from '../web/ui/pickers.js';

// The rules the pickers draw by, and the words they say. The sheets themselves are looked at in
// Chrome.

const model = (value: string, extra: Record<string, unknown> = {}) => ({ value, displayName: `Name of ${value}`, description: '', ...extra });

describe('modelShortName', () => {
  it('is the family out of the id: claude-opus-5[1m] becomes Opus', () => {
    assert.equal(modelShortName(model('claude-opus-5[1m]')), 'Opus');
    assert.equal(modelShortName(model('claude-fable-5[1m]')), 'Fable');
    assert.equal(modelShortName(model('claude-sonnet-4-5-20250929')), 'Sonnet');
  });

  it('capitalises an alias, which is already a family', () => {
    assert.equal(modelShortName(model('sonnet')), 'Sonnet');
    assert.equal(modelShortName(model('haiku')), 'Haiku');
  });

  it('reads what a row resolves to before what it is called: default resolving to claude-opus-5[1m] is Opus', () => {
    assert.equal(modelShortName(model('default', { resolvedModel: 'claude-opus-5[1m]' })), 'Opus');
  });

  it('falls back to the display name when there is nothing to take a family from', () => {
    assert.equal(modelShortName(model('', { displayName: 'Mystery' })), 'Mystery');
    assert.equal(modelShortName(model('claude-', { displayName: 'Mystery' })), 'Mystery');
  });

  it('says "Default" for the default alias when the relay did not say what it runs', () => {
    assert.equal(modelShortName(model('default')), 'Default');
  });
});

const models = [model('default', { resolvedModel: 'claude-opus-5[1m]' }), model('sonnet')];

describe('modelLabel: what the capsule says', () => {
  it('is "…" until the relay has sent its list', () => {
    assert.equal(modelLabel(undefined, 'default'), '…');
  });

  it('is "None" when the relay sent an empty list, which is an answer and not a wait', () => {
    assert.equal(modelLabel([], 'default'), 'None');
    assert.notEqual(modelLabel([], 'default'), modelLabel(undefined, 'default'));
  });

  it('is the family of the selected row', () => {
    assert.equal(modelLabel(models, 'default'), 'Opus');
    assert.equal(modelLabel(models, 'sonnet'), 'Sonnet');
  });

  it('shows a model the relay no longer lists as it is stored, and does not fail', () => {
    assert.equal(modelLabel(models, 'claude-retired-1'), 'claude-retired-1');
  });
});

describe('modelsState: waiting, none, or rows', () => {
  it('tells a list that has not come from one that came empty', () => {
    assert.equal(modelsState(undefined), 'loading');
    assert.equal(modelsState([]), 'none');
    assert.equal(modelsState(models), 'loaded');
  });

  it('is the same for a new array of the same rows: a reconnect sends the list again', () => {
    assert.equal(modelsState([...models]), modelsState(models));
    assert.equal(modelsState([model('other')]), modelsState(models));
  });
});

describe('effortChoices', () => {
  it('is Default first, then the levels this model takes, in the order the relay lists them', () => {
    const rows = effortChoices(model('m', { supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }));
    assert.deepEqual(rows.map((r) => r.id), ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(rows.map((r) => r.title), ['Default', 'Low', 'Medium', 'High', 'Extra', 'Max']);
  });

  it('carries the phone\'s words for each level', () => {
    const rows = effortChoices(model('m', { supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }));
    assert.deepEqual(rows.map((r) => r.detail), [
      'Let Claude Code decide',
      'Fastest, minimal thinking',
      'Moderate thinking',
      'Deep reasoning — what Default usually means',
      'Deeper than High, slower',
      'The most thorough, and the slowest',
    ]);
  });

  it('is only Default for a model that lists no levels, and nothing for no model', () => {
    assert.deepEqual(effortChoices(model('m')).map((r) => r.id), ['default']);
    assert.deepEqual(effortChoices(undefined), []);
  });

  it('gives a level it has no words for a capitalised title and no detail', () => {
    const [, row] = effortChoices(model('m', { supportedEffortLevels: ['turbo'] }));
    assert.deepEqual(row, { id: 'turbo', title: 'Turbo', detail: '' });
  });
});

describe('effortTitle', () => {
  it('shows xhigh as Extra, and capitalises the rest', () => {
    assert.equal(effortTitle('xhigh'), 'Extra');
    assert.equal(effortTitle('default'), 'Default');
    assert.equal(effortTitle('high'), 'High');
    assert.equal(effortTitle('max'), 'Max');
  });
});

describe('effortFor: what survives a change of model', () => {
  const opus = model('opus', { supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'] });

  it('keeps a level the new model takes', () => {
    assert.equal(effortFor(opus, 'high'), 'high');
    assert.equal(effortFor(opus, 'default'), 'default');
  });

  it('hands the choice back to Claude Code when the new model does not take the level, or takes none', () => {
    assert.equal(effortFor(opus, 'xhigh'), 'default');
    assert.equal(effortFor(model('haiku'), 'high'), 'default');
    assert.equal(effortFor(undefined, 'high'), 'default');
  });
});

describe('MODES and PERMISSIONS', () => {
  it('carry the phone\'s titles and details, word for word', () => {
    assert.deepEqual(MODES.map(({ id, title, detail }) => ({ id, title, detail })), [
      { id: 'direct', title: 'Direct', detail: 'Runs as soon as you stop talking' },
      { id: 'review', title: 'Review', detail: 'Shows you the text first, so you can fix it' },
    ]);
    assert.deepEqual(PERMISSIONS.map(({ id, title, detail }) => ({ id, title, detail })), [
      { id: 'plan', title: 'Plan', detail: 'Reads and thinks. Changes nothing.' },
      { id: 'acceptEdits', title: 'Edit files', detail: 'Writes and deletes files. No network, no git.' },
      { id: 'bypassPermissions', title: 'Full access', detail: 'Anything runs, including git push.' },
    ]);
  });

  it('offer exactly the values settings accepts', () => {
    assert.deepEqual(MODES.map((m) => m.id), [...MODE_IDS]);
    assert.deepEqual(PERMISSIONS.map((p) => p.id), [...PERMISSION_IDS]);
  });

  it('name icons that icons.js draws, so a typo is not a blank square', () => {
    for (const row of [...MODES, ...PERMISSIONS]) {
      assert.ok(row.icon, `${row.id} has an icon`);
      assert.ok(ICON_NAMES.includes(row.icon), `${row.icon} is drawn`);
    }
  });
});

describe('modeLocked', () => {
  it('is open to change only while nothing holds the chat socket: idle, and no turn running', () => {
    assert.equal(modeLocked({ status: 'idle', lines: [] }), false);
    assert.equal(modeLocked({}), false);
  });

  it('is locked while the microphone is open or opening, and while a turn runs', () => {
    assert.equal(modeLocked({ status: 'connecting' }), true);
    assert.equal(modeLocked({ status: 'live' }), true);
    assert.equal(modeLocked({ status: 'idle', inFlight: true }), true);
    assert.equal(modeLocked({ status: 'idle', working: true }), true);
  });
});

describe('modelSheet: when its rows are drawn again', () => {
  /** A sheet that records what it was opened with and every time its content was swapped, standing in for the one on the page. */
  function rig(initial: unknown) {
    const store = createStore<Record<string, any>>({ models: initial, settings: { model: 'default', effort: 'default' } });
    const opened: any[] = [];
    const swaps: any[] = [];
    const changes: any[] = [];
    let closed = () => {};
    const open = ((options: any) => {
      opened.push(options);
      closed = options.onClose;
      return { close: () => closed(), setContent() {}, swap: (o: unknown) => void swaps.push(o) };
    }) as never;
    const sheet = modelSheet(store as never, (patch) => void changes.push(patch), null, open);
    return { store, opened, swaps, changes, sheet, close: () => closed() };
  }

  it('opens on a spinner while the list has not come, and swaps to the rows once, when it lands', () => {
    const { store, opened, swaps } = rig(undefined);
    assert.equal(opened[0].loading, true);
    assert.equal(opened[0].empty, undefined);
    store.set({ models });
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0].loading, false);
    assert.deepEqual(swaps[0].choices.map((c: any) => c.id), ['default', 'sonnet']);
  });

  it('opens saying there are none for an empty list, with the reason, and not as a spinner', () => {
    const { opened } = rig([]);
    assert.equal(opened[0].loading, false);
    assert.equal(opened[0].empty, NO_MODELS);
    assert.match(NO_MODELS, /No models available/);
    assert.match(NO_MODELS, /signed in/);
    assert.deepEqual(opened[0].choices, []);
  });

  it('swaps from the spinner to the reason when the list arrives empty', () => {
    const { store, swaps } = rig(undefined);
    store.set({ models: [] });
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0].loading, false);
    assert.equal(swaps[0].empty, NO_MODELS);
  });

  it('swaps from the reason to the rows if the relay finds its models after all', () => {
    const { store, swaps } = rig([]);
    store.set({ models });
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0].empty, undefined);
    assert.equal(swaps[0].choices.length, 2);
  });

  it('does not redraw the rows for a new array of the same list, which a reconnect sends: focus stays where it is', () => {
    const { store, swaps } = rig(models);
    store.set({ models: models.map((m) => ({ ...m })) });
    store.set({ models: [...models] });
    assert.deepEqual(swaps, []);
  });

  it('does not redraw on the writes the microphone makes, or on any other key', () => {
    const { store, swaps } = rig(models);
    for (let i = 0; i < 5; i++) store.set({ level: i / 5 });
    store.set({ connected: false });
    store.set({ connected: true });
    assert.deepEqual(swaps, []);
  });

  it('does not redraw the rows over the effort levels', () => {
    const { store, swaps, opened } = rig([model('default', { supportsEffort: true, supportedEffortLevels: ['low', 'high'] })]);
    opened[0].trailing.open();
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0].title, 'Effort');
    store.set({ models: [] });
    assert.equal(swaps.length, 1, 'the levels stay until they are picked');
  });

  it('stops listening once it is closed', () => {
    const { store, swaps, close } = rig(undefined);
    close();
    store.set({ models });
    assert.deepEqual(swaps, []);
  });

  it('picks from the list as it is now, not as it was when the rows were drawn', () => {
    const effortful = [model('opus', { supportsEffort: true, supportedEffortLevels: ['low', 'high'] }), model('haiku')];
    const { store, opened, changes } = rig(effortful);
    store.set({ settings: { model: 'opus', effort: 'high' }, models: [model('opus', { supportsEffort: true, supportedEffortLevels: ['low'] }), model('haiku')] });
    opened[0].onPick('opus');
    assert.deepEqual(changes, [{ model: 'opus', effort: 'default' }], 'high is not one of the levels it takes any more');
  });
});

