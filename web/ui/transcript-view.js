// @ts-check
// The conversation on screen: flat, edge to edge, scrolling under the header and the
// composer, which float over it. What you said wears a bubble; what Claude said does not —
// that alternation is how a long transcript is scanned without reading it. The tools Claude
// used in between are one quiet row ("Read ×3, Bash").
//
// Drawn from the store, and kept, not redrawn: each line has one element for its life,
// found by `line.id`, and an update changes only what changed in it. The store is written
// some 25 times a second while the microphone is open (the level) and on every streamed
// word of a reply, so a redraw of every line on every write is what this is built not to do;
// a write that touches none of what is drawn here is a few comparisons.
//
// It follows the end of the conversation while you are at the end, and lets you read while
// you are not: scrolled up more than a little, new words arrive without moving you, and a
// button offers the way back down.

import { h } from '../dom.js';
import { icon } from './icons.js';

/** @typedef {import('../transcript.js').Line} Line */
/** @typedef {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} Store */

const LOGO = '/logo.svg';
/** Within this of the end counts as at the end: a finger never lands on the exact pixel. */
const NEAR_END = 80;

/**
 * The tools of a run, as one label: repeats counted, in the order first used ("Read ×3, Bash").
 * @param {string[]} tools
 */
export function toolLabel(tools) {
  /** @type {Map<string, number>} */
  const counted = new Map();
  for (const tool of tools) counted.set(tool, (counted.get(tool) ?? 0) + 1);
  return [...counted].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
}

/**
 * Claude is at it in this chat: a turn this screen sent is in flight, the relay says the
 * chat is working, or the last thing on screen is a tool still running.
 * @param {Record<string, any>} state
 */
export function isWorking(state) {
  if (state['inFlight'] || state['working']) return true;
  /** @type {Line[]} */
  const lines = state['lines'] ?? [];
  const last = lines.at(-1);
  return last?.kind === 'tools' && last.running;
}

/** @typedef {{ el: HTMLElement, text: HTMLElement, line: Line }} Row */

/** @param {Line} line @returns {Row} */
function makeRow(line) {
  if (line.kind === 'user') {
    const text = h('div', { class: 'bubble' }, line.text);
    return { el: h('div', { class: 'row user' }, text), text, line };
  }
  if (line.kind === 'model') {
    const text = h('div', { class: 'model-text' }, line.text);
    return { el: h('div', { class: 'row model' }, text), text, line };
  }
  const text = h('span', { class: 'tools-label' }, toolLabel(line.tools));
  const el = h('div', { class: line.running ? 'row tools running' : 'row tools' }, h('span', { class: 'tools-mark', 'aria-hidden': 'true' }), text);
  return { el, text, line };
}

/** Bring a row up to date with its line, touching only what moved. @param {Row} row @param {Line} line */
function updateRow(row, line) {
  const was = row.line;
  row.line = line;
  if (line.kind === 'tools') {
    if (line.tools !== was.tools) row.text.textContent = toolLabel(line.tools);
    row.el.classList.toggle('running', line.running);
  } else if (line.text !== was.text) {
    row.text.textContent = line.text;
  }
}

/** Nothing said yet: the mark and the name, and the one piece of advice worth giving. */
function blank() {
  return h(
    'div',
    { class: 'blank' },
    h('img', { class: 'blank-logo', src: LOGO, alt: '' }),
    h('p', { class: 'blank-name' }, 'Duck Talk'),
    h('p', { class: 'blank-by' }, 'by ', h('a', { href: 'https://reduck.ai', target: '_blank', rel: 'noopener noreferrer' }, 'Reduck')),
    h('p', { class: 'blank-hint' }, 'Tap the microphone to talk, or type. Headphones keep Claude from hearing itself.'),
  );
}

/**
 * @param {Store} store
 * @returns {{ el: HTMLElement, follow: () => void }} `follow` keeps the end in view if it was in view, for a caller that just changed the room the conversation has
 */
export function transcriptView(store) {
  const empty = blank();
  const list = h('div', { class: 'lines' });
  const utterance = h('div', { class: 'bubble' });
  const utteranceRow = h('div', { class: 'row user said', hidden: true }, utterance);
  const workingRow = h(
    'div',
    { class: 'row working', role: 'status', hidden: true },
    h('span', { class: 'working-mark', 'aria-hidden': 'true' }),
    'Working',
    h('span', { class: 'working-dots', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
  );
  const notice = h('div', { class: 'row notice', role: 'status', hidden: true });
  const error = h('div', { class: 'row error', role: 'alert', hidden: true });

  const column = h('div', { class: 'column' }, empty, list, utteranceRow, workingRow, notice, error);
  const scroller = h('main', { class: 'transcript', 'aria-label': 'Conversation' }, column);
  const jump = h('button', { class: 'jump floating', type: 'button', 'aria-label': 'Jump to latest', hidden: true }, icon('down'));
  const el = h('div', { class: 'conversation' }, scroller, jump);

  /** @type {Map<number, Row>} */
  const rows = new Map();
  /** At the end, as of the last scroll: what decides whether new content moves the view. */
  let stuck = true;

  const atEnd = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= NEAR_END;
  const toEnd = (smooth = false) => {
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' });
    stuck = true;
    jump.hidden = true;
  };
  const follow = () => {
    if (stuck) toEnd();
  };

  scroller.addEventListener('scroll', () => {
    stuck = atEnd();
    jump.hidden = stuck;
  }, { passive: true });
  jump.addEventListener('click', () => toEnd(true));
  // The room changes without a scroll: the window, the keyboard, the composer growing.
  if (typeof ResizeObserver === 'function') new ResizeObserver(follow).observe(scroller);

  /**
   * Lines kept by id, in order. True if one of yours was added: something you just said is
   * where the view goes, wherever you had scrolled to.
   * @param {Line[]} lines
   */
  function drawLines(lines) {
    let yours = false;
    /** @type {Set<number>} */
    const seen = new Set();
    lines.forEach((line, i) => {
      let row = rows.get(line.id);
      if (row && row.line.kind !== line.kind) {
        row.el.remove();
        row = undefined;
      }
      if (!row) {
        row = makeRow(line);
        rows.set(line.id, row);
        if (line.kind === 'user') yours = true;
      } else if (row.line !== line) {
        updateRow(row, line);
      }
      seen.add(line.id);
      const here = list.children[i];
      if (here !== row.el) list.insertBefore(row.el, here ?? null);
    });
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.el.remove();
        rows.delete(id);
      }
    }
    return yours;
  }

  /** @type {Record<string, any>} */
  let drawn = {};
  /** @param {Record<string, any>} state */
  function draw(state) {
    const changed = (/** @type {string} */ k) => state[k] !== drawn[k];
    if (!['lines', 'utterance', 'inFlight', 'working', 'notice', 'error'].some(changed)) return;

    /** @type {Line[]} */
    const lines = state['lines'] ?? [];
    const yours = changed('lines') && drawLines(lines);

    const said = state['utterance'];
    utteranceRow.hidden = !said;
    if (said && utterance.textContent !== said) utterance.textContent = said;

    const busy = isWorking(state);
    workingRow.hidden = !busy;
    notice.hidden = !state['notice'];
    notice.textContent = state['notice'] ?? '';
    error.hidden = !state['error'];
    error.textContent = state['error'] ?? '';
    empty.hidden = lines.length > 0 || !!said || busy;

    const speaking = !!said && !drawn['utterance']; // you started a sentence: that is where to look
    drawn = state;
    if (stuck || yours || speaking) toEnd();
    else jump.hidden = false;
  }

  draw(store.get());
  store.subscribe(draw);
  return { el, follow };
}
