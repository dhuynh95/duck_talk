import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { fitWithin, isLongPaste, mintId, toBase64, toJpegBase64 } from '../web/attach.js';

// The arithmetic and the refusals of attaching a picture. Decoding and drawing need a browser and
// are checked in Chrome (a 4032x3024 photo with EXIF orientation 6, a 0-byte file, a text file
// named .jpg).

describe('fitWithin', () => {
  it('shrinks the long edge to 1568 and keeps the shape: a landscape photo', () => {
    assert.deepEqual(fitWithin(4032, 3024), { width: 1568, height: 1176 });
  });

  it('does the same for a portrait photo, edges swapped', () => {
    assert.deepEqual(fitWithin(3024, 4032), { width: 1176, height: 1568 });
  });

  it('leaves a picture that already fits as it is: never upscales', () => {
    assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
    assert.deepEqual(fitWithin(1, 1), { width: 1, height: 1 });
  });

  it('leaves a long edge of exactly the cap alone, and shrinks one pixel more', () => {
    assert.deepEqual(fitWithin(1568, 1000), { width: 1568, height: 1000 });
    assert.deepEqual(fitWithin(1000, 1568), { width: 1000, height: 1568 });
    assert.deepEqual(fitWithin(1568, 1568), { width: 1568, height: 1568 });
    assert.deepEqual(fitWithin(1569, 1000), { width: 1568, height: 999 });
  });

  it('lands the long edge on the cap exactly, whatever the shape', () => {
    for (const [w, h] of [[4032, 3024], [3000, 2999], [9999, 7], [1570, 1569], [5000, 5000]] as const) {
      const out = fitWithin(w, h);
      assert.equal(Math.max(out.width, out.height), 1568, `${w}x${h}`);
    }
  });

  it('takes another cap', () => {
    assert.deepEqual(fitWithin(400, 200, 100), { width: 100, height: 50 });
  });

  it('never makes a side nothing: a sliver stays a pixel wide', () => {
    assert.deepEqual(fitWithin(20000, 10), { width: 1568, height: 1 });
    assert.deepEqual(fitWithin(10, 20000), { width: 1, height: 1568 });
  });

  it('is never asked for a canvas of zero, even for a picture that says it has no size', () => {
    assert.deepEqual(fitWithin(0, 0), { width: 1, height: 1 });
    assert.deepEqual(fitWithin(0, 3000), { width: 1, height: 1568 });
    assert.deepEqual(fitWithin(Number.NaN, 600), { width: 1, height: 600 });
  });
});

describe('isLongPaste', () => {
  it('is false at 800 characters and true at 801', () => {
    assert.equal(isLongPaste('a'.repeat(800)), false);
    assert.equal(isLongPaste('a'.repeat(801)), true);
    assert.equal(isLongPaste(''), false);
  });

  it('counts what a person sees as a character, not what UTF-16 does: 800 emoji are 800', () => {
    assert.equal(isLongPaste('😀'.repeat(800)), false);
    assert.equal(isLongPaste('😀'.repeat(801)), true);
  });

  it('is true for a very long paste without walking all of it', () => {
    assert.equal(isLongPaste('x'.repeat(5_000_000)), true);
  });
});

describe('mintId', () => {
  it('is the moment, rounded', () => {
    assert.equal(mintId(0, 1000), 1000);
    assert.equal(mintId(0, 1000.6), 1001);
  });

  it('rises by one for each pick made in the same millisecond', () => {
    let last = 0;
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((last = mintId(last, 1000)));
    assert.deepEqual(ids, [1000, 1001, 1002, 1003, 1004]);
  });

  it('keeps rising when the clock goes backwards', () => {
    assert.equal(mintId(2000, 1500), 2001);
    let last = 2000;
    const ids: number[] = [];
    for (const now of [1900, 1800, 1800, 2500]) ids.push((last = mintId(last, now)));
    assert.deepEqual(ids, [2001, 2002, 2003, 2500]);
  });
});

describe('toBase64', () => {
  it('is what Buffer says, for bytes of every value', () => {
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
    assert.equal(toBase64(new Uint8Array()), '');
  });

  it('does not overflow the stack on a multi-megabyte picture', () => {
    const bytes = new Uint8Array(6_000_000).map((_, i) => (i * 31) % 256);
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
  });
});

describe('toJpegBase64: what it refuses before it decodes anything', () => {
  const g = globalThis as Record<string, unknown>;
  const had = 'createImageBitmap' in g;
  const was = g['createImageBitmap'];
  afterEach(() => {
    if (had) g['createImageBitmap'] = was;
    else delete g['createImageBitmap'];
  });

  it('an empty file is "That file is empty."', async () => {
    await assert.rejects(toJpegBase64(new Blob([], { type: 'image/jpeg' })), { message: 'That file is empty.' });
  });

  it('an absurdly large input (over 40 MB) is "That picture is too large."', async () => {
    g['createImageBitmap'] = () => assert.fail('decoded a picture that is over the limit');
    const blob = new Blob([new Uint8Array(40 * 1024 * 1024 + 1)], { type: 'image/jpeg' });
    await assert.rejects(toJpegBase64(blob), { message: 'That picture is too large.' });
  });

  it('a type that is plainly not a picture is not handed to the decoder', async () => {
    g['createImageBitmap'] = () => assert.fail('decoded a text file');
    const blob = new Blob(['hello'], { type: 'text/plain' });
    await assert.rejects(toJpegBase64(blob), { message: "That file isn't a picture this browser can read. Try a JPEG or PNG." });
  });

  it('a file the decoder cannot read (a text file named .jpg, a HEIC) says so in words', async () => {
    g['createImageBitmap'] = async () => {
      throw new Error('The source image could not be decoded.');
    };
    const blob = new Blob(['hello'], { type: 'image/jpeg' });
    await assert.rejects(toJpegBase64(blob), { message: "That file isn't a picture this browser can read. Try a JPEG or PNG." });
  });

  it('asks the decoder to turn the picture upright, as its EXIF says', async () => {
    let asked: unknown;
    g['createImageBitmap'] = async (_blob: Blob, options: unknown) => {
      asked = options;
      throw new Error('stop here');
    };
    await toJpegBase64(new Blob(['x'], { type: 'image/jpeg' })).catch(() => {});
    assert.deepEqual(asked, { imageOrientation: 'from-image' });
  });
});
