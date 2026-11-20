// @ts-check
// The few glyphs the screen wears, drawn as inline SVG from constant shapes in this file.
// Nothing here comes from data, and nothing is parsed: each shape is built node by node with
// createElementNS. Every icon is decoration — `aria-hidden` — and the button it sits in
// carries the name.

const SVG = 'http://www.w3.org/2000/svg';

/** @typedef {[tag: 'path' | 'rect' | 'circle', attrs: Record<string, string>]} Shape */

/** Drawn on a 24×24 grid with a 2 px round stroke, unless a shape says otherwise. @type {Record<string, Shape[]>} */
const SHAPES = {
  chats: [
    ['path', { d: 'M4 6h16M4 12h16M4 18h11' }],
  ],
  settings: [
    ['path', { d: 'M4 7h9M17 7h3M4 17h3M11 17h9' }],
    ['circle', { cx: '15', cy: '7', r: '2' }],
    ['circle', { cx: '9', cy: '17', r: '2' }],
  ],
  mic: [
    ['rect', { x: '9', y: '3', width: '6', height: '11', rx: '3' }],
    ['path', { d: 'M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21' }],
  ],
  'mic-off': [
    ['path', { d: 'M15 9.5V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.9 2.3' }],
    ['path', { d: 'M5.5 11a6.5 6.5 0 0 0 11 4.7M18.5 11a6.4 6.4 0 0 1-.3 2M12 17.5V21M3 3l18 18' }],
  ],
  speaker: [
    ['path', { d: 'M11 5 6.5 9H3v6h3.5l4.5 4z' }],
    ['path', { d: 'M15.5 9a4.5 4.5 0 0 1 0 6M18.5 6a8.5 8.5 0 0 1 0 12' }],
  ],
  'speaker-off': [
    ['path', { d: 'M11 5 6.5 9H3v6h3.5l4.5 4z' }],
    ['path', { d: 'm16 9.5 5 5m0-5-5 5' }],
  ],
  stop: [
    ['rect', { x: '6.5', y: '6.5', width: '11', height: '11', rx: '2', fill: 'currentColor', stroke: 'none' }],
  ],
  send: [
    ['path', { d: 'M12 19V5M6 11l6-6 6 6' }],
  ],
  down: [
    ['path', { d: 'M12 5v14M6 13l6 6 6-6' }],
  ],
  check: [
    ['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }],
  ],
  close: [
    ['path', { d: 'M6 6l12 12M18 6L6 18' }],
  ],
  'chevron-right': [
    ['path', { d: 'M9 5l7 7-7 7' }],
  ],
  // Permission: what Claude may do, from looking to doing anything.
  eye: [
    ['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z' }],
    ['circle', { cx: '12', cy: '12', r: '3' }],
  ],
  pencil: [
    ['path', { d: 'M14 6l4 4M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z' }],
  ],
  bolt: [
    ['path', { d: 'M13 3L5 13.5h6L10 21l8-10.5h-6z' }],
  ],
  // Mode: runs at once, or waits for you.
  'bolt-circle': [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['path', { d: 'M12.5 7L8.5 12.5h3l-.5 4.5 4-5.5h-3z' }],
  ],
  'check-circle': [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['path', { d: 'M8 12.5l2.8 2.8L16 9.5' }],
  ],
};

/** Every name `icon` draws, so a caller that names one from a table can be checked. */
export const ICON_NAMES = Object.keys(SHAPES);

/** @typedef {keyof typeof SHAPES} IconName */

/**
 * One glyph, sized by CSS (`.icon`), coloured by `currentColor`.
 * @param {IconName} name
 * @returns {SVGSVGElement}
 */
export function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({
    class: 'icon',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  })) {
    svg.setAttribute(k, v);
  }
  for (const [tag, attrs] of SHAPES[name] ?? []) {
    const shape = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.appendChild(shape);
  }
  return svg;
}
