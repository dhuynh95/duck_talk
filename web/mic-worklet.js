// @ts-nocheck — runs in the AudioWorklet scope (AudioWorkletProcessor, registerProcessor and
// `sampleRate` are its globals, not the DOM's), which tsc is not told about; see tsconfig.json.
//
// The microphone's half of the audio path, on the audio thread: what the browser hands over
// (128 samples at a time, at whatever rate the device runs) goes through one Resampler and
// comes out as the relay's 16 kHz Int16, posted to the page in frames of 40 ms. The audio
// thread's quantum is not a multiple of anything, so the resampled samples are gathered
// until a frame is full and posted exactly then: the page sees one frame every 40 ms, steady,
// which is the cadence the relay reads as the client being there.
//
// One Resampler for the life of the capture — it is stateful, and a new one per call would
// put a seam in the audio every 2.7 ms. Imported from pcm.js, so the thing that is tested is
// the thing that runs here.

import { Resampler } from './pcm.js';

const OUT_RATE = 16000;
/** 40 ms at 16 kHz. */
const FRAME = 640;

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new Resampler(sampleRate, OUT_RATE);
    this.frame = new Int16Array(FRAME);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    // No input is a track that has gone, which the page hears of from the track itself; making
    // up silence here would hide it from the relay as well.
    if (!channel) return true;

    const samples = this.resampler.process(channel);
    for (let at = 0; at < samples.length; ) {
      const n = Math.min(FRAME - this.filled, samples.length - at);
      this.frame.set(samples.subarray(at, at + n), this.filled);
      this.filled += n;
      at += n;
      if (this.filled === FRAME) {
        // Transferred, not copied: the buffer moves to the page and a fresh one starts here.
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(FRAME);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('duck-mic', MicProcessor);
