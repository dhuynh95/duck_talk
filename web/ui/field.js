// @ts-check
// What the two text fields on the screen — the message you type, and the instruction held for
// review — do the same way: grow with what is typed, and send on Enter where a keyboard is.

/** The field grows with what is typed up to this, then scrolls. */
const MAX_FIELD = 168;

/** Fit `input` to its text, up to a limit. @param {HTMLTextAreaElement} input */
export function autosize(input) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, MAX_FIELD)}px`;
  input.classList.toggle('scrolls', input.scrollHeight > MAX_FIELD);
}

/**
 * Whether this keydown is Enter meaning "send". A keyboard with a fine pointer beside it sends on
 * Enter, and Shift+Enter breaks the line; on a touch screen Enter is the only way to break one,
 * so it does that and the button sends. Enter that is choosing a character in an input method
 * (`isComposing`) is not a send.
 * @param {KeyboardEvent} event
 */
export function enterSends(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return false;
  return typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
}
