// @ts-check
// Building elements without ever reading a string as markup. Whatever the transcript, a chat
// title or a tool name says is somebody else's text, so the client builds the page from
// nodes: strings become text nodes, which the browser shows and never parses, and there is
// no other way in through here. test/no-innerhtml.test.ts holds the rest of web/ to that.
//
// `document` is read when `h` is called, never when the module is loaded, so this file can
// be imported anywhere.

/** @typedef {Node | string | number | false | null | undefined} Leaf */
/**
 * A child is a leaf or a list of leaves (`items.map(...)`). Lists nested deeper work at run
 * time; the checker is only not asked to follow a type that contains itself.
 * @typedef {Leaf | Leaf[]} Child
 */

/**
 * An element with props and children.
 *
 * Props: `class`; `dataset` (an object); `on…` functions, attached with addEventListener
 * under the event's name in lower case (`onclick`, `onKeyDown`); `true` for a boolean
 * attribute; `false`, null and undefined to leave it off; anything else as an attribute
 * (`aria-label`, `type`, ...), the value as a string.
 *
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, any> | null} [props]
 * @param {...Child} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);

  for (const [name, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') {
      el.className = String(value);
    } else if (name === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (name.startsWith('on') && typeof value === 'function') {
      el.addEventListener(name.slice(2).toLowerCase(), value);
    } else {
      el.setAttribute(name, value === true ? '' : String(value));
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
