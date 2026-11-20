// @ts-check
// The few things one screen asks of another that is built elsewhere. A line of the conversation
// can ask for the corrections editor to open on it, and the editor is not this screen's to know
// about, so the ask is a call on this object and whoever builds the editor puts itself here:
//
//     actions.openCorrections = (seed) => correctionsSheet(seed);
//
// Until then asking does nothing, which is a screen that is missing a feature, not one that is
// broken. Importing this touches no browser global.

/**
 * What the editor opens on: the line as it was heard (`heard`), as it should have been (`meant`,
 * the same until someone edits it), and the audio it was heard from.
 * @typedef {{ at: number, heard: string, meant: string, clip?: number }} CorrectionSeed
 */

export const actions = {
  /** @type {(seed: CorrectionSeed) => void} */
  openCorrections: () => {},
};
