import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { autosizeOnResize, enterSends } from '../web/ui/field.js';

// What the message field and the review field decide for themselves: when Enter sends, and when a
// change of width means the height must be worked out again. The drawing is looked at in Chrome.

const globals = globalThis as Record<string, unknown>;

afterEach(() => {
  delete globals['matchMedia'];
  delete globals['ResizeObserver'];
});

const pointer = (kind: 'fine' | 'coarse') => {
  globals['matchMedia'] = (query: string) => ({ matches: query === `(pointer: ${kind})` });
};
const key = (rest: Record<string, unknown> = {}) => ({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, ...rest }) as unknown as KeyboardEvent;

describe('enterSends', () => {
  it('sends on Enter where there is a keyboard, and not on a touch screen, where Enter breaks the line', () => {
    pointer('fine');
    assert.equal(enterSends(key()), true);
    pointer('coarse');
    assert.equal(enterSends(key()), false);
  });

  it('Shift+Enter breaks the line, and any other key is not Enter', () => {
    pointer('fine');
    assert.equal(enterSends(key({ shiftKey: true })), false);
    assert.equal(enterSends(key({ key: 'a' })), false);
  });

  it('is not a send while an input method is choosing a character: isComposing, or Safari\'s keyCode 229', () => {
    pointer('fine');
    assert.equal(enterSends(key({ isComposing: true })), false);
    assert.equal(enterSends(key({ keyCode: 229 })), false);
  });

  it('is not a send in a page that cannot say what the pointer is', () => {
    assert.equal(enterSends(key()), false);
  });
});

describe('autosizeOnResize', () => {
  /** A textarea as `autosize` reads it, and the observer the page would have made for it. */
  function setup(width: number) {
    const input = { clientWidth: width, offsetHeight: 46, clientHeight: 44, scrollHeight: 100, style: { height: '' }, classList: { toggle() {} } };
    let fire = () => {};
    let watching: unknown;
    globals['ResizeObserver'] = class {
      constructor(callback: () => void) {
        fire = callback;
      }
      observe(target: unknown) {
        watching = target;
      }
    };
    autosizeOnResize(input as unknown as HTMLTextAreaElement);
    return { input, fire: () => fire(), watching: () => watching };
  }

  it('fits the field again when its width changed, which re-wraps the draft', () => {
    const { input, fire, watching } = setup(300);
    assert.equal(watching(), input);
    input.clientWidth = 520; // turned on its side
    input.scrollHeight = 64;
    fire();
    assert.equal(input.style.height, '66px'); // the text, and the two pixels of border
  });

  it('leaves it alone when only its height changed, which is what fitting it does itself', () => {
    const { input, fire } = setup(300);
    fire(); // the observer's first report, before anything moved
    input.offsetHeight = 90;
    fire();
    assert.equal(input.style.height, '');
  });

  it('leaves it alone while it is not on screen, with no width and so no lines to count, and fits it when it is back', () => {
    const { input, fire } = setup(300);
    input.clientWidth = 0;
    fire();
    assert.equal(input.style.height, '');
    input.clientWidth = 300; // shown again, perhaps with a draft that was set while it was away
    fire();
    assert.equal(input.style.height, '102px');
  });

  it('is nothing in a browser with no ResizeObserver', () => {
    assert.doesNotThrow(() => autosizeOnResize({ clientWidth: 1 } as unknown as HTMLTextAreaElement));
  });
});
