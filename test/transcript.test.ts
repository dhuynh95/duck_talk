import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Transcript } from '../web/transcript.js';

// The transcript is a reducer over the relay's text frames: no socket, no audio, no clock.
// Each case feeds it the frames a turn produces and reads back what the screen would show.

const kinds = (t: Transcript) => t.state.lines.map((l) => l.kind);

describe('Transcript: speech', () => {
  it('replaces the utterance with each partial user frame and adds no line', () => {
    const t = new Transcript();
    t.handle({ type: 'user', text: 'turn on', partial: true });
    t.handle({ type: 'user', text: 'turn off the', partial: true });
    assert.equal(t.state.utterance, 'turn off the');
    assert.deepEqual(t.state.lines, []);
  });

  it('commits exactly one user line at turn_start, with the clip it was heard from, and names the chat', () => {
    const t = new Transcript();
    t.handle({ type: 'user', text: 'fix the ', partial: true });
    t.handle({ type: 'user', text: ' fix the tests ', partial: false, clip: 1700000000123 });
    const fx = t.handle({ type: 'turn_start', session: 'chat-1' });
    assert.deepEqual(fx, { waiting: true, expectReply: true });
    assert.equal(t.state.lines.length, 1);
    const [line] = t.state.lines;
    assert.equal(line?.kind, 'user');
    assert.equal(line?.text, 'fix the tests');
    assert.equal(line?.clip, 1700000000123);
    assert.equal(t.state.utterance, null);
    assert.equal(t.state.heardClip, null);
    assert.equal(t.state.chatId, 'chat-1');
    assert.equal(t.state.inFlight, true);
    // a second sign of the same turn commits nothing more
    t.handle({ type: 'model', text: 'On it.' });
    assert.deepEqual(kinds(t), ['user', 'model']);
  });
});

describe('Transcript: the reply', () => {
  it('joins model chunks into one line until a named tool starts a tools line, and the next model starts a new line', () => {
    const t = new Transcript();
    t.sendTyped('go');
    t.handle({ type: 'turn_start', session: 'c' });
    t.handle({ type: 'model', text: 'Reading ' });
    t.handle({ type: 'model', text: 'the file.' });
    const fx = t.handle({ type: 'tool', text: 'Read', parent: null });
    assert.deepEqual(fx, { waiting: true });
    t.handle({ type: 'tool', text: 'Grep', parent: null });
    t.handle({ type: 'model', text: 'Done.' });
    assert.deepEqual(kinds(t), ['user', 'model', 'tools', 'model']);
    assert.equal(t.state.lines[1]?.text, 'Reading the file.');
    assert.deepEqual(t.state.lines[2]?.tools, ['Read', 'Grep']);
    assert.equal(t.state.lines[3]?.text, 'Done.');
  });

  it('starts a new model line after turn_start even when the last line is a model line (a turn joined mid-way)', () => {
    const t = new Transcript();
    t.show([{ uuid: 'm0', role: 'model', text: 'Earlier block.' }], 'c');
    t.handle({ type: 'turn_start', session: 'c' });
    t.handle({ type: 'model', text: 'Next block.' });
    assert.deepEqual(t.state.lines.map((l) => l.text), ['Earlier block.', 'Next block.']);
  });

  it('ends the running tools on a nameless tool without parent, and not on one with a parent', () => {
    const t = new Transcript();
    t.sendTyped('fan out');
    t.handle({ type: 'tool', text: 'Agent', parent: null });
    assert.equal(t.state.lines.at(-1)?.running, true);
    t.handle({ type: 'tool', text: 'Bash', parent: 'agent-1' });
    t.handle({ type: 'tool', parent: 'agent-1' });
    assert.equal(t.state.lines.at(-1)?.running, true, 'a subagent finishing a tool is not the Agent finishing');
    t.handle({ type: 'tool', parent: null });
    assert.equal(t.state.lines.at(-1)?.running, false);
    assert.deepEqual(t.state.lines.at(-1)?.tools, ['Agent', 'Bash']);
  });

  it('copies user.uuid/after and model.uuid onto the last user and model lines at turn_end, and clears inFlight', () => {
    const t = new Transcript();
    t.sendTyped('hello');
    t.handle({ type: 'turn_start', session: 'c1' });
    t.handle({ type: 'model', text: 'Hi.' });
    t.handle({ type: 'tool', text: 'Read', parent: null });
    const fx = t.handle({ type: 'turn_end', session: 'c1', user: { uuid: 'u1', after: 'm0' }, model: { uuid: 'm1' } });
    assert.deepEqual(fx, { waiting: false });
    assert.equal(t.state.inFlight, false);
    const user = t.state.lines.find((l) => l.kind === 'user');
    const model = t.state.lines.find((l) => l.kind === 'model');
    assert.equal(user?.uuid, 'u1');
    assert.equal(user?.after, 'm0');
    assert.equal(model?.uuid, 'm1');
    assert.equal(t.state.lines.at(-1)?.running, false, 'the tools stop running when the turn ends');
  });

  it('commits a final utterance at turn_end even when the turn answered nothing', () => {
    const t = new Transcript();
    t.handle({ type: 'user', text: 'never mind', partial: false });
    t.handle({ type: 'turn_end' });
    assert.deepEqual(t.state.lines.map((l) => l.text), ['never mind']);
  });

  it('records an error', () => {
    const t = new Transcript();
    t.handle({ type: 'error', text: 'Claude is unreachable' });
    assert.equal(t.state.error, 'Claude is unreachable');
  });
});

describe('Transcript: retract and attachments', () => {
  it('on interrupted+retract after a commit, removes the user, tool and model lines and returns the pieces to attached', () => {
    const t = new Transcript();
    t.show([{ uuid: 'm0', role: 'model', text: 'Earlier.' }], 'c');
    t.attach({ id: 11, data: 'AAAA' });
    t.attach({ id: 12, text: 'a long paste' });
    t.handle({ type: 'user', text: 'refactor the', partial: false });
    t.handle({ type: 'turn_start', session: 'c' });
    assert.deepEqual(t.state.attached, [], 'committing moves the pieces onto the line');
    assert.deepEqual(t.state.lines.at(-1)?.given, [
      { type: 'image', id: 11, data: 'AAAA' },
      { type: 'text', id: 12, text: 'a long paste' },
    ]);
    t.handle({ type: 'tool', text: 'Read', parent: null });
    t.handle({ type: 'model', text: 'Which part?' });
    const fx = t.handle({ type: 'interrupted', retract: true });
    assert.deepEqual(fx, { waiting: false, flush: true });
    assert.deepEqual(t.state.lines.map((l) => l.text), ['Earlier.']);
    // the same ids: the relay still holds them for the re-run
    assert.deepEqual(t.state.attached, [
      { id: 11, data: 'AAAA' },
      { id: 12, text: 'a long paste' },
    ]);
  });

  it('retracts nothing when this turn committed nothing', () => {
    const t = new Transcript();
    t.sendTyped('first');
    t.handle({ type: 'turn_start', session: 'c' });
    t.handle({ type: 'model', text: 'Answer.' });
    t.handle({ type: 'turn_end' });
    t.handle({ type: 'interrupted', retract: true });
    assert.deepEqual(kinds(t), ['user', 'model']);
  });

  it('a plain interrupted flushes and removes nothing', () => {
    const t = new Transcript();
    t.handle({ type: 'user', text: 'stop', partial: false });
    t.handle({ type: 'turn_start' });
    t.handle({ type: 'model', text: 'Sure' });
    assert.deepEqual(t.handle({ type: 'interrupted' }), { waiting: false, flush: true });
    assert.deepEqual(kinds(t), ['user', 'model']);
  });

  it('drop takes one pending piece back by id', () => {
    const t = new Transcript();
    t.attach({ id: 1, data: 'x' });
    t.attach({ id: 2, text: 'y' });
    t.drop(1);
    assert.deepEqual(t.state.attached, [{ id: 2, text: 'y' }]);
  });

  it('sendTyped appends the user line at once with the pending pieces and sets inFlight', () => {
    const t = new Transcript();
    t.attach({ id: 5, data: 'jpeg' });
    assert.equal(t.sendTyped('  look at this  '), true);
    assert.equal(t.state.inFlight, true);
    assert.equal(t.state.lines[0]?.text, 'look at this');
    assert.deepEqual(t.state.lines[0]?.given, [{ type: 'image', id: 5, data: 'jpeg' }]);
    assert.deepEqual(t.state.attached, []);
    assert.equal(t.sendTyped('   '), false);
    assert.equal(t.state.lines.length, 1);
  });
});

describe('Transcript: review mode', () => {
  it('approval sets pending and clears the utterance; approve commits the edited text', () => {
    const t = new Transcript();
    t.handle({ type: 'user', text: 'delete the logs', partial: false, clip: 7 });
    t.handle({ type: 'approval', text: 'delete the logs' });
    assert.equal(t.state.pending, 'delete the logs');
    assert.equal(t.state.utterance, null);
    assert.equal(t.approve('delete the old logs'), true);
    assert.equal(t.state.pending, null);
    assert.equal(t.state.lines[0]?.text, 'delete the old logs');
    assert.equal(t.state.lines[0]?.clip, 7);
    // nothing held: nothing to approve
    assert.equal(t.approve('again'), false);
    assert.equal(t.state.lines.length, 1);
  });
});

describe('Transcript: show and noise', () => {
  it('puts a stored chat on screen, with its pictures by id and its pastes whole, and resets the turn', () => {
    const t = new Transcript();
    t.attach({ id: 1, data: 'x' });
    t.sendTyped('old');
    t.handle({ type: 'error', text: 'bad' });
    t.show(
      [
        { uuid: 'u1', role: 'user', text: 'see', clip: 3, images: [9], pastes: ['p'] },
        { uuid: 'm1', after: 'u1', role: 'model', text: 'seen' },
      ],
      'chat-9',
    );
    assert.equal(t.state.chatId, 'chat-9');
    assert.equal(t.state.inFlight, false);
    assert.equal(t.state.error, null);
    assert.deepEqual(t.state.attached, []);
    const [u, m] = t.state.lines;
    assert.equal(u?.kind, 'user');
    assert.equal(u?.uuid, 'u1');
    assert.equal(u?.clip, 3);
    assert.deepEqual(u?.given, [
      { type: 'image', id: 9 },
      { type: 'text', text: 'p' },
    ]);
    assert.equal(m?.kind, 'model');
    assert.equal(m?.after, 'u1');
    assert.notEqual(u?.id, m?.id);
  });

  it('ignores unknown event types and frames that are not events', () => {
    const t = new Transcript();
    const before = t.state;
    assert.deepEqual(t.handle({ type: 'something_new', text: 'x' }), {});
    assert.deepEqual(t.handle(null), {});
    assert.deepEqual(t.handle('user'), {});
    assert.deepEqual(t.handle({ text: 'no type' }), {});
    assert.deepEqual(t.state, before);
  });

  it('never changes a line array or line in place, so a subscriber can compare', () => {
    const t = new Transcript();
    t.sendTyped('a');
    t.handle({ type: 'model', text: 'b' });
    const lines = t.state.lines;
    const model = lines[1];
    t.handle({ type: 'model', text: 'c' });
    assert.notEqual(t.state.lines, lines);
    assert.equal(model?.text, 'b');
    assert.equal(t.state.lines[1]?.text, 'bc');
  });
});
