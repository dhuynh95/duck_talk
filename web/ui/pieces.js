// @ts-check
// What a line of yours was given with, drawn above the words: pictures as small squares and pasted
// texts as chips. `Piece` and `AttachThumb` in Attachment.swift, ported.
//
// A picture is one of two things and neither is a fallback for the other. One just attached on
// this page is in hand (`data`, base64 JPEG), so it is drawn at once and nobody is asked. One read
// back out of a stored chat has only an id, because sending a month of pictures to draw a row of
// squares is the one thing worth not doing: it is fetched when its square scrolls into view, once,
// and its object URL is let go of when the line goes. A paste is the text itself, whole, so it is
// always in hand; the chip shows its opening words and a press opens it in place.
//
// Nothing a piece holds is ever markup: text goes in as text, `alt` text is empty (the button
// around a picture says what it is), and the one URL made from data — `data:image/jpeg;base64,…`
// for a picture in hand — is built only from base64 characters.

import { h } from '../dom.js';
import { icon } from './icons.js';
import { openSheet } from './sheet.js';

/** @typedef {import('../transcript.js').Piece} Piece */
/** @typedef {{ el: HTMLElement, update: (given: Piece[]) => void, destroy: () => void }} Pieces */
/**
 * What drawing pieces needs from the page: how to get a stored picture, and when a square has come
 * into view (`watch` calls `fn` once, at that moment, and returns how to stop waiting).
 * @typedef {{
 *   image: (id: number) => Promise<Blob | null>,
 *   watch: (el: Element, fn: () => void) => () => void,
 * }} PieceSource
 */

/** How much of a paste the chip says. */
const LABEL = 40;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The opening words of a pasted text, for its chip: lines run together, trimmed, and cut at 40
 * characters (never in the middle of one) with a "…" if it was cut.
 * @param {string} text
 */
export function pasteLabel(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return 'Pasted text';
  const chars = [...flat];
  return chars.length > LABEL ? `${chars.slice(0, LABEL).join('')}…` : flat;
}

/** A square of a picture, full size, in a sheet. @param {string} url @param {HTMLElement | null} opener */
function preview(url, opener) {
  const img = h('img', { class: 'preview-img', alt: '' });
  img.src = url; // ours: an object URL or a data URL built below, never data from a line
  openSheet({ title: 'Picture', content: h('div', { class: 'preview' }, img), opener });
}

/**
 * One picture, as a square.
 * @param {Extract<Piece, { type: 'image' }>} piece
 * @param {PieceSource} source
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
function thumb(piece, source) {
  const img = h('img', { class: 'thumb-img', alt: '', hidden: true });
  const mark = h('span', { class: 'thumb-mark' }, icon('photo'));
  const el = h('button', { class: 'thumb', type: 'button', 'aria-label': 'View picture', dataset: { state: 'loading' } }, img, mark);
  /** @type {string | null} object URL we made, to let go of */
  let objectUrl = null;
  /** @type {string | null} what the square shows, once it shows one */
  let shown = null;
  let destroyed = false;
  let stopWaiting = () => {};

  /** @param {string | null} url */
  const show = (url) => {
    if (url === null) {
      el.dataset['state'] = 'missing'; // quiet: nothing to show and nothing worth explaining in 62 pixels
      el.disabled = true;
      return;
    }
    shown = url;
    img.src = url;
    img.hidden = false;
    mark.hidden = true;
    el.dataset['state'] = 'ready';
  };
  img.addEventListener('error', () => {
    img.hidden = true;
    mark.hidden = false;
    shown = null;
    show(null);
  });
  el.addEventListener('click', () => {
    if (shown) preview(shown, el);
  });

  if (piece.data !== undefined) {
    show(BASE64.test(piece.data) ? `data:image/jpeg;base64,${piece.data}` : null);
  } else {
    stopWaiting = source.watch(el, () => {
      void source.image(piece.id).then((blob) => {
        if (destroyed) return; // the line went while the picture was on its way: nothing to make, nothing to leak
        if (!blob) {
          show(null);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        show(objectUrl);
      });
    });
  }

  return {
    el,
    destroy() {
      destroyed = true;
      stopWaiting();
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    },
  };
}

/**
 * One pasted text, as a chip that opens in place to the whole of it.
 * @param {Extract<Piece, { type: 'text' }>} piece
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
function paste(piece) {
  const chip = h(
    'button',
    { class: 'paste-chip', type: 'button', 'aria-expanded': 'false', 'aria-label': 'Pasted text' },
    h('span', { class: 'paste-tag', 'aria-hidden': 'true' }, 'TXT'),
    h('span', { class: 'paste-label' }, pasteLabel(piece.text)),
  );
  const el = h('div', { class: 'paste' }, chip);
  /** @type {HTMLElement | null} */
  let full = null;
  chip.addEventListener('click', () => {
    if (full) {
      full.remove();
      full = null;
    } else {
      full = h('pre', { class: 'paste-full' }, piece.text);
      el.append(full);
    }
    chip.setAttribute('aria-expanded', String(full !== null));
    el.classList.toggle('open', full !== null);
  });
  return { el, destroy() {} };
}

/** What makes two pieces the same piece, so an update leaves an unchanged one alone. @param {Piece} p */
function keyOf(p) {
  if (p.type === 'text') return `text:${p.text}`;
  return p.data !== undefined ? `data:${p.id}:${p.data.length}` : `id:${p.id}`;
}

/**
 * The row of pieces a line was given with, kept by position: an update replaces only a piece that
 * is no longer the one in its place. Hidden while there are none.
 * @param {PieceSource} source
 * @returns {Pieces}
 */
export function piecesRow(source) {
  const el = h('div', { class: 'given', hidden: true });
  /** @type {{ key: string, el: HTMLElement, destroy: () => void }[]} */
  let drawn = [];

  return {
    el,
    update(given) {
      given.forEach((p, i) => {
        const key = keyOf(p);
        if (drawn[i]?.key === key) return;
        drawn[i]?.destroy();
        const made = p.type === 'image' ? thumb(p, source) : paste(p);
        const piece = { key, ...made };
        if (drawn[i]) drawn[i].el.replaceWith(made.el);
        else el.append(made.el);
        drawn[i] = piece;
      });
      for (const gone of drawn.splice(given.length)) {
        gone.destroy();
        gone.el.remove();
      }
      el.hidden = drawn.length === 0;
    },
    destroy() {
      for (const p of drawn) p.destroy();
      drawn = [];
    },
  };
}
