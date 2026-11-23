import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { h, safeUrl } from '../web/dom.js';

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
  style: Record<string, string> = {};
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

  describe('refuses what would run or load something', () => {
    it('a string for an on* prop, in any case, is an error and writes no attribute', () => {
      for (const name of ['onclick', 'ONCLICK', 'onClick', 'onerror', 'onload']) {
        assert.throws(() => build('div', { [name]: 'alert(1)' }), /must be a function/, name);
      }
      assert.throws(() => build('div', { onclick: true }), /must be a function/);
    });

    it('a function for an on* prop in capitals is still attached, under the lower-case event name', () => {
      const fn = () => {};
      const el = build('div', { ONCLICK: fn });
      assert.deepEqual(el.listeners, [{ type: 'click', fn }]);
      assert.equal(el.attributes.size, 0);
    });

    it('a javascript: URL in href, src, action or formaction is an error', () => {
      for (const name of ['href', 'src', 'action', 'formaction', 'HREF', 'poster', 'data', 'xlink:href']) {
        assert.throws(() => build('a', { [name]: 'javascript:alert(1)' }), /not a URL/, name);
      }
    });

    it('a data: page in src is an error', () => {
      assert.throws(() => build('img', { src: 'data:text/html,<script>alert(1)</script>' }), /not a URL/);
    });

    it('srcdoc is an error, in any case', () => {
      assert.throws(() => build('div', { srcdoc: '<script>alert(1)</script>' }), /srcdoc/);
      assert.throws(() => build('div', { SRCDOC: 'x' }), /srcdoc/);
    });

    it('style as a string is an error; as an object it sets the element style', () => {
      assert.throws(() => build('div', { style: 'background:url(javascript:alert(1))' }), /style must be an object/);
      assert.deepEqual(build('div', { style: { width: '40%' } }).style, { width: '40%' });
    });

    it('script, iframe, object, embed, base, meta, link and style cannot be built, in any case', () => {
      for (const tag of ['script', 'iframe', 'IFRAME', 'object', 'embed', 'base', 'meta', 'link', 'style']) {
        assert.throws(() => build(tag), /is not built from data/, tag);
      }
    });

    it('a URL that is fine is set, as safeUrl wrote it', () => {
      const el = build('a', { href: ' https://example.com/a?b=1\n', target: '_blank' });
      assert.equal(el.attributes.get('href'), 'https://example.com/a?b=1');
      assert.equal(build('img', { src: '/logo.svg' }).attributes.get('src'), '/logo.svg');
    });
  });
});

describe('safeUrl', () => {
  it('lets through http, https, mailto and relative references as they are', () => {
    for (const url of [
      'http://example.com',
      'https://example.com/a?b=1#c',
      'HTTPS://EXAMPLE.COM',
      'mailto:someone@example.com',
      '/logo.svg',
      'page.html',
      './page.html',
      '../page.html',
      '?chat=1',
      '#top',
      '/a?next=javascript:alert(1)', // a scheme later on is data, not a scheme
      'a/b:c',
    ]) {
      assert.equal(safeUrl(url), url, url);
    }
  });

  it('lets through an inline png, jpeg, gif or webp', () => {
    for (const type of ['png', 'jpeg', 'gif', 'webp', 'PNG']) {
      const url = `data:image/${type};base64,AAAA`;
      assert.equal(safeUrl(url), url, url);
    }
  });

  it('refuses javascript: however it is dressed', () => {
    for (const url of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'JAVASCRIPT:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'java\r\nscript:alert(1)',
      'java\u0000script:alert(1)',
      ' javascript:alert(1)',
      '\n\tjavascript:alert(1)',
      '\u0001javascript:alert(1)',
      'javascript:alert(1)\n',
      'jav ascript:alert(1)',
    ]) {
      assert.equal(safeUrl(url), null, JSON.stringify(url));
    }
  });

  it('refuses other schemes and every data: that is not one of the four images', () => {
    for (const url of [
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://example.com',
      'blob:https://example.com/x',
      'tel:+1234',
      'data:text/html,<script>alert(1)</script>',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/png,AAAA', // no ;base64 marker: not what the client sends
      'DATA:TEXT/HTML,x',
      'data:,x',
      'x-unknown:thing',
    ]) {
      assert.equal(safeUrl(url), null, url);
    }
  });

  it('refuses a protocol-relative URL, in every spelling a browser accepts', () => {
    for (const url of ['//evil.example/x', '\\\\evil.example', '/\\evil.example', '\\/evil.example', ' //evil.example', '/\t/evil.example']) {
      assert.equal(safeUrl(url), null, JSON.stringify(url));
    }
  });

  it('drops spaces and control characters from what it returns', () => {
    assert.equal(safeUrl('  /a b\tc\n'), '/abc');
    assert.equal(safeUrl(''), '');
  });
});
