// @ts-check
// What the speaker owes the relay and the wait chimes, as bookkeeping with no Web Audio in it:
// a port of the queue half of `AudioPipe.swift` (`play`, `drained`, `settle`, `chime`, `flush`).
// The browser glue schedules the buffers and says when one has ended; this file counts them,
// keeps the clock on how long the speaker has been dry, and says when a chime should start
// or stop. It is handed its clock and its timer, so a test can move time by hand.
//
// The one question the relay asks is how much of the reply was *heard*, so `playedMs` grows
// only when a buffer reports that it played — never from what was handed over, and never for
// a buffer that a flush threw away.

/**
 * @typedef {object} PlayQueueOptions
 * @property {(playedMs: number) => void} onDrained the speaker has nothing left; carries `playedMs` so the reader needs no second question
 * @property {(on: boolean) => void} onChime the chime loop should start or stop; only called when that changes
 * @property {() => number} now milliseconds, on any clock that only goes forward
 * @property {(fn: () => void, ms: number) => void} setTimer call `fn` once, `ms` from now; there is no cancelling, a timer that fires into a changed world falls through the same checks
 * @property {number} [sampleRate] of the reply audio, to turn frames into milliseconds; 24000
 */

export class PlayQueue {
  /**
   * A lull has to last before it chimes: the serial voice can starve for tens of milliseconds
   * between sentences, and a chime in a seam that short would sound inside the reply's own
   * breath.
   * @readonly
   */
  static lullMs = 2000;

  #onDrained;
  #onChime;
  #now;
  #setTimer;
  #framesPerMs;

  /** Buffers scheduled and not yet heard; the speaker is dry at zero. */
  #queued = 0;
  /**
   * Which batch of buffers is the current one. Every time the speaker runs dry the batch is
   * abandoned, and a buffer that reports in from an earlier one must not be credited: a source
   * that is stopped still reports every buffer it dropped, and counting those would credit the
   * listener with audio they never heard — precisely when the count is being read to prove a
   * reply was cut.
   */
  #epoch = 0;
  #playedMs = 0;
  /** When the speaker last ran dry. Long ago, until it does: a wait that starts cold chimes at once. */
  #dryAt = -Infinity;
  #chiming = false;
  #output = true;
  #waiting = false;

  /** @param {PlayQueueOptions} options */
  constructor({ onDrained, onChime, now, setTimer, sampleRate = 24000 }) {
    this.#onDrained = onDrained;
    this.#onChime = onChime;
    this.#now = now;
    this.#setTimer = setTimer;
    this.#framesPerMs = sampleRate / 1000;
  }

  /** Reply audio the speaker has actually played this turn, in milliseconds. */
  get playedMs() {
    return this.#playedMs;
  }

  /** Buffers handed out by `enqueue` and not yet reported played. */
  get queued() {
    return this.#queued;
  }

  /**
   * Play nothing instead of the reply. The chunks keep arriving and are consumed on the spot,
   * so `playedMs` still grows and the relay still hears "the reply is over" the moment it is.
   * The chimes are off too: a wait nobody will hear the end of needs no sound.
   *
   * Like a property observer, setting it always acts, even to the value it already has.
   */
  get output() {
    return this.#output;
  }
  set output(on) {
    this.#output = on;
    if (!on) this.flush();
    else this.#settle();
  }

  /**
   * A reply is owed: a turn is running and not yet over. The chimes cover it while the speaker
   * is dry — the head of the turn, and any long quiet in the middle when Claude has gone back
   * to its tools.
   */
  get waiting() {
    return this.#waiting;
  }
  set waiting(on) {
    this.#waiting = on;
    this.#settle();
  }

  /** A new reply is coming, so forget what the last one played. */
  expectReply() {
    this.#playedMs = 0;
  }

  /**
   * One chunk of reply audio arrived. `play` says whether to schedule it; if so, `token` goes
   * back into `played` when that buffer ends. With the output off the chunk is counted and the
   * speaker reported dry on the spot, in every respect a buffer that played out — through the
   * drained path and not a bare report, because dryness is what the chimes read: stamped only
   * at the flush that switched output off, the speaker would look dry for the whole time it was
   * consuming, and switching back on would chime until the next chunk landed.
   *
   * @param {number} frames samples in the chunk
   * @returns {{ play: boolean, token: number }}
   */
  enqueue(frames) {
    if (!(frames > 0)) return { play: false, token: this.#epoch };
    if (!this.#output) {
      this.#playedMs += frames / this.#framesPerMs;
      this.#drained();
      return { play: false, token: this.#epoch };
    }
    this.#queued++;
    const token = this.#epoch;
    this.#settle(); // the reply owns the speaker from the moment audio exists to play
    return { play: true, token };
  }

  /**
   * A scheduled buffer has been played to the speaker, in the browser's own words — this is
   * where the count of what was heard grows, and nowhere else.
   *
   * @param {number} token from the `enqueue` that scheduled it
   * @param {number} frames samples in that buffer
   */
  played(token, frames) {
    if (token !== this.#epoch) return;
    this.#playedMs += frames / this.#framesPerMs;
    this.#queued = Math.max(0, this.#queued - 1);
    if (this.#queued === 0) this.#drained();
    else this.#settle();
  }

  /** Barge-in, or anything else that takes the queued audio away: the speaker is dry now. */
  flush() {
    this.#drained();
  }

  /**
   * The speaker has nothing left to play. Four ways to arrive — the reply ran out, a flush
   * dropped it, the glue rebuilt the graph, output is off and a chunk was consumed on arrival —
   * and the one thing true in all four is what this says, so all four come through here.
   */
  #drained() {
    this.#epoch++;
    this.#queued = 0;
    this.#dryAt = this.#now();
    this.#onDrained(this.#playedMs);
    this.#settle();
  }

  /**
   * Chime if the wait is on and the speaker has been dry long enough; otherwise stop.
   * Re-checked, not scheduled once: every path that changes the answer — the bit flipping, a
   * chunk arriving, a buffer playing out — lands here, and a timer that fires into a changed
   * world just falls through the same guards.
   */
  #settle() {
    if (!(this.#waiting && this.#output && this.#queued === 0)) return this.#chime(false);
    const dry = this.#now() - this.#dryAt;
    if (dry >= PlayQueue.lullMs) return this.#chime(true);
    this.#setTimer(() => this.#settle(), PlayQueue.lullMs - dry);
  }

  /** @param {boolean} on */
  #chime(on) {
    if (on === this.#chiming) return;
    this.#chiming = on;
    this.#onChime(on);
  }
}
