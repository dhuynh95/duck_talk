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
//
// Under each line are its verbs (line-actions.js), and above one of yours what it was given with
// (pieces.js): pictures, fetched by id when their square scrolls into view, and pasted texts.
// Both belong to a row and go with it: a row that is removed lets go of its clips and pictures.

import { h } from '../dom.js';
import { icon } from './icons.js';
import { lineActions, streamingId } from './line-actions.js';
import { piecesRow } from './pieces.js';

/** @typedef {import('../transcript.js').Line} Line */
/** @typedef {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} Store */
/**
 * What the lines need from the page beyond the store: what the verbs do, and how a stored
 * picture is fetched. Left out, the verbs do nothing and pictures are placeholders.
 * @typedef {import('./line-actions.js').LineHandlers & { image: (id: number) => Promise<Blob | null> }} LineContext
 */

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

/**
 * One line on screen. `pieces` and `verbs` are only on the kinds of line that have them, and
 * `verbsFor` is what the verbs were last drawn for, so a row that has not moved is not asked again.
 * @typedef {{
 *   el: HTMLElement,
 *   text: HTMLElement,
 *   line: Line,
 *   pieces: import('./pieces.js').Pieces | null,
 *   verbs: import('./line-actions.js').LineActions | null,
 *   verbsFor: { line: Line, streaming: boolean } | null,
 * }} Row
 */

/**
 * @param {Line} line
 * @param {{ source: import('./pieces.js').PieceSource, handlers: import('./line-actions.js').LineHandlers }} parts
 * @returns {Row}
 */
function makeRow(line, { source, handlers }) {
  if (line.kind === 'user') {
    const text = h('div', { class: 'bubble' }, line.text);
    const pieces = piecesRow(source);
    pieces.update(line.given);
    const verbs = lineActions(handlers);
    const el = h('div', { class: 'row user' }, h('div', { class: 'stack' }, pieces.el, text, verbs.el));
    return { el, text, line, pieces, verbs, verbsFor: null };
  }
  if (line.kind === 'model') {
    const text = h('div', { class: 'model-text' }, line.text);
    const verbs = lineActions(handlers);
    return { el: h('div', { class: 'row model' }, text, verbs.el), text, line, pieces: null, verbs, verbsFor: null };
  }
  const text = h('span', { class: 'tools-label' }, toolLabel(line.tools));
  const el = h('div', { class: line.running ? 'row tools running' : 'row tools' }, h('span', { class: 'tools-mark', 'aria-hidden': 'true' }), text);
  return { el, text, line, pieces: null, verbs: null, verbsFor: null };
}

/** Bring a row up to date with its line, touching only what moved. @param {Row} row @param {Line} line */
function updateRow(row, line) {
  const was = row.line;
  row.line = line;
  if (line.kind === 'tools') {
    if (line.tools !== was.tools) row.text.textContent = toolLabel(line.tools);
    row.el.classList.toggle('running', line.running);
  } else {
    if (line.text !== was.text) row.text.textContent = line.text;
    if (line.given !== was.given) row.pieces?.update(line.given);
  }
}

/** Take a row off the page, and let go of what it holds: playing clips, picture URLs. @param {Row} row */
function removeRow(row) {
  row.pieces?.destroy();
  row.verbs?.destroy();
  row.el.remove();
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
 * @param {Partial<LineContext>} [context] what the verbs do, and how a stored picture is fetched
 * @returns {{ el: HTMLElement, follow: () => void }} `follow` keeps the end in view if it was in view, for a caller that just changed the room the conversation has
 */
export function transcriptView(store, context = {}) {
  /** @type {LineContext} */
  const ctx = {
    edit: () => {},
    fix: () => {},
    fork: () => {},
    notify: () => {},
    clip: async () => null,
    image: async () => null,
    ...context,
  };
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

  // A picture is fetched when its square comes near the screen, once: one observer for them all.
  /** @type {IntersectionObserver | null} */
  let observer = null;
  /** @type {Map<Element, () => void>} */
  const waiting = new Map();
  /** @type {import('./pieces.js').PieceSource} */
  const source = {
    image: ctx.image,
    watch(target, fn) {
      if (typeof IntersectionObserver !== 'function') {
        fn();
        return () => {};
      }
      observer ??= new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const run = waiting.get(entry.target);
            if (!entry.isIntersecting || !run) continue;
            waiting.delete(entry.target);
            observer?.unobserve(entry.target);
            run();
          }
        },
        { root: scroller, rootMargin: '300px 0px' },
      );
      waiting.set(target, fn);
      observer.observe(target);
      return () => {
        waiting.delete(target);
        observer?.unobserve(target);
      };
    },
  };

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
   * @param {number | null} streaming the line still being written, which has no verbs yet
   */
  function drawLines(lines, streaming) {
    let yours = false;
    /** @type {Set<number>} */
    const seen = new Set();
    lines.forEach((line, i) => {
      let row = rows.get(line.id);
      if (row && row.line.kind !== line.kind) {
        removeRow(row);
        row = undefined;
      }
      if (!row) {
        row = makeRow(line, { source, handlers: ctx });
        rows.set(line.id, row);
        if (line.kind === 'user') yours = true;
      } else if (row.line !== line) {
        updateRow(row, line);
      }
      const writing = line.id === streaming;
      if (row.verbs && (row.verbsFor?.line !== line || row.verbsFor.streaming !== writing)) {
        row.verbs.update(line, writing);
        row.verbsFor = { line, streaming: writing };
      }
      seen.add(line.id);
      const here = list.children[i];
      if (here !== row.el) list.insertBefore(row.el, here ?? null);
    });
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        removeRow(row);
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
    // A turn ending changes which line is still being written without changing any line.
    const yours = (changed('lines') || changed('inFlight')) && drawLines(lines, streamingId(lines, !!state['inFlight']));

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
