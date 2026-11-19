import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PlayQueue } from '../web/playback.js';

// The queue is handed its clock and its timers, so a test moves time by hand: nothing
// here waits, and nothing depends on how fast the machine is.
function rig(sampleRate?: number) {
  let time = 1_000_000; // not 0: "long ago" has to be told apart from "just now"
  const timers: { at: number; fn: () => void }[] = [];
  const drained: number[] = [];
  const chimes: boolean[] = [];
  const queue = new PlayQueue({
    onDrained: (ms) => drained.push(ms),
    onChime: (on) => chimes.push(on),
    now: () => time,
    setTimer: (fn, ms) => timers.push({ at: time + ms, fn }),
    ...(sampleRate ? { sampleRate } : {}),
  });
  /** Moves the clock, running each timer that comes due on the way, in order. */
  const advance = (ms: number) => {
    const end = time + ms;
    for (;;) {
      const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.splice(timers.indexOf(next), 1);
      time = Math.max(time, next.at);
      next.fn();
    }
    time = end;
  };
  return { queue, drained, chimes, advance };
}

describe('PlayQueue bookkeeping', () => {
  it('hands out a play instruction and a token, and credits what was played at 24 frames a millisecond', () => {
    const { queue } = rig();
    const a = queue.enqueue(2400);
    assert.equal(a.play, true);
    assert.equal(queue.queued, 1);
    const b = queue.enqueue(480);
    assert.equal(b.token, a.token);
    assert.equal(queue.queued, 2);

    queue.played(a.token, 2400);
    assert.equal(queue.playedMs, 100);
    queue.played(b.token, 480);
    assert.equal(queue.playedMs, 120);
    assert.equal(queue.queued, 0);
  });

  it('counts at the rate it was given', () => {
    const { queue } = rig(16000);
    const { token } = queue.enqueue(1600);
    queue.played(token, 1600);
    assert.equal(queue.playedMs, 100);
  });

  it('reports the speaker dry once, when the last buffer has played', () => {
    const { queue, drained } = rig();
    const { token } = queue.enqueue(2400);
    queue.enqueue(2400);
    queue.played(token, 2400);
    assert.deepEqual(drained, []); // one still to come
    queue.played(token, 2400);
    assert.deepEqual(drained, [200]);
  });

  it('never counts a buffer that was played after a flush took it away', () => {
    const { queue, drained } = rig();
    const old = queue.enqueue(2400);
    queue.enqueue(2400);
    queue.flush();
    assert.deepEqual(drained, [0]);
    assert.equal(queue.queued, 0);

    queue.played(old.token, 2400); // the stopped source still reports in
    queue.played(old.token, 2400);
    assert.equal(queue.playedMs, 0);
    assert.deepEqual(drained, [0]); // and says nothing more

    const fresh = queue.enqueue(480);
    assert.notEqual(fresh.token, old.token);
    queue.played(fresh.token, 480);
    assert.equal(queue.playedMs, 20);
  });

  it('keeps what had played when a flush reports it', () => {
    const { queue, drained } = rig();
    const { token } = queue.enqueue(2400);
    queue.enqueue(2400);
    queue.played(token, 2400);
    queue.flush();
    assert.deepEqual(drained, [100]);
  });

  it('with the output off, counts a chunk as played on arrival and reports dry at once', () => {
    const { queue, drained } = rig();
    queue.output = false;
    drained.length = 0; // switching off flushes; that is not what is being looked at
    const r = queue.enqueue(2400);
    assert.equal(r.play, false);
    assert.equal(queue.playedMs, 100);
    assert.equal(queue.queued, 0);
    assert.deepEqual(drained, [100]);
    queue.enqueue(480);
    assert.equal(queue.playedMs, 120);
    assert.deepEqual(drained, [100, 120]);
  });

  it('switching the output off drops what was queued, as a flush does', () => {
    const { queue, drained } = rig();
    const { token } = queue.enqueue(2400);
    queue.output = false;
    assert.deepEqual(drained, [0]);
    assert.equal(queue.queued, 0);
    queue.played(token, 2400);
    assert.equal(queue.playedMs, 0);
  });

  it('treats an empty chunk as nothing, with the output on or off', () => {
    const { queue, drained, chimes } = rig();
    const r = queue.enqueue(0);
    assert.equal(r.play, false);
    assert.equal(typeof r.token, 'number');
    assert.equal(queue.queued, 0);
    queue.output = false;
    drained.length = 0;
    assert.equal(queue.enqueue(0).play, false);
    assert.deepEqual(drained, []);
    assert.equal(queue.playedMs, 0);
    assert.deepEqual(chimes, []);
  });

  it('forgets what the last reply played when a new one is expected', () => {
    const { queue } = rig();
    const { token } = queue.enqueue(2400);
    queue.played(token, 2400);
    assert.equal(queue.playedMs, 100);
    queue.expectReply();
    assert.equal(queue.playedMs, 0);
  });
});

describe('PlayQueue chimes', () => {
  it('chime at once for a wait that has not had any reply yet', () => {
    // The speaker has never played anything, so it has been dry for as long as there is.
    const { queue, chimes } = rig();
    queue.waiting = true;
    assert.deepEqual(chimes, [true]);
  });

  it('wait out a lull after the voice runs dry before chiming again', () => {
    const { queue, chimes, advance } = rig();
    queue.waiting = true;
    const { token } = queue.enqueue(2400);
    assert.deepEqual(chimes, [true, false]); // the reply takes the speaker

    queue.played(token, 2400); // dry as of now
    advance(1999);
    assert.deepEqual(chimes, [true, false]);
    advance(1);
    assert.deepEqual(chimes, [true, false, true]);
  });

  it('stop on the next chunk, and only then', () => {
    const { queue, chimes } = rig();
    queue.waiting = true;
    assert.deepEqual(chimes, [true]);
    queue.enqueue(2400);
    assert.deepEqual(chimes, [true, false]);
    queue.enqueue(2400);
    assert.deepEqual(chimes, [true, false]); // already off: no second report
  });

  it('are reported on a change only', () => {
    const { queue, chimes } = rig();
    queue.waiting = true;
    queue.waiting = true;
    queue.output = true;
    assert.deepEqual(chimes, [true]);
    queue.waiting = false;
    queue.waiting = false;
    assert.deepEqual(chimes, [true, false]);
  });

  it('stop when the wait is over', () => {
    const { queue, chimes } = rig();
    queue.waiting = true;
    queue.waiting = false;
    assert.deepEqual(chimes, [true, false]);
  });

  it('do not happen at all while the output is off', () => {
    const { queue, chimes, advance } = rig();
    queue.output = false;
    queue.waiting = true;
    queue.enqueue(480); // consumed on arrival
    advance(10_000);
    assert.deepEqual(chimes, []);
  });

  it('stop when the output goes off, and come back when it is on again after a lull', () => {
    const { queue, chimes, advance } = rig();
    queue.waiting = true;
    queue.output = false;
    assert.deepEqual(chimes, [true, false]);
    advance(2000);
    queue.output = true;
    assert.deepEqual(chimes, [true, false, true]);
  });

  it('count a lull from when the output last consumed a chunk, not from when it went off', () => {
    const { queue, chimes, advance } = rig();
    queue.output = false;
    queue.waiting = true;
    queue.enqueue(480);
    advance(1000);
    queue.output = true; // consumed 1 s ago: not dry for long enough yet
    assert.deepEqual(chimes, []);
    advance(999);
    assert.deepEqual(chimes, []);
    advance(1);
    assert.deepEqual(chimes, [true]);
  });

  it('check again when a timer fires, so a timer that is stale does nothing', () => {
    const { queue, chimes, advance } = rig();
    queue.waiting = true;
    const first = queue.enqueue(2400);
    queue.played(first.token, 2400); // a timer is now set for 2 s
    advance(1000);
    const second = queue.enqueue(2400); // a reply is playing again when it fires
    advance(5000);
    assert.deepEqual(chimes, [true, false]);

    queue.played(second.token, 2400);
    advance(1999);
    assert.deepEqual(chimes, [true, false]);
    advance(1);
    assert.deepEqual(chimes, [true, false, true]);
  });

  it('are not started by a timer that fires after the wait is over', () => {
    const { queue, chimes, advance } = rig();
    queue.waiting = true;
    const { token } = queue.enqueue(2400);
    queue.played(token, 2400);
    queue.waiting = false;
    advance(10_000);
    assert.deepEqual(chimes, [true, false]);
  });

  it('do not start early when a flush makes the speaker dry later than a timer assumed', () => {
    const { queue, chimes, advance } = rig();
    queue.waiting = true;
    const { token } = queue.enqueue(2400);
    queue.played(token, 2400); // dry at t0; a timer for t0 + 2000
    advance(1500);
    queue.flush(); // dry again at t0 + 1500
    advance(500); // the first timer fires: only 500 ms dry, so it asks again
    assert.deepEqual(chimes, [true, false]);
    advance(1499);
    assert.deepEqual(chimes, [true, false]);
    advance(1);
    assert.deepEqual(chimes, [true, false, true]);
  });
});
