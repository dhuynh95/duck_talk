import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { reviewCard } from '../web/ui/review-card.js';

// What the review card does with the keyboard: where focus goes when an instruction is held, and
// what Esc does in its field. `h` and `icon` read the global `document` when called, so a stand-in
// that records focus and blur is enough to see it; the card on screen is looked at in Chrome.

class FakeText {
  data: string;
  constructor(data: string) {
    this.data = data;
  }
}

class FakeElement {
  tag: string;
  attributes = new Map<string, string>();
  children: unknown[] = [];
  listeners = new Map<string, ((event: unknown) => void)[]>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = { toggle() {} };
  className = '';
  hidden = false;
  disabled = false;
  value = '';
  textContent = '';
  // What `autosize` reads.
  offsetHeight = 46;
  clientHeight = 44;
  scrollHeight = 60;
  focused = 0;
  blurred = 0;
  selection: [number, number] | null = null;
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(type: string, fn: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  appendChild(child: unknown) {
    this.children.push(child);
    return child;
  }
  setSelectionRange(start: number, end: number) {
    this.selection = [start, end];
  }
  focus() {
    this.focused++;
  }
  blur() {
    this.blurred++;
  }
  fire(type: string, event: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

const g = globalThis as unknown as Record<string, unknown>;
let made: FakeElement[] = [];
let dialogOpen = false;

beforeEach(() => {
  made = [];
  dialogOpen = false;
  const create = (tag: string) => {
    const el = new FakeElement(tag);
    made.push(el);
    return el;
  };
  g['document'] = {
    createElement: create,
    createElementNS: (_ns: string, tag: string) => create(tag),
    createTextNode: (data: string) => new FakeText(data),
    querySelector: () => (dialogOpen ? new FakeElement('div') : null),
  };
});
afterEach(() => {
  delete g['document'];
  delete g['matchMedia'];
});

const pointer = (kind: 'fine' | 'coarse') => {
  g['matchMedia'] = (query: string) => ({ matches: query === `(pointer: ${kind})` });
};

/** A card, and its instruction field and card element as the fake made them. */
function card() {
  const review = reviewCard({ approve() {} });
  const field = made.find((el) => el.tag === 'textarea');
  assert.ok(field, 'the card has a field');
  return { review, field, el: review.el as unknown as FakeElement, note: review.note as unknown as FakeElement };
}

const esc = (rest: Record<string, unknown> = {}) => {
  const event = { key: 'Escape', isComposing: false, keyCode: 27, prevented: 0, preventDefault() { this.prevented++; }, ...rest };
  return event;
};

describe('reviewCard: where the keyboard goes when an instruction is held', () => {
  it('on a touch screen the field is not focused, which would raise the on-screen keyboard mid-conversation; the card still says what to do', () => {
    pointer('coarse');
    const { review, field, el, note } = card();
    review.set('delete the cash');
    assert.equal(field.focused, 0);
    assert.equal(field.selection, null);
    assert.equal(el.hidden, false);
    assert.equal(field.value, 'delete the cash');
    assert.equal(note.textContent, 'Review the instruction, then Accept');
    assert.equal(el.attributes.get('role'), 'group');
  });

  it('where there is no way to tell the pointer, it is left alone too', () => {
    const { review, field } = card();
    review.set('delete the cash');
    assert.equal(field.focused, 0);
  });

  it('with a fine pointer the field is focused, the cursor after the words', () => {
    pointer('fine');
    const { review, field } = card();
    review.set('delete the cash');
    assert.equal(field.focused, 1);
    assert.deepEqual(field.selection, [15, 15]);
  });

  it('with a fine pointer it still does not take the keyboard out of a dialog or menu that is open', () => {
    pointer('fine');
    dialogOpen = true;
    const { review, field, note } = card();
    review.set('delete the cash');
    assert.equal(field.focused, 0);
    assert.equal(note.textContent, 'Review the instruction, then Accept');
  });

  it('the same instruction again does not move it again, and none empties the note', () => {
    pointer('fine');
    const { review, field, note } = card();
    review.set('delete the cash');
    review.set('delete the cash');
    assert.equal(field.focused, 1);
    review.set(null);
    assert.equal(note.textContent, '');
  });
});

describe('reviewCard: Esc in the field', () => {
  it('leaves the field, and is taken so the page does not stop Claude with it', () => {
    const { field } = card();
    const event = esc();
    field.fire('keydown', event);
    assert.equal(event.prevented, 1);
    assert.equal(field.blurred, 1);
  });

  it('while an input method is composing it is the input method\'s, and the field is not left: isComposing', () => {
    const { field } = card();
    const event = esc({ isComposing: true });
    field.fire('keydown', event);
    assert.equal(event.prevented, 1);
    assert.equal(field.blurred, 0);
  });

  it('...and in Safari, whose Esc during composition says only keyCode 229', () => {
    const { field } = card();
    const event = esc({ isComposing: false, keyCode: 229 });
    field.fire('keydown', event);
    assert.equal(event.prevented, 1);
    assert.equal(field.blurred, 0);
  });
});
