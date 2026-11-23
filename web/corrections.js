// @ts-check
// The rules the corrections editor goes by, apart from the sheet that draws them: what a
// correction that does not exist yet looks like, and when one is ready to be saved.
// `CorrectionsView` and `CorrectionDetail` in Corrections.swift, ported.

/** @typedef {import('./relay.js').Correction} Correction */

/**
 * A correction that does not exist yet. `at` is its id from the moment it is made, so saving it
 * once creates it and saving it again edits the same row. One made by hand has no clip: nothing
 * was heard.
 * @param {number} now milliseconds, as `Date.now()`
 * @returns {Correction}
 */
export function blankCorrection(now) {
  return { at: now, heard: '', meant: '' };
}

/**
 * Whether it says something on both sides. The relay trims what it is given and ignores a pair
 * with an empty side, so a Save that was allowed with one would do nothing and say nothing.
 * @param {Pick<Correction, 'heard' | 'meant'>} c
 */
export function isCorrectionComplete(c) {
  return c.heard.trim() !== '' && c.meant.trim() !== '';
}
