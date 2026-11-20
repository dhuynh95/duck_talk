import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ICON_NAMES } from '../web/ui/icons.js';
import { MODE_IDS, PERMISSION_IDS } from '../web/settings.js';
import { MODES, PERMISSIONS, effortChoices, effortFor, effortTitle, modeLocked, modelLabel, modelShortName } from '../web/ui/pickers.js';

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

describe('modelLabel: what the capsule says', () => {
  const models = [model('default', { resolvedModel: 'claude-opus-5[1m]' }), model('sonnet')];

  it('is "…" until the relay has sent its list', () => {
    assert.equal(modelLabel(undefined, 'default'), '…');
    assert.equal(modelLabel([], 'default'), '…');
  });

  it('is the family of the selected row', () => {
    assert.equal(modelLabel(models, 'default'), 'Opus');
    assert.equal(modelLabel(models, 'sonnet'), 'Sonnet');
  });

  it('shows a model the relay no longer lists as it is stored, and does not fail', () => {
    assert.equal(modelLabel(models, 'claude-retired-1'), 'claude-retired-1');
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
