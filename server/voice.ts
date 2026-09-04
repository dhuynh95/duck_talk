/**
 * Text in, 24 kHz PCM out: one text-to-speech request per sentence, read in the
 * order the sentences were written.
 *
 * There is no session and no socket here, and that is what keeps the rest simple.
 * "The reply is over" is something this file works out for itself — the queue is
 * dry and the audio it sent has had time to play — rather than a server event that
 * has to be counted; and cancelling is one `abort()` rather than swallowing the
 * acknowledgements of sends that no longer belong to a turn. A session that dies
 * mid-reply used to mute the connection for good — there is no longer a session to
 * lose, and a failed sentence costs that sentence.
 *
 * `onDone` waits out the audio because synthesis finishes long before the listener
 * does. Reporting the turn over when the last byte was *sent* would put the caller
 * back in its listening state while the reply is still audibly playing, and someone
 * talking over it then reads as a new instruction instead of a barge-in.
 *
 * Requests run one at a time, which is what keeps sentences in order and is why
 * text arriving fast can never pre-empt audio already being read. Synthesis outruns
 * playback by about three to one, so the queue does not starve and only the first
 * sentence's latency (~0.9s to first audio) is one the user can feel. Text is cut
 * at sentence boundaries on the way in, so audio starts long before Claude has
 * finished a paragraph — and the first sentence of a turn is cut as short as it
 * comes, because it is the only one anyone is waiting for.
 *
 * How the reply is read — brisk, slow, whatever — is the `voice` prompt, which the
 * phone saves and this file puts in front of each sentence. The API has no rate
 * parameter, so the wording is the only knob: over the same paragraph, plain reads
 * at 66 ms/character, "Read this at a brisk, quick pace" at 44, "Read this slowly"
 * at 95.
 *
 * Lifted from the web app's tts-session.ts + buffer.ts, at the `web-app` tag.
 *
 *   node voice.ts "Hello there. How are you?"     write reply.pcm, print timings
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import { read } from './prompts.ts';

/** Which voice Claude speaks in. Any of the prebuilt names. */
const VOICE_NAME = 'Sulafat';

// The endpoint returns 400 and 500 on requests that succeed unchanged moments
// later, so a sentence gets more than one chance. A dropped one is a hole in the
// middle of a reply — the exact symptom this file exists to have fixed — and the
// queue is serial, so a retry costs that sentence's latency and nothing else.
const ATTEMPTS = 3;
const RETRY_MS = 300;

export interface Voice {
  say(text: string): void;
  /** No more text is coming for this turn; `onDone` fires once the audio has all been sent. */
  finish(): void;
  /** How much of this turn's audio the phone's speaker has actually played, in
   *  milliseconds. The one true answer to "has the reply been heard" — the count comes
   *  from the player node's own per-buffer callback, where everything below is
   *  arithmetic over what was sent. A caller that cannot say this simply never calls
   *  it, and the arithmetic stands. */
  heard(ms: number): void;
  /** Drop what is queued and what is still coming for this turn. */
  interrupt(): void;
  close(): void;
}

export interface VoiceCallbacks {
  onPcm(pcm: Buffer): void;
  /** A sentence is being handed to the model — the request side of `onPcm`, and
   *  what separates waiting for text from waiting for audio. */
  onSay?(text: string): void;
  onDone?(): void;
  log?(m: string): void;
}

export function openVoice(ai: GoogleGenAI, model: string, cb: VoiceCallbacks): Voice {
  const log = cb.log ?? (() => {});
  const queue: string[] = [];
  // One controller is the whole cancellation story: it aborts the request in
  // flight, fences any chunk that arrives anyway, and tells an interrupt apart from
  // a real failure. A sentence belonging to a cancelled turn has an aborted signal;
  // nothing else does.
  let aborter = new AbortController();
  let reading = false; // the pump is running, and only one may
  let finishing = false; // the caller has said no more text is coming
  let closed = false;
  // The phone plays what it is sent, back to back, at 48 bytes per millisecond, so
  // when the reply should finish being heard is a subtraction over what went out.
  let firstAt = 0; // when this turn's first byte went out
  let sentMs = 0; // how much audio this turn has sent, in milliseconds of playback
  // And what the phone says it actually played, which is the same number only when
  // nothing went wrong. A route change takes queued audio with it, and then the
  // arithmetic above describes a reply nobody heard the end of.
  let heardMs = 0;
  let enough: (() => void) | null = null; // resolves the wait below, once heard covers sent

  const buf = sentenceBuffer((text) => {
    queue.push(text);
    void pump();
  });

  /** Read the queue to the end, then report that the turn's audio ran out. */
  async function pump(): Promise<void> {
    if (reading || closed) return;
    reading = true;
    while (queue.length && !closed) {
      const { signal } = aborter; // captured with the sentence, so a later interrupt aborts this one
      const text = queue.shift()!;
      // Read per sentence rather than cached, so editing it from the phone changes
      // how the *next* sentence sounds, mid-conversation, with nothing to invalidate.
      const style = read('voice');
      // The style is an instruction and the sentence is not, so the sentence says so.
      // Without the marker a short one is heard as a reply to the instruction and
      // comes back silent: measured, "Ready." after the style returns no audio at
      // all, while "Ready." alone returns 1.2s. It costs nothing — the same long
      // sentence reads in 4.76s with the marker against 4.64s without.
      const contents = style ? `${style}\n\n[READ]: ${text}` : text;
      let spoke = false; // audio for this sentence has reached the phone
      let failure: unknown = null;
      cb.onSay?.(text);
      const askedAt = Date.now();
      for (let attempt = 1; attempt <= ATTEMPTS && !signal.aborted && !closed; attempt++) {
        try {
          const stream = await ai.models.generateContentStream({
            model,
            contents,
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
              abortSignal: signal,
            },
          });
          for await (const chunk of stream) {
            if (signal.aborted || closed) break;
            const pcm = audio(chunk);
            if (pcm) {
              // Per sentence, so a cold first request and a warm later one are
              // separate numbers rather than one average.
              if (!spoke && process.env['DEBUG']) log(`sentence audio in ${Date.now() - askedAt}ms: ${text.slice(0, 40)}`);
              spoke = true;
              firstAt ||= Date.now();
              sentMs += pcm.length / 48;
              cb.onPcm(pcm);
            }
          }
          // A response that carried no audio is a failure too, and a silent one.
          failure = spoke ? null : new Error('response carried no audio');
        } catch (e) {
          // An interrupt aborts the request mid-flight; that is the point, not a fault.
          failure = e;
        }
        // Once the listener has heard the sentence start, restarting it would say the
        // beginning twice; a half-read sentence is the better of the two.
        if (spoke || signal.aborted) break;
        if (attempt < ATTEMPTS) await sleep(RETRY_MS * attempt, signal);
      }
      // Silence nobody logged is how the old session failure hid.
      if (failure && !signal.aborted && !closed) {
        log(spoke
          ? `voice failed part-way through a sentence, the rest goes unread: ${failure}`
          : `voice failed ${ATTEMPTS} times, this sentence goes unread: ${failure}`);
      }
    }
    // A dry queue means the audio is all *sent*; the phone is still playing it, and
    // synthesis outruns playback about three to one. Report the turn over when it has
    // been heard, not when it was sent — until then the caller is still in its
    // `claude` state, which is what lets it recognise someone talking over the reply.
    if (finishing && !closed) await played(aborter.signal);
    reading = false;
    if (queue.length) return void pump(); // more text arrived while the tail played
    if (finishing && !closed) {
      finishing = false;
      reset();
      cb.onDone?.();
    }
  }

  /**
   * Wait for the reply to have been heard.
   *
   * Two answers race, and the phone's is the true one: it counts buffers its speaker
   * actually played, where the sleep only knows what was handed over. Whichever
   * arrives first ends the wait — so a phone that reports ends the turn sooner and
   * more honestly when audio was lost, and one that cannot (an older app, probe.ts)
   * waits out the arithmetic exactly as before.
   */
  function played(signal: AbortSignal): Promise<void> {
    return Promise.race([
      sleep(firstAt + sentMs - Date.now(), signal),
      new Promise<void>((resolve) => {
        const done = () => { signal.removeEventListener('abort', done); enough = null; resolve(); };
        if (heardMs >= sentMs) return done();
        enough = done;
        signal.addEventListener('abort', done, { once: true });
      }),
    ]);
  }

  /** Back to knowing nothing about a reply, for the next turn. */
  function reset(): void {
    firstAt = 0;
    sentMs = 0;
    heardMs = 0;
    enough = null;
  }

  return {
    say(text) {
      if (closed) return;
      buf.push(text);
    },
    heard(ms) {
      if (closed) return;
      // Never backwards: a turn's audio is only ever more played than it was.
      heardMs = Math.max(heardMs, ms);
      // The phone only says this when its speaker has run dry, and `enough` only
      // exists while the last thing being waited for is the tail playing out — so a
      // report arriving here means the tail is over. Deliberately not conditional on
      // having heard all of it: short is exactly the case worth ending early, because
      // the missing audio is not late, it is gone.
      enough?.();
    },
    finish() {
      if (closed) return;
      buf.flush(); // may enqueue a last sentence, and start the pump
      finishing = true;
      if (!reading) void pump(); // nothing to read: drain at once, so onDone still fires
    },
    interrupt() {
      if (closed) return;
      aborter.abort();
      aborter = new AbortController();
      finishing = false;
      reset();
      queue.length = 0;
      buf.clear();
    },
    close() {
      if (closed) return;
      closed = true;
      aborter.abort();
      queue.length = 0;
      buf.clear();
    },
  };
}

/**
 * Resolves after `ms`, or as soon as the turn is cancelled — waiting out audio
 * nobody is listening to any more would hold the reader shut for the whole tail,
 * and the next turn would have nothing to read it.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** The PCM in one streamed chunk, if it carried any. */
function audio(chunk: GenerateContentResponse): Buffer | null {
  const data = chunk.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  return data ? Buffer.from(data, 'base64') : null;
}

// --- Sentence buffer --------------------------------------------------------

/**
 * Accumulate streamed text and emit it a sentence at a time.
 *
 * Two rules, and the first one is the whole latency story:
 *
 *   - The **first** sentence of a turn goes out at its first `. ! ?`, however
 *     short. It is the only sentence anyone is waiting for, and Claude's opening
 *     line is short by design — "Sure." "On it." — so a minimum length here means
 *     waiting for the *second* sentence before any sound at all.
 *   - Every sentence after it waits for `minChars`, because by then audio is
 *     already playing and the minimum buys smoother phrasing at no cost.
 *
 * Cutting the first sentence short means the queue can run dry while the second
 * request is still in flight, since requests are serial. Measured on "Sure." — a
 * second's worth of audio — the queue was empty for 66 ms, which is shorter than a
 * syllable. If a shorter opener ever makes that audible, the fix is to let one
 * request run ahead of the sentence being read, not to go back to waiting.
 *
 * One invariant under both rules: text is handed over only at a pause. A request
 * that ends mid-phrase is read with a full-sentence fall, and the next one starts
 * with a fresh rise, so the seam is audible however fast the audio arrives — heard
 * on a 209-character opening sentence, cut at the cap a few words in. So the cap is
 * not a cutter. `maxWaitMs` after a chunk starts waiting it *widens what counts as
 * a pause*, from a full stop to a clause break — comma, dash, colon — and the same
 * scan then cuts at the last of those. Prose meant to be spoken has one every few
 * words, so the ceiling holds within a beat of where it was, and the fragment ends
 * on a breath. Text with no pause in it at all is not speech and waits for the
 * turn's end, where `flush` sends it whole.
 *
 * The timer is per chunk: it starts when the buffer stops being empty and is not
 * restarted by later text. Restarting it meant it never fired while Claude
 * streamed, so a reply slow to reach a full stop was not read until the turn ended.
 */
function sentenceBuffer(onFlush: (text: string) => void, minChars = 40, maxWaitMs = 1000) {
  let buf = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false; // a sentence of this turn has already been sent
  let overdue = false; // this chunk has waited the cap: a clause break is a pause too
  const stopTimer = () => { if (timer) { clearTimeout(timer); timer = undefined; } };
  const emit = (text: string) => { started = true; onFlush(text); };
  /** Where the buffer can be cut: the pauses admissible right now, and which one.
   *  The first sentence cuts at the *first* full stop and the rest at the last: one
   *  is racing to make a sound, the others are filling a queue that is already
   *  playing, and a longer request there is cheaper than a chopped one. Overdue, the
   *  first sentence takes the last pause too — everything buffered has waited. */
  const pause = (): number => {
    const marks = overdue ? '.!?,;:—' : '.!?';
    let at = -1;
    for (let i = 0; i < buf.length; i++) {
      if (marks.includes(buf[i]!) && (i === buf.length - 1 || buf[i + 1] === ' ' || buf[i + 1] === '\n')) {
        at = i;
        if (!started && !overdue) break;
      }
    }
    return at;
  };
  /** Cut if there is a pause worth cutting at, and keep the cap armed if not. */
  const scan = (): void => {
    const at = pause();
    if (at >= 0 && (!started || at + 1 >= minChars)) {
      const chunk = buf.slice(0, at + 1).trim();
      buf = buf.slice(at + 1).trimStart();
      stopTimer();
      overdue = false;
      emit(chunk);
    }
    // The first chunk's wait is the listener's; a later chunk's is the queue's, and
    // synthesis outruns playback three to one, so it can hold out for the full stop
    // three times as long before a clause break has to do.
    if (buf && !timer && !overdue) timer = setTimeout(() => { timer = undefined; overdue = true; scan(); }, started ? 3 * maxWaitMs : maxWaitMs);
    else if (!buf) stopTimer();
  };
  return {
    push(text: string) {
      buf += text;
      scan();
    },
    /** No more text this turn: the tail is the end of the reply, which is a pause by
     *  definition, so it goes as it is — and the next sentence is a first one again. */
    flush() {
      stopTimer();
      if (buf.trim()) emit(buf.trim());
      buf = '';
      started = overdue = false;
    },
    clear() { stopTimer(); buf = ''; started = overdue = false; },
  };
}

// --- CLI: run alone ---------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = process.argv.slice(2).join(' ');
  if (!text) { console.error('usage: node voice.ts "text to read"'); process.exit(1); }
  const ai = new GoogleGenAI({ apiKey: process.env['GEMINI_API_KEY'] });
  const model = process.env['VOICE_MODEL'] ?? 'gemini-3.1-flash-tts-preview';
  const chunks: Buffer[] = [];
  let first = 0;
  const t0 = performance.now();
  const voice = openVoice(ai, model, {
    log: console.log,
    onPcm: (pcm) => { if (!first) first = Math.round(performance.now() - t0); chunks.push(pcm); },
    onDone: () => {
      const pcm = Buffer.concat(chunks);
      writeFileSync('reply.pcm', pcm);
      console.log(`first audio ${first}ms, ${(pcm.length / 48 / 1000).toFixed(1)}s of voice → reply.pcm`);
      console.log('play: afconvert reply.pcm -f WAVE -d LEI16@24000 -c 1 reply.wav && afplay reply.wav');
      voice.close();
      process.exit(0);
    },
  });
  voice.say(text);
  voice.finish();
  setTimeout(() => { console.error('timed out'); process.exit(1); }, 30_000);
}
