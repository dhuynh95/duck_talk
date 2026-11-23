// @ts-check
// What it takes to send a picture or a paste along with the next instruction: the arithmetic
// (how big, how long, what name) as plain functions, and the one thing only a browser can do —
// turn whatever file was chosen into the JPEG that travels. `Attachment.swift`, ported.
//
// A picture is one format, JPEG, with its long edge at most 1568 px: the model downsamples past
// that anyway, so resolution is the knob that matters and the codec is not. Quality 0.8 and the
// cap are the iPhone app's numbers.

/** The longest edge Claude's vision makes use of. */
const CAP = 1568;
const QUALITY = 0.8;
/** A paste longer than this many characters is not a sentence: it becomes a chip. */
const LONG_PASTE = 800;
/** Past this a file is not a photo someone took, and decoding it could stall the tab. */
const MAX_INPUT = 40 * 1024 * 1024;
/** The most bytes handed to `String.fromCharCode` at once: more can overflow the call stack. */
const CHUNK = 0x8000;

const EMPTY = 'That file is empty.';
const UNREADABLE = "That file isn't a picture this browser can read. Try a JPEG or PNG.";
const TOO_LARGE = 'That picture is too large.';

/**
 * The size a picture is drawn at to travel: its long edge no longer than `cap`, the shape kept,
 * never enlarged. A side is never less than a pixel, because a canvas of nothing cannot be drawn
 * on (a sliver 20000 wide and 10 tall comes out 1568 by 1).
 * @param {number} w
 * @param {number} h
 * @param {number} [cap]
 * @returns {{ width: number, height: number }}
 */
export function fitWithin(w, h, cap = CAP) {
  const width = Number.isFinite(w) && w > 0 ? w : 0;
  const height = Number.isFinite(h) && h > 0 ? h : 0;
  const long = Math.max(width, height);
  if (long <= cap) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  // The long edge is set to the cap itself rather than computed, so rounding cannot leave it at 1567.
  const scale = cap / long;
  return {
    width: width === long ? cap : Math.max(1, Math.round(width * scale)),
    height: height === long ? cap : Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Whether pasted text is too long to leave in the field. Characters as a person counts them
 * (an emoji is one), and it stops counting at the limit: a paste can be megabytes.
 * @param {string} text
 */
export function isLongPaste(text) {
  if (text.length <= LONG_PASTE) return false; // UTF-16 units are never fewer than characters
  let n = 0;
  for (const _ of text) if (++n > LONG_PASTE) return true;
  return false;
}

/**
 * A fresh id for something attached: the moment it was picked, nudged past the last one so two
 * picks in one millisecond — or a clock that stepped back — still give two names. The relay files
 * a picture under its id, so an id used twice would be one picture.
 * @param {number} last the id last given
 * @param {number} now milliseconds since the epoch
 */
export function mintId(last, now) {
  return Math.max(Math.round(now), last + 1);
}

/**
 * Base64 of some bytes, without spreading a whole picture into one call: `btoa` wants a string
 * and `String.fromCharCode(...bytes)` on a few megabytes overflows the stack.
 * @param {Uint8Array} bytes
 */
export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

/**
 * A chosen file as the JPEG that travels, in base64: decoded upright (a phone photo says which way
 * is up in its EXIF, which a canvas alone would ignore), drawn no larger than 1568 px on its long
 * edge onto white (a JPEG has no transparency, and a transparent PNG would go black), and
 * encoded at quality 0.8.
 *
 * Rejects with an Error whose message is for the person to read — an empty file, a file that is
 * not a picture this browser can decode (a text file named .jpg, a HEIC the browser has no codec
 * for), one too large to be worth decoding, one that decodes but cannot be drawn or encoded. What
 * can be known from the size and type is known before anything is decoded. The browser's own
 * sentence ("The source image could not be decoded.") is never what comes out.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function toJpegBase64(blob) {
  if (blob.size === 0) throw new Error(EMPTY);
  if (blob.size > MAX_INPUT) throw new Error(TOO_LARGE);
  if (blob.type && !blob.type.startsWith('image/')) throw new Error(UNREADABLE);

  /** @type {ImageBitmap} */
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // A browser that does not know the option rejects for it, which looks like a file that cannot
    // be read. Asking once more without it tells them apart, and a picture that is a little
    // sideways is better than none.
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      throw new Error(UNREADABLE);
    }
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error(UNREADABLE);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!(jpeg instanceof Blob)) throw new Error(UNREADABLE);
    return toBase64(new Uint8Array(await jpeg.arrayBuffer()));
  } catch {
    // Drawing and encoding fail with the browser's own wording (a detached image, a canvas over
    // its size limit, a tainted canvas): nothing a person could act on.
    throw new Error(UNREADABLE);
  } finally {
    bitmap.close();
  }
}
