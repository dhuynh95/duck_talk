// @ts-check
// The sample maths of the audio path, kept as plain functions so they can be tested without a
// browser: the resampler that turns what the microphone gives (44.1 or 48 kHz floats) into what
// the relay listens in (16 kHz Int16), the two conversions between Int16 and float, and the
// loudness meter. mic-worklet.js imports `Resampler` from here, so this file is dependency-free,
// has no side effects at import, and touches nothing the AudioWorklet scope lacks (no
// document, no window, no self).

/**
 * Peak sample, in decibels below full scale, mapped to 0…1 and smoothed.
 *
 * Full scale is not the top of the meter: a phone held at talking distance peaks around -30 dB,
 * so the range stops at -16 and leaves the last of the headroom to shouting. It is decibels
 * because loudness is logarithmic; on a raw amplitude scale anything above a whisper pins it
 * at full. Then the level jumps up at once and falls back slowly, so it does not flicker out in
 * the gaps between syllables. The same numbers as the iPhone app (`AudioPipe.meter`), so the
 * waveform feels the same on both.
 */
export class Meter {
  /** Below this the meter is empty. @readonly */
  static floorDb = -60;
  /** At this it is full. @readonly */
  static ceilingDb = -16;
  /** The share of the way to a louder peak covered in one frame: a new peak shows up now. @readonly */
  static attack = 0.6;
  /** The same going down: slow enough that syllables join up. @readonly */
  static release = 0.12;

  #level = 0;

  /** The level after the last frame, 0…1. */
  get level() {
    return this.#level;
  }

  /**
   * @param {Int16Array} samples one frame of microphone
   * @returns {number} the new level, 0…1
   */
  process(samples) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(/** @type {number} */ (samples[i]));
      if (v > peak) peak = v;
    }
    const db = 20 * Math.log10(Math.max(peak / 32768, 1e-7));
    const target = Math.min(1, Math.max(0, (db - Meter.floorDb) / (Meter.ceilingDb - Meter.floorDb)));
    this.#level += (target - this.#level) * (target > this.#level ? Meter.attack : Meter.release);
    return this.#level;
  }
}

/**
 * One float sample as an Int16, rounded to the nearest and clamped. Positive scales by 32767
 * and negative by 32768, so +1 and -1 land on the two ends of the range and nothing wraps.
 * @param {number} v
 */
function quantize(v) {
  if (v >= 1) return 32767;
  if (v <= -1) return -32768;
  return Math.round(v < 0 ? v * 32768 : v * 32767);
}

/**
 * Float samples (−1…1) as Int16, clamped at full scale.
 * @param {ArrayLike<number>} f
 * @returns {Int16Array}
 */
export function floatToInt16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = quantize(/** @type {number} */ (f[i]));
  return out;
}

/**
 * Little-endian Int16 bytes as floats (−1…1). A trailing odd byte is dropped.
 *
 * Read through a DataView and not an `Int16Array` over the bytes: a WebSocket message can be a
 * view that starts at an odd offset into its buffer, and `new Int16Array(buffer, oddOffset)`
 * throws.
 * @param {ArrayBuffer | ArrayBufferView} bytes
 * @returns {Float32Array}
 */
export function int16ToFloat32(bytes) {
  const view = ArrayBuffer.isView(bytes)
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new DataView(bytes);
  const out = new Float32Array(view.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

// The low-pass is a Blackman-windowed sinc. Its cutoff sits at 0.9 of the lower of the two
// Nyquist rates, so nothing above half the OUTPUT rate survives to be folded down into the
// band; the window has ZEROS sinc zero-crossings on each side of the cutoff (108 taps going
// 48 → 16 kHz), which puts the stop band well under the output Nyquist and takes about 74 dB
// off it. The kernel is sampled into a table once, OVERSAMPLE entries per input sample, and
// read with linear interpolation, so the read position can be any fraction without a sin() per
// tap.
const CUTOFF = 0.9;
const ZEROS = 16;
const OVERSAMPLE = 128;

/** @param {number} a @param {number} b */
function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Streaming sample-rate converter, Float32 in, Int16 out. It keeps its read position and the
 * last stretch of input between calls, so where one chunk ends and the next begins does not
 * show: the output is the same however the input is cut, and its total length is exactly
 * ceil(input × outRate / inRate).
 *
 * The filter is linear-phase, so everything comes out a fixed number of input samples late
 * (54 at 48 → 16 kHz, a little over a millisecond) — it is the price of keeping the output
 * count equal to the input's share, and speech to a transcriber cannot tell.
 *
 * The position is kept as whole numbers (a step of inRate/outRate in lowest terms), so it
 * never drifts over a long call the way a running float would.
 */
export class Resampler {
  /** @type {number} input samples consumed per `#b` output samples, in lowest terms */
  #a;
  /** @type {number} */
  #b;
  #passthrough;
  /** Kernel taps, even: it reaches `#taps - 1` samples back from the one being read. */
  #taps = 0;
  /** @type {Float32Array} the windowed-sinc kernel, OVERSAMPLE entries per input sample */
  #table = new Float32Array(0);
  /** @type {Float32Array} the last `#taps - 1` input samples, then the chunk being processed */
  #work = new Float32Array(0);
  /** Index (in the current chunk) of the sample the next output is read at, and how far past it in 1/#b. */
  #cur = 0;
  #phase = 0;

  /**
   * @param {number} inRate  what the samples fed to `process` are at
   * @param {number} outRate what comes out
   */
  constructor(inRate, outRate = 16000) {
    if (!(inRate >= 1 && outRate >= 1 && Number.isFinite(inRate) && Number.isFinite(outRate))) {
      throw new RangeError(`sample rates must be positive numbers, got ${inRate} and ${outRate}`);
    }
    const from = Math.round(inRate);
    const to = Math.round(outRate);
    const g = gcd(from, to);
    this.#a = from / g;
    this.#b = to / g;
    this.#passthrough = from === to;
    if (this.#passthrough) return;

    const scale = Math.max(1, from / to); // input samples per output sample, if it is a reduction
    const fc = (0.5 * CUTOFF) / scale; // cycles per input sample
    const half = Math.ceil(ZEROS / (2 * fc));
    this.#taps = 2 * half;
    this.#work = new Float32Array(this.#taps - 1);
    const size = this.#taps * OVERSAMPLE;
    this.#table = new Float32Array(size + 1);
    for (let n = 0; n <= size; n++) {
      const x = n / OVERSAMPLE - half; // distance from the kernel's centre, in input samples
      const u = n / size;
      const taper = 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
      const arg = 2 * Math.PI * fc * x;
      this.#table[n] = 2 * fc * (x === 0 ? 1 : Math.sin(arg) / arg) * taper;
    }
  }

  /**
   * @param {Float32Array} input
   * @returns {Int16Array}
   */
  process(input) {
    const n = input.length;
    if (n === 0) return new Int16Array(0);
    if (this.#passthrough) return floatToInt16(input);

    const taps = this.#taps;
    const history = taps - 1;
    if (this.#work.length < history + n) {
      const bigger = new Float32Array(history + n);
      bigger.set(this.#work.subarray(0, history));
      this.#work = bigger;
    }
    const work = this.#work;
    work.set(input, history);

    const a = this.#a;
    const b = this.#b;
    const table = this.#table;
    let cur = this.#cur;
    let phase = this.#phase;

    // Outputs left in this chunk: those whose read position is before its end.
    const behind = n * b - (cur * b + phase);
    const count = behind > 0 ? Math.floor((behind + a - 1) / a) : 0;
    const out = new Int16Array(count);

    for (let o = 0; o < count; o++) {
      // The kernel's first tap is at table index (fraction + history) * OVERSAMPLE and each
      // later one a whole input sample, OVERSAMPLE entries, below it — so one fractional
      // part serves every tap.
      const t = (phase / b + history) * OVERSAMPLE;
      const base = Math.floor(t);
      const w = t - base;
      let acc = 0;
      let sum = 0;
      for (let j = 0, at = base; j < taps; j++, at -= OVERSAMPLE) {
        const lo = /** @type {number} */ (table[at]);
        const k = lo + (/** @type {number} */ (table[at + 1]) - lo) * w;
        acc += /** @type {number} */ (work[cur + j]) * k;
        sum += k;
      }
      // Divided by the taps' own sum, so a steady level comes out at the same level
      // whatever fraction the read position is at.
      out[o] = quantize(acc / sum);

      phase += a;
      if (phase >= b) {
        const whole = Math.floor(phase / b);
        phase -= whole * b;
        cur += whole;
      }
    }

    this.#cur = cur - n;
    this.#phase = phase;
    work.copyWithin(0, n, n + history);
    return out;
  }
}
