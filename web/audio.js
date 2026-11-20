// @ts-check
// Mic in, speaker out, in a browser, and nothing about the network: a port of
// `AudioPipe.swift`, with the same three bits (`muted`, `output`, `waiting`) and the same
// callbacks. The microphone is captured by mic-worklet.js, which hands over 16 kHz Int16
// frames; the reply is scheduled here, one AudioBuffer per chunk, back to back. What can be
// wrong about the counting is in playback.js (PlayQueue) and what can be wrong about the
// samples is in pcm.js, both plain functions with tests; this file is only the Web Audio
// that moves them, and is checked in a real browser.
//
// Importing it touches no browser global, so a test can; everything that needs one is inside
// a method.

import { Meter, int16ToFloat32 } from './pcm.js';
import { PlayQueue } from './playback.js';

const WORKLET = '/mic-worklet.js';
const CHIMES = '/chimes.wav';
/** What the relay sends the reply in. */
const REPLY_RATE = 24000;
/** Quiet on purpose: the chimes sit under a voice about to speak, never in place of one. */
const CHIME_VOLUME = 0.5;
const CHIME_FADE_IN = 0.4;
const CHIME_FADE_OUT = 0.15;
/** A buffer is never started in the past, and a few ms ahead of the clock keeps it from being late to the first render. */
const LEAD = 0.02;

/** @param {unknown} e */
function describe(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * What to tell a person whose microphone would not open. By the error's name and nothing
 * else, since a DOMException from another frame or an old browser is not always an Error, and
 * never throwing, since this runs inside a failure.
 * @param {unknown} err
 * @returns {string}
 */
export function micErrorMessage(err) {
  let name = '';
  try {
    const n = typeof err === 'object' && err !== null ? /** @type {{ name?: unknown }} */ (err).name : undefined;
    if (typeof n === 'string') name = n;
  } catch {
    // a hostile object: the generic message below is the answer
  }
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return "Microphone permission was denied. Allow the microphone for this site in the browser's site settings, then try again.";
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found. Plug one in, or check that this device has one, then try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone could not be opened. It may be in use by another app: close that and try again.';
    default:
      return 'Could not start the microphone.';
  }
}

export class AudioPipe {
  /** One 40 ms frame of the microphone, 16 kHz Int16 LE (all zeros while muted). @type {(chunk: ArrayBuffer) => void} */
  onChunk = () => {};
  /** A 0…1 loudness of the microphone, for the waveform; 0 while muted. @type {(level: number) => void} */
  onLevel = () => {};
  /** The speaker has nothing left; carries how many milliseconds of the reply it played. @type {(playedMs: number) => void} */
  onDrained = () => {};
  /** Something went wrong after the start that the person should be told. @type {(message: string) => void} */
  onProblem = () => {};
  /** Something the audio system did, as observed, for the relay's log. No diagnosis. @type {(note: string) => void} */
  onAudio = () => {};

  /**
   * Send silence instead of the room. Silence, not nothing: the relay reads a gap in the bytes
   * as the client going away, so the frames keep coming at the same rate, zeroed.
   */
  muted = false;

  #output = true;
  #waiting = false;

  /** The reply's bookkeeping; the schedule is this file's, the count is its. */
  #queue;
  /** Set while being stopped, so tearing down does not report a speaker running dry. */
  #closing = false;

  /** @type {AudioContext | null} also the answer to "is this running": set at the first line of `start`, cleared by `stop` */
  #ctx = null;
  /** @type {MediaStream | null} */
  #stream = null;
  /** @type {MediaStreamAudioSourceNode | null} */
  #mic = null;
  /** @type {AudioWorkletNode | null} */
  #worklet = null;
  /** @type {GainNode | null} silent, and the way the worklet is kept on the graph's path to the destination */
  #sink = null;
  #meter = new Meter();

  /** @type {Set<AudioBufferSourceNode>} reply buffers started or scheduled and not yet ended */
  #sources = new Set();
  /** When the next reply buffer should start, on the context's clock: back to back. */
  #nextTime = 0;

  /** @type {AudioBuffer | null} */
  #chimeBuffer = null;
  /** @type {GainNode | null} */
  #chimeGain = null;
  /** @type {AudioBufferSourceNode | null} the loop, while it is running, fading or not */
  #chimeSource = null;
  #chimeWanted = false;
  /** Bumped by every change of mind, so a stop scheduled for the end of a fade-out can tell a newer chime has begun. */
  #chimeGen = 0;

  /** @type {WakeLockSentinel | null} */
  #wake = null;
  #waking = false;

  constructor() {
    this.#queue = new PlayQueue({
      onDrained: (ms) => {
        if (!this.#closing) this.#emit('onDrained', ms);
      },
      onChime: (on) => {
        this.#chimeWanted = on;
        this.#applyChime();
      },
      now: () => performance.now(),
      setTimer: (fn, ms) => {
        setTimeout(fn, ms);
      },
    });
  }

  /**
   * Play nothing instead of the reply — the mirror of `muted`. The chunks keep arriving and
   * are consumed on the spot, so the relay still hears "the reply is over" the moment it is;
   * the chimes are off too.
   *
   * The queue acts on every assignment, even to the value it has (Swift's didSet), and each
   * one that switches it off reports the speaker dry — so a caller setting it on every turn
   * would be reporting a drain per turn. Only a change reaches it.
   */
  get output() {
    return this.#output;
  }
  set output(on) {
    if (on === this.#output) return;
    this.#output = on;
    this.#queue.output = on;
    if (!on) this.#dropSources();
  }

  /** A reply is owed: a turn is running and not yet over. The queue decides what the wait sounds like. Forwarded only on a change, like `output`. */
  get waiting() {
    return this.#waiting;
  }
  set waiting(on) {
    if (on === this.#waiting) return;
    this.#waiting = on;
    this.#queue.waiting = on;
  }

  /**
   * The microphone, or a thrown refusal whose message is fit to show.
   * @returns {Promise<MediaStream>}
   */
  static async requestMic() {
    // Absent altogether on a page that is not secure (plain http that is not localhost), which
    // is a different problem from a refusal, and one that no setting fixes.
    const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (!media?.getUserMedia) throw new Error('The microphone needs a secure page. Open the https address the relay printed, or use localhost.');
    try {
      return await media.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      throw new Error(micErrorMessage(e));
    }
  }

  /**
   * Open the microphone and the speaker. Call it from the tap that starts the call: a browser
   * only starts audio for a page the person has touched, and the context is resumed here before
   * anything is awaited, because the permission prompt that follows can outlast the tap's
   * grace. Rejects with a message fit to show. Resolves without doing anything if `stop` came
   * first.
   */
  async start() {
    if (this.#ctx) return;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.#ctx = ctx;
    const resumed = ctx.resume().catch(() => {});

    try {
      const stream = await AudioPipe.requestMic();
      if (this.#ctx !== ctx) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      this.#stream = stream;

      // The processor module imports pcm.js, so this is also where a browser that cannot do
      // that in a worklet says so.
      await ctx.audioWorklet.addModule(WORKLET).catch((e) => {
        throw new Error(`Could not load the microphone processor: ${describe(e)}`);
      });
      await resumed;
      if (this.#ctx !== ctx) return;

      this.#meter = new Meter();
      const mic = ctx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(ctx, 'duck-mic', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      worklet.port.onmessage = (e) => this.#frame(e.data);
      worklet.onprocessorerror = () => this.#emit('onProblem', 'The microphone processing stopped unexpectedly.');
      // A node nothing listens to may never be asked for audio, so the worklet runs into a
      // gain of zero that runs into the speaker: the processor is pulled, and nothing is heard.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      mic.connect(worklet);
      worklet.connect(sink);
      sink.connect(ctx.destination);
      this.#mic = mic;
      this.#worklet = worklet;
      this.#sink = sink;

      const chimeGain = ctx.createGain();
      chimeGain.gain.value = 0;
      chimeGain.connect(ctx.destination);
      this.#chimeGain = chimeGain;
      void this.#loadChimes(ctx);

      const track = stream.getAudioTracks()[0];
      if (track) track.onended = () => this.#emit('onProblem', 'The microphone was disconnected.');
      ctx.addEventListener('statechange', this.#onState);
      document.addEventListener('visibilitychange', this.#onVisible);
      void this.#lockScreen();

      const s = track ? track.getSettings() : {};
      this.#emit(
        'onAudio',
        `mic ${ctx.sampleRate} Hz to 16000 Hz, ${ctx.state}; echoCancellation ${s.echoCancellation}, ` +
          `noiseSuppression ${s.noiseSuppression}, autoGainControl ${s.autoGainControl}, ${s.channelCount} ch`,
      );
    } catch (e) {
      // Whatever went wrong after a `stop` is that `stop`: a prompt refused, or a worklet load
      // that failed because the context was closed under it. The caller ended the call and is
      // not owed an error for it.
      if (this.#ctx !== ctx) return;
      this.stop();
      throw e;
    }
  }

  /** Everything given back; safe to call twice, or before `start`. */
  stop() {
    const ctx = this.#ctx;
    if (!ctx) return;
    this.#ctx = null;

    // A pipe being closed reports nothing: its owner is already on the way out.
    this.#closing = true;
    this.waiting = false;
    this.#queue.flush();
    this.#closing = false;
    this.#dropSources();
    this.#chimeGen++;
    this.#chimeSource = null;
    this.#chimeBuffer = null;
    this.#chimeGain?.disconnect();
    this.#chimeGain = null;

    ctx.removeEventListener('statechange', this.#onState);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.#onVisible);
    if (this.#worklet) {
      this.#worklet.port.onmessage = null;
      this.#worklet.onprocessorerror = null;
      this.#worklet.disconnect();
    }
    this.#mic?.disconnect();
    this.#sink?.disconnect();
    this.#worklet = this.#mic = this.#sink = null;
    for (const t of this.#stream?.getTracks() ?? []) {
      t.onended = null;
      t.stop();
    }
    this.#stream = null;

    const wake = this.#wake;
    this.#wake = null;
    wake?.release().catch(() => {});
    ctx.close().catch(() => {});
  }

  /**
   * Queue one chunk of reply audio (24 kHz Int16 LE). Chunks play back to back; an odd
   * trailing byte is dropped, an empty chunk is nothing.
   * @param {ArrayBuffer | ArrayBufferView} pcm
   */
  play(pcm) {
    const samples = int16ToFloat32(pcm);
    const frames = samples.length;
    const ctx = this.#ctx;
    // With the output on there has to be something to play it on; with it off the queue
    // consumes the chunk on the spot, as it would with a speaker.
    if (this.#output && !ctx) return;
    const { play, token } = this.#queue.enqueue(frames);
    if (!play || !ctx) return;

    const buffer = ctx.createBuffer(1, frames, REPLY_RATE);
    buffer.copyToChannel(/** @type {Float32Array<ArrayBuffer>} */ (samples), 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + LEAD, this.#nextTime);
    this.#nextTime = at + buffer.duration;
    this.#sources.add(source);
    // `ended` is the browser saying this buffer reached the speaker, and is the only place the
    // count of what was heard grows; a source stopped by a flush ends too, with a token the
    // queue has already moved past.
    source.onended = () => {
      this.#sources.delete(source);
      this.#queue.played(token, frames);
    };
    source.start(at);
  }

  /** Barge-in: drop whatever is queued for the speaker. */
  flush() {
    // The queue first, so a source that still reports in is of a past batch and is not credited
    // as heard; clearing each `onended` in #dropSources is the second guard on the same thing.
    this.#queue.flush();
    this.#dropSources();
  }

  /** A new reply is coming, so forget what the last one played. */
  expectReply() {
    this.#queue.expectReply();
  }

  /** Stop everything scheduled and let go of it; the next chunk starts from the clock again. */
  #dropSources() {
    for (const source of this.#sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already ended
      }
      source.disconnect();
    }
    this.#sources.clear();
    this.#nextTime = 0;
  }

  /** @param {unknown} data one frame from the worklet */
  #frame(data) {
    if (!(data instanceof ArrayBuffer)) return;
    if (this.muted) {
      // Zeroed after capture, so the frame is exactly the shape a heard one would be. The meter
      // is skipped rather than fed zeros, so the level drops to nothing at once and the waveform
      // going flat is how the screen says muted.
      this.#emit('onLevel', 0);
      this.#emit('onChunk', new ArrayBuffer(data.byteLength));
      return;
    }
    this.#emit('onLevel', this.#meter.process(new Int16Array(data)));
    this.#emit('onChunk', data);
  }

  /**
   * Call one of the callbacks the owner assigned. What it does is not this file's business, and
   * what it does wrong must not be either: a waveform that throws would otherwise cost the relay
   * its frames (and so, in two seconds, its ears), a session that throws from `onDrained` would
   * leave a barge-in half done. So the audio path carries on, and the throw is reported, to the
   * console, where it can be found, rather than lost.
   * @param {'onChunk' | 'onLevel' | 'onDrained' | 'onProblem' | 'onAudio'} name
   * @param {ArrayBuffer | number | string} arg
   */
  #emit(name, arg) {
    try {
      /** @type {(arg: any) => void} */ (this[name]).call(this, arg);
    } catch (e) {
      console.error(`AudioPipe: ${name} threw`, e);
    }
  }

  /** Fetched and decoded once per start; if that fails a wait is silent, and the relay's log says so. @param {AudioContext} ctx */
  async #loadChimes(ctx) {
    try {
      const res = await fetch(CHIMES);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
      if (this.#ctx !== ctx) return;
      this.#chimeBuffer = buffer;
      this.#applyChime(); // a wait that began while it loaded
    } catch (e) {
      if (this.#ctx === ctx) this.#emit('onAudio', `chimes unavailable, a wait will be silent: ${describe(e)}`);
    }
  }

  /**
   * Make the loop match `#chimeWanted`, faded at both edges so neither is a click. Starting
   * while a fade-out is still running carries on from the volume it has reached, and the loop
   * is stopped only once a fade-out has played to its end and nothing has changed since.
   */
  #applyChime() {
    const ctx = this.#ctx;
    const gain = this.#chimeGain;
    const buffer = this.#chimeBuffer;
    if (!ctx || !gain || !buffer) return;
    const t = ctx.currentTime;
    const volume = gain.gain;
    const gen = ++this.#chimeGen;
    volume.cancelScheduledValues(t);

    if (this.#chimeWanted) {
      if (this.#chimeSource) {
        volume.setValueAtTime(volume.value, t);
      } else {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(gain);
        source.start(t);
        this.#chimeSource = source;
        volume.setValueAtTime(0, t);
      }
      volume.linearRampToValueAtTime(CHIME_VOLUME, t + CHIME_FADE_IN);
      return;
    }

    const source = this.#chimeSource;
    if (!source) return;
    volume.setValueAtTime(volume.value, t);
    volume.linearRampToValueAtTime(0, t + CHIME_FADE_OUT);
    setTimeout(() => {
      if (gen !== this.#chimeGen) return;
      try {
        source.stop();
      } catch {
        // already stopped
      }
      source.disconnect();
      if (this.#chimeSource === source) this.#chimeSource = null;
    }, (CHIME_FADE_OUT + 0.05) * 1000);
  }

  /** Holds the screen on while the microphone is open: a phone that dims and locks stops listening. */
  async #lockScreen() {
    if (this.#waking || (this.#wake && !this.#wake.released)) return;
    this.#waking = true;
    try {
      const lock = await navigator.wakeLock?.request('screen');
      if (!lock) return;
      if (this.#ctx) this.#wake = lock;
      else await lock.release(); // stopped while it was being granted
    } catch {
      // a hidden tab, a saver mode, a browser without it: the screen may dim, and the call goes on
    } finally {
      this.#waking = false;
    }
  }

  /** A hidden page loses its wake lock and may lose its audio; coming back asks for both again. */
  #onVisible = () => {
    const ctx = this.#ctx;
    if (!ctx || document.visibilityState !== 'visible') return;
    void this.#lockScreen();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  };

  #onState = () => {
    const ctx = this.#ctx;
    if (ctx) this.#emit('onAudio', `audio context ${ctx.state}`);
  };
}
