import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Meter, Resampler, floatToInt16, int16ToFloat32 } from '../web/pcm.js';

function sine(freq: number, rate: number, samples: number, amp = 0.5): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** Feeds `input` through `r` in pieces of `chunk` samples and joins what comes out. */
function run(r: Resampler, input: Float32Array, chunk = input.length): Int16Array {
  const parts: Int16Array[] = [];
  for (let at = 0; at < input.length; at += chunk) parts.push(r.process(input.subarray(at, at + chunk)));
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function rms(samples: Int16Array, from = 0): number {
  let sum = 0;
  for (let i = from; i < samples.length; i++) sum += (samples[i] as number) ** 2;
  return Math.sqrt(sum / (samples.length - from));
}

function peak(samples: Int16Array, from = 0): number {
  let p = 0;
  for (let i = from; i < samples.length; i++) p = Math.max(p, Math.abs(samples[i] as number));
  return p;
}

/** Upward zero crossings, which is one per cycle. */
function cycles(samples: Int16Array, from = 0): number {
  let n = 0;
  for (let i = from + 1; i < samples.length; i++) {
    if ((samples[i - 1] as number) < 0 && (samples[i] as number) >= 0) n++;
  }
  return n;
}

// Skipped when measuring: the filter starts from silence, so the first few milliseconds of
// output are the filter filling up and not the signal.
const SETTLE = 200;

describe('Resampler', () => {
  it('keeps a 440 Hz tone at 440 Hz and its amplitude going from 48 kHz to 16 kHz', () => {
    const out = run(new Resampler(48000), sine(440, 48000, 48000));
    const seconds = (out.length - SETTLE) / 16000;
    assert.ok(Math.abs(cycles(out, SETTLE) / seconds - 440) < 5, `${cycles(out, SETTLE) / seconds} Hz`);
    const expected = 0.5 * 32767;
    assert.ok(Math.abs(peak(out, SETTLE) - expected) < 0.1 * expected, `peak ${peak(out, SETTLE)}`);
  });

  it('works from 44.1 kHz, where the read position is a fraction that moves', () => {
    const out = run(new Resampler(44100), sine(440, 44100, 44100));
    const seconds = (out.length - SETTLE) / 16000;
    assert.ok(Math.abs(cycles(out, SETTLE) / seconds - 440) < 5, `${cycles(out, SETTLE) / seconds} Hz`);
    const expected = 0.5 * 32767;
    assert.ok(Math.abs(peak(out, SETTLE) - expected) < 0.1 * expected, `peak ${peak(out, SETTLE)}`);
  });

  it('passes a steady level at the same level, whatever the phase of the read position', () => {
    for (const rate of [48000, 44100]) {
      const out = run(new Resampler(rate), new Float32Array(rate / 4).fill(0.5));
      const level = 0.5 * 32767;
      for (let i = SETTLE; i < out.length; i++) {
        assert.ok(Math.abs((out[i] as number) - level) < 0.01 * level, `${rate} Hz, sample ${i}: ${out[i]}`);
      }
    }
  });

  it('does not let a tone above the output Nyquist fold back into the band', () => {
    // 12 kHz sampled at 16 kHz would land at 4 kHz at full strength, and 11 kHz at 5 kHz; the
    // low-pass has to take them out first.
    for (const freq of [9000, 11000, 12000]) {
      const input = sine(freq, 48000, 24000);
      let inRms = 0;
      for (const v of input) inRms += v * v;
      inRms = Math.sqrt(inRms / input.length) * 32767;
      const out = run(new Resampler(48000), input);
      assert.ok(rms(out, SETTLE) < 0.1 * inRms, `${freq} Hz: rms ${rms(out, SETTLE)} against ${inRms} in`);
    }
  });

  it('produces the same output however the input is cut into chunks', () => {
    for (const rate of [48000, 44100]) {
      const input = sine(440, rate, rate / 4);
      const whole = run(new Resampler(rate), input);
      assert.equal(whole.length, Math.ceil((input.length * 16000) / rate));
      for (const chunk of [1, 480, 4096]) {
        const cut = run(new Resampler(rate), input, chunk);
        assert.ok(Math.abs(cut.length - whole.length) <= 1, `${rate} Hz in ${chunk}s: ${cut.length} against ${whole.length}`);
        for (let i = 0; i < whole.length; i++) {
          assert.ok(Math.abs((cut[i] as number) - (whole[i] as number)) <= 1, `${rate} Hz in ${chunk}s differs at ${i}`);
        }
      }
    }
  });

  it('returns nothing for nothing, and goes on from where it was after it', () => {
    const r = new Resampler(48000);
    assert.equal(r.process(new Float32Array(0)).length, 0);
    const input = sine(440, 48000, 4800);
    assert.deepEqual(run(r, input), run(new Resampler(48000), input));
  });

  it('only rounds when the rates are the same', () => {
    const out = new Resampler(16000).process(new Float32Array([0, 0.5, -0.5, 1, -1, 1.5]));
    assert.deepEqual(Array.from(out), [0, 16384, -16384, 32767, -32768, 32767]);
  });

  it('also goes up: 8 kHz in gives twice as many samples at the same pitch', () => {
    const out = run(new Resampler(8000), sine(440, 8000, 8000));
    assert.equal(out.length, 16000);
    assert.ok(Math.abs(cycles(out, SETTLE) / ((out.length - SETTLE) / 16000) - 440) < 5);
  });

  it('refuses a rate that is not a positive number', () => {
    assert.throws(() => new Resampler(0), RangeError);
    assert.throws(() => new Resampler(48000, -1), RangeError);
    assert.throws(() => new Resampler(Number.NaN), RangeError);
  });
});

describe('int16ToFloat32', () => {
  it('reads little-endian samples as fractions of full scale', () => {
    const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f, 0x00, 0x80]); // 16384, -16384, 32767, -32768
    assert.deepEqual(Array.from(int16ToFloat32(bytes.buffer)), [0.5, -0.5, 32767 / 32768, -1]);
  });

  it('ignores a trailing odd byte', () => {
    assert.equal(int16ToFloat32(new Uint8Array(5).buffer).length, 2);
  });

  it('turns nothing into nothing', () => {
    assert.equal(int16ToFloat32(new ArrayBuffer(0)).length, 0);
    assert.equal(int16ToFloat32(new Uint8Array(0)).length, 0);
    assert.equal(int16ToFloat32(new Uint8Array(1)).length, 0);
  });

  it('reads a view that starts at an odd offset into its buffer', () => {
    // What a WebSocket message can look like: the samples are not on a two-byte boundary,
    // which `new Int16Array(buffer, 1)` refuses.
    const backing = new Uint8Array([0xaa, 0xe8, 0x03, 0x30, 0xf8, 0xbb]); // 1000, -2000, then a stray byte
    const view = backing.subarray(1);
    assert.equal(view.byteOffset, 1);
    assert.deepEqual(Array.from(int16ToFloat32(view)), [1000 / 32768, -2000 / 32768]);
  });
});

describe('floatToInt16', () => {
  it('clamps to full scale and keeps the two ends apart', () => {
    assert.deepEqual(Array.from(floatToInt16([1.5, -1.5])), [32767, -32768]);
    assert.deepEqual(Array.from(floatToInt16([1, -1, 0])), [32767, -32768, 0]);
  });

  it('rounds to the nearest sample', () => {
    assert.deepEqual(Array.from(floatToInt16([0.25, -0.25])), [8192, -8192]); // 8191.75, -8192
    assert.deepEqual(Array.from(floatToInt16(new Float32Array([1 / 32767, 0.4 / 32767]))), [1, 0]);
  });

  it('turns nothing into nothing', () => {
    assert.equal(floatToInt16(new Float32Array(0)).length, 0);
  });
});

describe('Meter', () => {
  const frame = (value: number, n = 320) => new Int16Array(n).fill(value);

  it('keeps its numbers where the phone has them', () => {
    assert.equal(Meter.floorDb, -60);
    assert.equal(Meter.ceilingDb, -16);
    assert.equal(Meter.attack, 0.6);
    assert.equal(Meter.release, 0.12);
  });

  it('reads silence as nothing', () => {
    const m = new Meter();
    assert.equal(m.process(frame(0)), 0);
    assert.equal(m.level, 0);
  });

  it('jumps most of the way up on one full-scale frame', () => {
    const m = new Meter();
    const level = m.process(frame(-32768));
    assert.ok(level >= 0.6, `${level}`);
    assert.equal(m.level, level);
  });

  it('falls back slowly: a silent frame after a loud one keeps about 0.88 of it', () => {
    const m = new Meter();
    const loud = m.process(frame(32767));
    const after = m.process(frame(0));
    assert.ok(Math.abs(after / loud - 0.88) < 0.01, `${after / loud}`);
  });

  it('measures the peak in decibels: a peak at the ceiling fills the meter, one at the floor leaves it empty', () => {
    // -16 dBFS is 32768 / 10^(16/20) = 5207.
    const loud = new Meter();
    for (let i = 0; i < 50; i++) loud.process(frame(5207));
    assert.ok(loud.level > 0.99, `${loud.level}`);
    // -60 dBFS is 33; a peak that quiet is the bottom of the scale.
    const quiet = new Meter();
    for (let i = 0; i < 50; i++) quiet.process(frame(32));
    assert.equal(quiet.level, 0);
  });

  it('goes by the one loud sample in a frame, not the average', () => {
    const m = new Meter();
    const f = frame(0);
    f[100] = 5207;
    assert.ok(m.process(f) > 0.59);
  });
});
