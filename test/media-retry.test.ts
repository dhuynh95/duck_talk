import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clipChip } from '../web/ui/clip-chip.js';
import { piecesRow } from '../web/ui/pieces.js';

// What the clip chip and a picture's square do with the two kinds of answer media has: null, the
// relay saying there is no file (drawn as "No audio" / an empty square, for good), and a rejection,
// the relay not having been reached (drawn as a Retry, which asks again). `h` and `icon` read the
// global `document` when called, so a stand-in is enough to see the state, the names and the
// requests; how it looks is checked in Chrome.

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
  listeners = new Map<string, ((event: unknown) => unknown)[]>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  className = '';
  hidden = false;
  disabled = false;
  textContent = '';
  src = '';
  constructor(tag: string) {
    this.tag = tag;
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
  addEventListener(type: string, fn: (event: unknown) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  appendChild(child: FakeElement | FakeText) {
    this.children.push(child);
    return child;
  }
  append(...nodes: (FakeElement | FakeText)[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: (FakeElement | FakeText)[]) {
    this.children = nodes;
  }
  replaceWith() {}
  remove() {}
  /** A press: what the page's own listener does, awaited. */
  async click() {
    await Promise.all((this.listeners.get('click') ?? []).map((fn) => fn({ detail: 1 })));
  }
}

/** Every word in the element, the way a person would read it off the screen. */
function words(el: FakeElement | FakeText): string {
  if (el instanceof FakeText) return el.data;
  return [el.textContent, ...el.children.map(words)].filter(Boolean).join(' ');
}

/** Every element below this one, itself included. */
function all(el: FakeElement): FakeElement[] {
  return [el, ...el.children.flatMap((c) => (c instanceof FakeElement ? all(c) : []))];
}

const g = globalThis as unknown as Record<string, unknown>;

class FakeAudio {
  static made: FakeAudio[] = [];
  onended: unknown = null;
  onerror: unknown = null;
  onloadedmetadata: unknown = null;
  ontimeupdate: unknown = null;
  currentTime = 0;
  duration = 1.2;
  src: string;
  constructor(src: string) {
    this.src = src;
    FakeAudio.made.push(this);
  }
  play() {
    return Promise.resolve();
  }
  pause() {}
  load() {}
  removeAttribute() {}
}

beforeEach(() => {
  FakeAudio.made = [];
  g['document'] = {
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    createTextNode: (data: string) => new FakeText(data),
  };
  g['Audio'] = FakeAudio;
});
afterEach(() => {
  delete g['document'];
  delete g['Audio'];
});

const wav = () => new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' });
const refusal = () => Promise.reject(new Error('The relay did not answer in time.'));

/** A `load` that answers with each of `answers` in turn, and counts how often it was asked. */
function loads(...answers: (() => Promise<Blob | null>)[]) {
  const calls: number[] = [];
  const load = (id: number) => {
    calls.push(id);
    const next = answers[Math.min(calls.length, answers.length) - 1];
    assert.ok(next, 'asked more often than the test planned');
    return next();
  };
  return { load, calls };
}

describe('clipChip: a failure is a Retry, and only the relay saying so is "No audio"', () => {
  it('a rejection leaves a chip that says Retry, names it, and says why on hover; it is not "gone"', async () => {
    const { load } = loads(refusal);
    const chip = clipChip({ id: 7, load });
    const button = chip.el as unknown as FakeElement;
    await button.click();
    assert.equal(button.dataset['state'], 'failed');
    assert.equal(button.disabled, false, 'there is something to press');
    assert.match(words(button), /Retry/);
    assert.equal(button.getAttribute('aria-label'), 'Retry loading audio');
    assert.equal(button.getAttribute('title'), 'The relay did not answer in time.');
    assert.equal(button.getAttribute('aria-pressed'), null, 'it is a button now, not a toggle');
    chip.destroy();
  });

  it('pressing Retry asks again, and what comes back is played: the failure was not remembered', async () => {
    const { load, calls } = loads(refusal, async () => wav());
    const chip = clipChip({ id: 7, load });
    const button = chip.el as unknown as FakeElement;
    await button.click();
    assert.equal(button.dataset['state'], 'failed');
    await button.click();
    assert.deepEqual(calls, [7, 7], 'a second request for the same clip');
    assert.equal(button.dataset['state'], 'playing');
    assert.equal(button.getAttribute('aria-label'), 'Play audio');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(button.getAttribute('title'), null, 'the reason it failed does not outlive the failure');
    assert.equal(FakeAudio.made.length, 1);
    chip.destroy();
  });

  it('it can fail again, and again be retried', async () => {
    const { load, calls } = loads(refusal, refusal, async () => wav());
    const chip = clipChip({ id: 1, load });
    const button = chip.el as unknown as FakeElement;
    await button.click();
    await button.click();
    assert.equal(button.dataset['state'], 'failed');
    await button.click();
    assert.equal(calls.length, 3);
    assert.equal(button.dataset['state'], 'playing');
    chip.destroy();
  });

  it('a retry that finds the relay has no file ends in "No audio", for good', async () => {
    const { load, calls } = loads(refusal, async () => null);
    const chip = clipChip({ id: 7, load });
    const button = chip.el as unknown as FakeElement;
    await button.click();
    await button.click();
    assert.equal(button.dataset['state'], 'gone');
    assert.equal(button.disabled, true);
    assert.match(words(button), /No audio/);
    await button.click();
    assert.equal(calls.length, 2, 'nothing more is asked of a relay that said there is none');
    chip.destroy();
  });

  it('null on the first press is "No audio" at once, with no Retry offered', async () => {
    const { load } = loads(async () => null);
    const chip = clipChip({ id: 7, load });
    const button = chip.el as unknown as FakeElement;
    await button.click();
    assert.equal(button.dataset['state'], 'gone');
    assert.equal(button.getAttribute('aria-label'), 'No audio for this line');
    assert.doesNotMatch(words(button), /Retry/);
    chip.destroy();
  });

  it('presses while it is asking do not ask again', async () => {
    let answer: (b: Blob | null) => void = () => {};
    const { load, calls } = loads(() => new Promise<Blob | null>((resolve) => (answer = resolve)));
    const chip = clipChip({ id: 7, load });
    const button = chip.el as unknown as FakeElement;
    const first = button.click();
    assert.equal(button.dataset['state'], 'loading');
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.disabled, false, 'a button that is disabled while it asks would take the keyboard focus with it');
    await button.click();
    assert.equal(calls.length, 1);
    answer(wav());
    await first;
    assert.equal(button.getAttribute('aria-busy'), null);
    chip.destroy();
  });

  it('a failure that arrives after the chip was removed does nothing', async () => {
    let fail: (e: Error) => void = () => {};
    const { load } = loads(() => new Promise<Blob | null>((_, reject) => (fail = reject)));
    const chip = clipChip({ id: 7, load });
    const button = chip.el as unknown as FakeElement;
    const pressed = button.click();
    chip.destroy();
    fail(new Error('late'));
    await pressed;
    assert.equal(button.dataset['state'], 'loading', 'left as it was: nobody is looking');
  });

  it('a rejection that is not an Error, or has no words, still gives a readable reason', async () => {
    const { load } = loads(() => Promise.reject('nope'));
    const chip = clipChip({ id: 7, load });
    const button = chip.el as unknown as FakeElement;
    await button.click();
    assert.equal(button.dataset['state'], 'failed');
    assert.equal(button.getAttribute('title'), "The audio couldn't be loaded.");
    chip.destroy();
  });
});

describe('a picture in a line: a failure is a Retry, and only the relay saying so is an empty square', () => {
  /** One stored picture, with its `image` answering in turn and its `watch` held for the test to fire. */
  function square(...answers: (() => Promise<Blob | null>)[]) {
    const calls: number[] = [];
    const watching: (() => void)[] = [];
    const row = piecesRow({
      image(id) {
        calls.push(id);
        const next = answers[Math.min(calls.length, answers.length) - 1];
        assert.ok(next, 'asked more often than the test planned');
        return next();
      },
      watch(_el, fn) {
        watching.push(fn);
        return () => {};
      },
    });
    row.update([{ type: 'image', id: 5 }]);
    const thumb = (row.el as unknown as FakeElement).children[0] as FakeElement;
    /** Scrolled into view, and every promise that sets off settled. */
    const seen = async () => {
      watching[0]?.();
      await new Promise((r) => setImmediate(r));
    };
    const press = async () => {
      await thumb.click();
      await new Promise((r) => setImmediate(r));
    };
    return { row, thumb, calls, seen, press };
  }
  const jpeg = () => new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' });

  it('a rejection leaves a square that says Retry and can be pressed', async () => {
    const { thumb, seen } = square(refusal);
    assert.equal(thumb.dataset['state'], 'loading');
    await seen();
    assert.equal(thumb.dataset['state'], 'failed');
    assert.equal(thumb.disabled, false);
    assert.match(words(thumb), /Retry/);
    assert.equal(thumb.getAttribute('aria-label'), 'Retry loading picture');
    assert.equal(thumb.getAttribute('title'), 'The relay did not answer in time.');
  });

  it('pressing it asks again, and the picture that comes back is shown and can be opened', async () => {
    const { thumb, calls, seen, press } = square(refusal, async () => jpeg());
    await seen();
    await press();
    assert.deepEqual(calls, [5, 5]);
    assert.equal(thumb.dataset['state'], 'ready');
    assert.equal(thumb.getAttribute('aria-label'), 'View picture');
    assert.equal(thumb.getAttribute('title'), null);
    const img = all(thumb).find((el) => el.tag === 'img');
    assert.match(img?.src ?? '', /^blob:/);
    assert.equal(img?.hidden, false);
  });

  it('a relay that says it has no picture leaves an empty square for good: nothing to retry', async () => {
    const { thumb, calls, seen, press } = square(async () => null);
    await seen();
    assert.equal(thumb.dataset['state'], 'missing');
    assert.equal(thumb.disabled, true);
    assert.doesNotMatch(words(thumb), /Retry/);
    await press();
    assert.equal(calls.length, 1);
  });

  it('a retry that finds none ends the same way', async () => {
    const { thumb, calls, seen, press } = square(refusal, async () => null);
    await seen();
    await press();
    assert.equal(thumb.dataset['state'], 'missing');
    assert.equal(thumb.disabled, true);
    assert.equal(calls.length, 2);
  });

  it('presses while it is asking do not ask again', async () => {
    let answer: (b: Blob | null) => void = () => {};
    const { thumb, calls, seen, press } = square(refusal, () => new Promise<Blob | null>((resolve) => (answer = resolve)));
    await seen();
    const first = thumb.click();
    assert.equal(thumb.dataset['state'], 'loading');
    await press();
    assert.equal(calls.length, 2);
    answer(jpeg());
    await first;
  });

  it('a failure that arrives after the line went does nothing', async () => {
    let fail: (e: Error) => void = () => {};
    const { row, thumb, seen } = square(() => new Promise<Blob | null>((_, reject) => (fail = reject)));
    await seen();
    row.destroy();
    fail(new Error('late'));
    await new Promise((r) => setImmediate(r));
    assert.equal(thumb.dataset['state'], 'loading');
  });
});
