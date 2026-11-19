// @ts-check
// Building elements from nodes, never from markup. Whatever the transcript, a chat title, a
// tool name or a skill description says is somebody else's text, and `h` is the one place the
// client turns data into page, so it is held to a short list of rules.
//
// Guarded (each breach throws, so a mistake shows the first time the code runs):
//   - Children that are strings or numbers become text nodes, which the browser shows and
//     never parses. There is no way here to hand it markup.
//   - `on…` props must be functions, attached with addEventListener. A string is refused, in
//     any letter case, so no inline handler attribute is ever written.
//   - `srcdoc`, and `style` as a string, are refused.
//   - Attributes that load or navigate (`href`, `src`, `action`, `formaction`, `data`,
//     `poster`, `xlink:href`) take only what `safeUrl` accepts.
//   - The tags `script`, `iframe`, `object`, `embed`, `base`, `meta`, `link` and `style` are
//     refused, in the types and at run time.
//
// Not guarded: a Node child is the caller's own and goes in as it is; any other attribute
// (`title`, `aria-label`, `type`, ...) is set as text, which is inert; and the relay sends no
// Content-Security-Policy, so nothing stands behind these rules but the rules.
// test/no-innerhtml.test.ts holds the rest of web/ to the same line.
//
// `document` is read when `h` is called, never when the module is loaded, so this file can
// be imported anywhere.

/** @typedef {Node | string | number | false | null | undefined} Leaf */
/**
 * A child is a leaf or a list of leaves (`items.map(...)`). Lists nested deeper work at run
 * time; the checker is only not asked to follow a type that contains itself.
 * @typedef {Leaf | Leaf[]} Child
 */

const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'style']);

/** @typedef {Exclude<keyof HTMLElementTagNameMap, 'script' | 'iframe' | 'object' | 'embed' | 'base' | 'meta' | 'link' | 'style'>} Tag */

const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'data', 'poster', 'xlink:href']);

/**
 * A URL that is safe to put in `href`, `src` and the like, as it should be written there, or
 * null if it is not.
 *
 * Safe means http, https, mailto, a small set of inline images (`data:image/` png, jpeg, gif
 * or webp), or a relative reference (`/x`, `x`, `./x`, `../x`, `?x`, `#x`). Anything else
 * with a scheme, `javascript:` first among them, is not.
 *
 * It is judged the way a browser reads it, which is not the way it is written: tabs, newlines
 * and the other control characters and spaces are dropped first (so `java<tab>script:` is
 * `javascript:`), and the scheme is compared without regard to case. What comes back is the
 * dropped-and-checked text, so what was checked is what is set. A relative URL with a space
 * in it loses the space; encode it.
 *
 * A protocol-relative `//host`, and its backslash spellings, are refused although they have
 * no scheme: they name another site, and nothing the client links to is on one.
 *
 * @param {string} value
 * @returns {string | null}
 */
export function safeUrl(value) {
  const url = value.replace(/[\u0000-\u0020\u007f]/g, '');
  if (/^[\\/]{2}/.test(url)) return null;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme === undefined) return url; // no scheme: relative to this page
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return url;
  if (scheme === 'data' && /^data:image\/(png|jpeg|gif|webp);/i.test(url)) return url;
  return null;
}

/**
 * An element with props and children.
 *
 * Props: `class`; `dataset` (an object); `style` (an object, never a string); `on…`
 * functions, attached with addEventListener under the event's name in lower case (`onclick`,
 * `onKeyDown`); `true` for a boolean attribute; `false`, null and undefined to leave it off;
 * anything else as an attribute (`aria-label`, `type`, ...), the value as a string. See the
 * top of the file for what is refused.
 *
 * @template {Tag} K
 * @param {K} tag
 * @param {Record<string, any> | null} [props]
 * @param {...Child} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, props, ...children) {
  if (FORBIDDEN_TAGS.has(String(tag).toLowerCase())) throw new Error(`h: <${tag}> is not built from data`);
  const el = document.createElement(tag);

  for (const [name, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    const attr = name.toLowerCase(); // setAttribute folds case too, so this is what would be written

    if (attr === 'class') {
      el.className = String(value);
    } else if (attr === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (attr.startsWith('on')) {
      if (typeof value !== 'function') throw new Error(`h: ${name} must be a function, not ${typeof value}`);
      el.addEventListener(attr.slice(2), value);
    } else if (attr === 'srcdoc') {
      throw new Error('h: srcdoc is not allowed');
    } else if (attr === 'style') {
      if (typeof value !== 'object') throw new Error('h: style must be an object, not a string');
      Object.assign(el.style, value);
    } else if (URL_ATTRIBUTES.has(attr)) {
      const url = safeUrl(String(value));
      if (url === null) throw new Error(`h: ${name} is not a URL this page links to`);
      el.setAttribute(attr, url);
    } else {
      el.setAttribute(attr, value === true ? '' : String(value));
    }
  }

  append(el, children);
  return el;
}

/** @param {Node} parent @param {Child[]} children */
function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (typeof child === 'string' || typeof child === 'number') parent.appendChild(document.createTextNode(String(child)));
    else parent.appendChild(child);
  }
}
