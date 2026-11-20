import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isWorking, toolLabel } from '../web/ui/transcript-view.js';

// The two rules the transcript view draws by. The drawing itself is checked in Chrome.

describe('toolLabel', () => {
  it('counts repeats as "name ×n", in the order each tool was first used', () => {
    assert.equal(toolLabel(['Read', 'Read', 'Bash', 'Read']), 'Read ×3, Bash');
    assert.equal(toolLabel(['Bash']), 'Bash');
    assert.equal(toolLabel([]), '');
  });
});

describe('isWorking', () => {
  const tools = (running: boolean) => ({ id: 1, kind: 'tools', text: '', tools: ['Read'], running, given: [] });
  const model = { id: 2, kind: 'model', text: 'done', tools: [], running: false, given: [] };

  it('is true while a turn is in flight, or the relay says the chat is working', () => {
    assert.equal(isWorking({ inFlight: true, lines: [] }), true);
    assert.equal(isWorking({ working: true, lines: [] }), true);
  });

  it('is true while the last line is a tool still running, and only the last', () => {
    assert.equal(isWorking({ lines: [tools(true)] }), true);
    assert.equal(isWorking({ lines: [tools(true), model] }), false);
    assert.equal(isWorking({ lines: [tools(false)] }), false);
  });

  it('is false with nothing going on', () => {
    assert.equal(isWorking({ lines: [] }), false);
    assert.equal(isWorking({}), false);
  });
});
