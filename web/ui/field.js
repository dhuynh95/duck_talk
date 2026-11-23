// @ts-check
// What the two text fields on the screen — the message you type, and the instruction held for
// review — do the same way: grow with what is typed, and send on Enter where a keyboard is.

/** The field grows with what is typed up to this, then scrolls. */
const MAX_FIELD = 168;

/**
 * Fit `input` to its text, up to a limit. A border is part of a border-box height and not of
 * `scrollHeight`, so a field with one is made that much taller, or it would scroll by two pixels.
 * @param {HTMLTextAreaElement} input
 */
export function autosize(input) {
  input.style.height = 'auto';
  const border = input.offsetHeight - input.clientHeight;
  input.style.height = `${Math.min(input.scrollHeight + border, MAX_FIELD)}px`;
  input.classList.toggle('scrolls', input.scrollHeight + border > MAX_FIELD);
}

/**
 * Keep `input` fitted to its text when its width changes, not only when its text does: a phone
 * turned on its side, a window dragged, a drawer opening beside it all re-wrap a long draft, and
 * the height it had was for the old lines. A change of height alone (what `autosize` itself
 * makes) is not a reason to measure again. For the life of the field.
 * @param {HTMLTextAreaElement} input
 */
export function autosizeOnResize(input) {
  if (typeof ResizeObserver !== 'function') return;
  let width = input.clientWidth;
  new ResizeObserver(() => {
    if (input.clientWidth === width) return;
    width = input.clientWidth;
    if (width > 0) autosize(input); // a field that is not on screen has no lines to count
  }).observe(input);
}

/**
 * Whether a pointer that can aim is beside the screen: a keyboard-and-mouse machine, not a phone. On
 * a touch screen focus is what raises the on-screen keyboard, so nothing the page does by itself
 * (rather than for a tap) moves focus into a field there.
 */
export function finePointer() {
  return typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
}

/**
 * Whether this keydown is Enter meaning "send". A keyboard with a fine pointer beside it sends on
 * Enter, and Shift+Enter breaks the line; on a touch screen Enter is the only way to break one,
 * so it does that and the button sends. Enter that is choosing a character in an input method is
 * not a send: `isComposing` says so, except in Safari, whose keydown for that Enter arrives after
 * the composition has ended, and says only `keyCode` 229.
 * @param {KeyboardEvent} event
 */
export function enterSends(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return false;
  return finePointer();
}
