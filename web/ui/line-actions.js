// @ts-check
// The things that can be done to a line, as a row of small glyphs under it: edit what you said,
// fix what was heard, fork the conversation from what Claude said, copy, and — for a line that
// was spoken — a chip that plays it back. Defined once in `verbsOf`, which is the rules: every
// verb needs the data it works from (`uuid` is the proof a message is in the store, which is the
// only place a branch can cut; `clip` the proof it was heard), and none is offered on a line
// still being written, whose words, place and ending are not settled. The glyphs are tertiary,
// because they are always there and must never compete with the words, and they are named only
// by their label: a word beside each would cost its width on every line forever.
//
// A row is kept, not redrawn: `update` adds, removes and orders the glyphs that changed, and a
// clip chip that is playing is not touched by an update to something else about its line.

import { h } from '../dom.js';
import { clipChip } from './clip-chip.js';
import { icon } from './icons.js';

/** @typedef {import('../transcript.js').Line} Line */
/** @typedef {'clip' | 'fix' | 'edit' | 'fork' | 'copy'} VerbId */
/**
 * What a verb does, from the page's side: the glyphs that need more than the line to act.
 * @typedef {{
 *   edit: (line: Line) => void,
 *   fix: (line: Line) => void,
 *   fork: (line: Line) => void,
 *   notify: (message: string) => void,
 *   clip: (id: number) => Promise<Blob | null>,
 * }} LineHandlers
 * `clip` resolves null when the relay says it has no such clip, and rejects (with a sentence to read) when it could not be asked: the chip retries.
 */
/** @typedef {{ el: HTMLElement, update: (line: Line, streaming: boolean) => void, destroy: () => void }} LineActions */

/** How long the copy glyph says it worked, in ms. */
const COPIED_FOR = 1400;

/** The glyph verbs: what each says to someone who asked, and how it looks. @type {Record<'fix' | 'edit' | 'fork' | 'copy', { title: string, icon: import('./icons.js').IconName }>} */
const GLYPHS = {
  fix: { title: 'Fix what was heard', icon: 'waveform' },
  edit: { title: 'Edit', icon: 'pencil' },
  fork: { title: 'Fork from here', icon: 'branch' },
  copy: { title: 'Copy', icon: 'copy' },
};

/**
 * The verbs a line has, in the order they are drawn. A line that is still streaming has none.
 * @param {Pick<Line, 'kind' | 'text' | 'uuid' | 'clip'>} line
 * @param {boolean} streaming
 * @returns {VerbId[]}
 */
export function verbsOf(line, streaming) {
  if (streaming || line.kind === 'tools') return [];
  /** @type {VerbId[]} */
  const out = [];
  if (line.kind === 'user') {
    // Only a line that was heard has audio. Direct mode runs what it heard before you can stop
    // it, which makes this the only door to a correction that Review was not on for.
    if (line.clip !== undefined) out.push('clip', 'fix');
    if (line.uuid !== undefined) out.push('edit');
  } else if (line.uuid !== undefined) {
    out.push('fork');
  }
  if (line.text) out.push('copy');
  return out;
}

/**
 * The line that is still being written: the last one, when it is Claude's and a turn is in
 * flight. Its words keep arriving and its place in the store is not known until the turn ends.
 * @param {Pick<Line, 'id' | 'kind'>[]} lines
 * @param {boolean} inFlight
 * @returns {number | null} its `id`
 */
export function streamingId(lines, inFlight) {
  const last = lines.at(-1);
  return inFlight && last?.kind === 'model' ? last.id : null;
}

/**
 * The verbs under one line.
 * @param {LineHandlers} handlers
 * @returns {LineActions}
 */
export function lineActions(handlers) {
  // Where "Copied" is said to a screen reader: a status that is always in the page, last in the
  // row so the glyphs keep their places among its children.
  const status = h('span', { class: 'sr', role: 'status' });
  const el = h('div', { class: 'verbs', role: 'group', 'aria-label': 'Message actions', hidden: true }, status);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let statusTimer;
  /** @type {Map<VerbId, HTMLElement>} */
  const items = new Map();
  /** @type {import('./clip-chip.js').ClipChip | null} */
  let chip = null;
  /** @type {number | undefined} the clip the chip was made for */
  let chipFor;
  /** @type {Line | null} the line as last given: what a press acts on, read when it is pressed */
  let line = null;

  // The glyph turns into a check for a moment, which a screen reader cannot see, and its name stays
  // "Copy": the news is said in the status, which is emptied again so the next copy is a change.
  /** @param {HTMLButtonElement} button */
  const copied = (button) => {
    button.replaceChildren(icon('check'));
    status.textContent = 'Copied';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      button.replaceChildren(icon(GLYPHS.copy.icon));
      status.textContent = '';
    }, COPIED_FOR);
  };

  /** @param {HTMLButtonElement} button */
  const copy = async (button) => {
    const text = line?.text ?? '';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      handlers.notify("Couldn't copy");
      return;
    }
    copied(button);
  };

  /** @param {'fix' | 'edit' | 'fork' | 'copy'} id */
  const glyph = (id) => {
    const { title, icon: name } = GLYPHS[id];
    const button = h('button', { class: 'verb', type: 'button', 'aria-label': title, title, dataset: { verb: id } }, icon(name));
    button.addEventListener('click', () => {
      if (!line) return;
      if (id === 'copy') void copy(button);
      else handlers[id](line);
    });
    return button;
  };

  return {
    el,
    update(next, streaming) {
      line = next;
      const wanted = verbsOf(next, streaming);

      // The chip belongs to one clip: a line whose clip changed gets a new one.
      if (chip && (!wanted.includes('clip') || chipFor !== next.clip)) {
        chip.destroy();
        chip.el.remove();
        items.delete('clip');
        chip = null;
      }
      for (const id of [...items.keys()]) {
        if (!wanted.includes(id)) {
          items.get(id)?.remove();
          items.delete(id);
        }
      }
      wanted.forEach((id, i) => {
        let item = items.get(id);
        if (!item) {
          if (id === 'clip' && next.clip !== undefined) {
            chip = clipChip({ id: next.clip, load: handlers.clip });
            chipFor = next.clip;
            item = chip.el;
          } else if (id !== 'clip') {
            item = glyph(id);
          }
          if (!item) return;
          items.set(id, item);
        }
        if (el.children[i] !== item) el.insertBefore(item, el.children[i] ?? null);
      });
      el.hidden = wanted.length === 0;
    },
    destroy() {
      chip?.destroy();
      chip = null;
    },
  };
}
