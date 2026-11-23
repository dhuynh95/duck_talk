import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { skillList } from '../web/ui/skill-list.js';

// How the "/" list behaves around the pointer and around the relay re-sending its skills. `h` reads
// the global `document` when called, so a stand-in that records scrolling, selection and what was
// picked is enough; the list on screen is looked at in Chrome.

class FakeText {
  data: string;
  constructor(data: string) {
    this.data = data;
  }
}

class FakeElement {
  tag: string;
  attributes = new Map<string, string>();
  children: (FakeElement | FakeText)[] = [];
  listeners = new Map<string, ((event: unknown) => void)[]>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  className = '';
  value = '';
  scrollTop = 0;
  scrolled = 0;
  constructor(tag: string) {
    this.tag = tag;
  }
  get id() {
    return this.attributes.get('id') ?? '';
  }
  // `hidden` is an attribute the page reads as a property, as in a browser.
  get hidden() {
    return this.attributes.has('hidden');
  }
  set hidden(on: boolean) {
    if (on) this.attributes.set('hidden', '');
    else this.attributes.delete('hidden');
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  addEventListener(type: string, fn: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  appendChild(child: FakeElement | FakeText) {
    this.children.push(child);
    return child;
  }
  replaceChildren(...nodes: (FakeElement | FakeText)[]) {
    this.children = nodes;
  }
  scrollIntoView() {
    this.scrolled++;
  }
  focus() {}
  fire(type: string, event: Record<string, unknown> = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

const g = globalThis as unknown as Record<string, unknown>;
beforeEach(() => {
  g['document'] = {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (data: string) => new FakeText(data),
  };
});
afterEach(() => {
  delete g['document'];
});

type Skill = { name: string; description: string; argumentHint: string };
const skill = (name: string, description = '', argumentHint = ''): Skill => ({ name, description, argumentHint });
const SKILLS = [skill('review', 'Review the diff'), skill('simplify', 'Simplify changed code', '[path]'), skill('revert', 'Undo the last commit', '<sha>')];

/** A list over a field, with the relay's skills in a store a test can change. */
function setup(skills: Skill[] = SKILLS) {
  const input = new FakeElement('textarea');
  let state: Record<string, any> = { skills };
  const subscribers: ((s: Record<string, any>) => void)[] = [];
  const store = {
    get: () => state,
    subscribe(fn: (s: Record<string, any>) => void) {
      subscribers.push(fn);
      return () => {};
    },
  };
  const picked: Skill[] = [];
  const list = skillList(input as unknown as HTMLTextAreaElement, store, (s) => picked.push(s as Skill));
  const el = list.el as unknown as FakeElement;
  return {
    input,
    list,
    el,
    picked,
    rows: () => el.children as FakeElement[],
    /** The relay's `skills` frame arrives: a new array, as every frame makes. */
    relayAnswers(next: Skill[]) {
      state = { ...state, skills: next };
      for (const fn of subscribers) fn(state);
    },
    /** Type into the field, with focus in it. */
    type(text: string) {
      input.value = text;
      input.fire('input');
    },
    focus() {
      input.fire('focus');
    },
  };
}

const words = (row: FakeElement) => row.children.map((c) => (c instanceof FakeText ? c.data : (c.children[0] as FakeText).data));
const selected = (rows: FakeElement[]) => rows.map((r) => r.getAttribute('aria-selected'));

describe('skillList: the pointer and the keyboard', () => {
  it('pointing at a row selects it but does not scroll the list: the row is under the pointer already', () => {
    const t = setup();
    t.focus();
    t.type('/');
    const rows = t.rows();
    assert.equal(rows.length, 3);
    for (const r of rows) r.scrolled = 0;
    rows[2]!.fire('pointermove');
    assert.deepEqual(selected(rows), ['false', 'false', 'true']);
    assert.equal(t.input.getAttribute('aria-activedescendant'), rows[2]!.id, 'Enter would take it');
    assert.deepEqual(rows.map((r) => r.scrolled), [0, 0, 0]);
  });

  it('the arrow keys scroll the row they land on into view, including the wrap round to the first', () => {
    const t = setup();
    t.focus();
    t.type('/');
    const rows = t.rows();
    for (const r of rows) r.scrolled = 0;
    const key = (k: string) => t.list.keydown({ key: k, isComposing: false, keyCode: 0, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent);
    assert.equal(key('ArrowDown'), true);
    assert.deepEqual(rows.map((r) => r.scrolled), [0, 1, 0]);
    key('ArrowDown');
    key('ArrowDown'); // wraps to the first
    assert.deepEqual(rows.map((r) => r.scrolled), [1, 1, 1]);
    key('ArrowUp'); // wraps to the last
    assert.equal(rows[2]!.scrolled, 2);
    assert.deepEqual(selected(rows), ['false', 'false', 'true']);
  });

  it('typing again does not scroll a row the pointer chose: only a key that moves the highlight does', () => {
    const t = setup();
    t.focus();
    t.type('/');
    const rows = t.rows();
    rows[1]!.fire('pointermove');
    for (const r of rows) r.scrolled = 0;
    t.type('/'); // the same text, as a key that changes nothing would leave it
    assert.equal(t.rows()[1], rows[1], 'the rows are kept');
    assert.deepEqual(rows.map((r) => r.scrolled), [0, 0, 0]);
    assert.deepEqual(selected(rows), ['false', 'true', 'false'], 'and the highlight stays where it was pointed');
  });

  it('a list that is rebuilt for new text starts at its top, with the first row the highlighted one', () => {
    const t = setup();
    t.focus();
    t.type('/');
    t.el.scrollTop = 120; // scrolled down through a long list
    t.type('/re');
    assert.deepEqual(t.rows().map((r) => words(r)[0]), ['/review', '/revert']);
    assert.equal(t.el.scrollTop, 0);
    assert.deepEqual(selected(t.rows()), ['true', 'false']);
  });
});

describe('skillList: the relay sends its skills again', () => {
  it('the same skills, as a new array, leave the rows as they are: a reconnect is not a reason to lose the highlight', () => {
    const t = setup();
    t.focus();
    t.type('/');
    const before = t.rows();
    before[1]!.fire('pointermove');
    t.relayAnswers(SKILLS.map((s) => ({ ...s })));
    assert.deepEqual(t.rows(), before);
    assert.deepEqual(selected(t.rows()), ['false', 'true', 'false']);
  });

  it('a skill whose hint changed has its row built again, and a click picks the skill the row now shows', () => {
    const t = setup();
    t.focus();
    t.type('/');
    const old = t.rows()[1]!;
    assert.deepEqual(words(old), ['/simplify', '[path]', 'Simplify changed code']);
    const fresh = skill('simplify', 'Simplify changed code', '[path] [--fix]');
    t.relayAnswers([SKILLS[0]!, fresh, SKILLS[2]!]);
    const row = t.rows()[1]!;
    assert.notEqual(row, old, 'a new row');
    assert.deepEqual(words(row), ['/simplify', '[path] [--fix]', 'Simplify changed code']);
    row.fire('click');
    assert.deepEqual(t.picked, [fresh], 'the object that is in the store now, hint and all');
    assert.equal(t.picked[0]!.argumentHint, '[path] [--fix]');
  });

  it('a skill whose description changed has its row built again', () => {
    const t = setup();
    t.focus();
    t.type('/');
    const fresh = skill('review', 'Review the current diff, then the tests');
    t.relayAnswers([fresh, SKILLS[1]!, SKILLS[2]!]);
    assert.deepEqual(words(t.rows()[0]!), ['/review', 'Review the current diff, then the tests']);
    t.rows()[0]!.fire('click');
    assert.deepEqual(t.picked, [fresh]);
  });

  it('a skill that went away, or came, changes the rows as it always did', () => {
    const t = setup();
    t.focus();
    t.type('/');
    t.relayAnswers([SKILLS[0]!, skill('deploy', 'Ship it')]);
    assert.deepEqual(t.rows().map((r) => words(r)[0]), ['/review', '/deploy']);
  });

  it('a change that is only in a row the text has filtered out does not touch the rows on show', () => {
    const t = setup();
    t.focus();
    t.type('/rev');
    const before = t.rows();
    t.relayAnswers([SKILLS[0]!, skill('simplify', 'Something else entirely', '[x]'), SKILLS[2]!]);
    assert.deepEqual(t.rows(), before);
  });
});
