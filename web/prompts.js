// @ts-check
// The rules the prompts screen goes by, apart from the sheet that draws them: when a prompt may
// be opened, whether there is anything to save, and what a row says about when an edit takes
// effect. `PromptsView` and `PromptDetail` in Prompts.swift, ported.
//
// What a prompt is, what it is called, and whether it is `live` all come down the socket from
// the relay (relay.js `Prompt`): nothing here knows there are two, or which.

/** @typedef {import('./relay.js').Prompt} Prompt */

/** What a row says when it cannot be opened, and why. */
export const LOCKED_NOTE = 'Fixed when a session starts — stop listening to change it.';

/**
 * Whether a prompt can be opened to edit. One that is not `live` is read when a session starts, so
 * while one is running an edit would promise what it cannot do: the row is closed, not explained
 * away after the fact.
 * @param {Pick<Prompt, 'live'>} prompt
 * @param {boolean} sessionLive a session is connecting or running
 */
export function promptEditable(prompt, sessionLive) {
  return prompt.live || !sessionLive;
}

/**
 * Whether the draft is different from what the relay holds. The relay keeps the text trimmed, so
 * a draft that differs only at its ends is not a change it would keep, and does not light Save.
 * @param {Pick<Prompt, 'text'>} prompt
 * @param {string} draft
 */
export function promptDirty(prompt, draft) {
  return draft.trim() !== prompt.text.trim();
}

/**
 * When an edit reaches a model. The voice style is re-read per sentence; Claude's is fixed when
 * its session is built.
 * @param {Pick<Prompt, 'live'>} prompt
 */
export function liveNote(prompt) {
  return prompt.live ? 'Takes effect on the next sentence.' : 'Fixed when a session starts — takes effect the next time you press listen.';
}

/**
 * The quiet line under a prompt in the list: when it takes effect, or why it cannot be opened now.
 * @param {Pick<Prompt, 'live'>} prompt
 * @param {boolean} sessionLive
 */
export function promptNote(prompt, sessionLive) {
  return promptEditable(prompt, sessionLive) ? liveNote(prompt) : LOCKED_NOTE;
}
