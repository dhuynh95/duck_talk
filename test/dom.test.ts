import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { h } from '../web/dom.js';

// h reads the global `document` when it is called, so a stand-in that records what was
// asked of it is enough to see what h does with each kind of prop and child. The real
// DOM is exercised by loading the page.
class FakeText {
  data: string;
  constructor(data: string) {
    this.data = data;
  }
}
class FakeElement {
  attributes = new Map<string, string>();
  children: unknown[] = [];
  listeners: { type: string; fn: unknown }[] = [];
  dataset: Record<string, string> = {};
  className = '';
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(type: string, fn: unknown) {
    this.listeners.push({ type, fn });
  }
  appendChild(child: unknown) {
    this.children.push(child);
    return child;
  }
}

const g = globalThis as unknown as { document?: unknown };
const original = g.document;
beforeEach(() => {
  g.document = {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (data: string) => new FakeText(data),
  };
});
afterEach(() => {
  g.document = original;
});

/** `h` returns a real Element in the browser; here it is the fake, so the checks read it as such. */
function build(tag: string, props?: Record<string, unknown> | null, ...children: unknown[]) {
  return (h as unknown as (...args: unknown[]) => FakeElement)(tag, props, ...children);
}

describe('h', () => {
  it('turns strings and numbers into text nodes, so markup in them stays text', () => {
    const el = build('p', null, '<img src=x onerror=alert(1)>', 7);
    assert.deepEqual(el.children, [new FakeText('<img src=x onerror=alert(1)>'), new FakeText('7')]);
  });

  it('flattens arrays and skips null, undefined and false', () => {
    const inner = build('b');
    const el = build('p', null, ['a', [inner, null]], undefined, false, 'z');
    assert.deepEqual(el.children, [new FakeText('a'), inner, new FakeText('z')]);
  });

  it('sets class, dataset, aria and plain attributes', () => {
    const el = build('button', { class: 'pill', dataset: { id: '4' }, 'aria-label': 'Close', type: 'button' });
    assert.equal(el.className, 'pill');
    assert.deepEqual(el.dataset, { id: '4' });
    assert.equal(el.attributes.get('aria-label'), 'Close');
    assert.equal(el.attributes.get('type'), 'button');
  });

  it('writes a true boolean as a bare attribute and leaves false, null and undefined off', () => {
    const el = build('input', { disabled: true, required: false, hidden: null, readonly: undefined });
    assert.equal(el.attributes.get('disabled'), '');
    assert.deepEqual([...el.attributes.keys()], ['disabled']);
  });

  it('attaches on* handlers with addEventListener, named without the "on"', () => {
    const click = () => {};
    const el = build('button', { onclick: click, onKeyDown: click });
    assert.deepEqual(el.listeners, [
      { type: 'click', fn: click },
      { type: 'keydown', fn: click },
    ]);
    assert.equal(el.attributes.size, 0); // never an inline handler attribute
  });
});
