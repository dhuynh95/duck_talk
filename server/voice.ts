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
 * finished a paragraph.
 *
 * How the reply is read — brisk, slow, whatever — is a line of text the phone saves
 * and this file puts in front of each sentence. The API has no rate parameter; the
 * wording is the whole knob, and it is worth about 1.5x in either direction.
 *
 * Lifted from src/client/routes/live/tts-session.ts + buffer.ts.
 *
 *   node voice.ts "Hello there. How are you?"     write reply.pcm, print timings
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';

/** Which voice Claude speaks in. Any of the prebuilt names. */
const VOICE_NAME = 'Sulafat';

// How the reply should be read, said to the model ahead of the text itself. This is
// the only speed control there is — the API has no rate parameter, and the wording
// does the work: measured over the same paragraph, plain reads at 66 ms/character,
// "Read this at a brisk, quick pace" at 44, "Read this slowly" at 95.
//
// The file is the truth and is read per sentence rather than cached, so editing it
// from the phone changes how the *next* sentence sounds, mid-conversation, with
// nothing to invalidate and no reconnect.
const STYLE_FILE = new URL('./.voice.txt', import.meta.url).pathname;

/** How to read the reply, as last saved. Empty when nothing has been set. */
export function readStyle(): string {
  try {
    return readFileSync(STYLE_FILE, 'utf8').trim();
  } catch {
    return ''; // no style yet is the normal first-run state
  }
}

export function writeStyle(style: string): void {
  writeFileSync(STYLE_FILE, style.trim());
}

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
  /** Drop what is queued and what is still coming for this turn. */
  interrupt(): void;
  close(): void;
}

export interface VoiceCallbacks {
  onPcm(pcm: Buffer): void;
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
  // when the reply finishes being *heard* is a subtraction rather than a guess.
  let firstAt = 0; // when this turn's first byte went out
  let playedMs = 0; // how much audio this turn has sent, in milliseconds of playback

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
      const style = readStyle();
      const contents = style ? `${style}\n\n${text}` : text;
      let spoke = false; // audio for this sentence has reached the phone
      let failure: unknown = null;
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
              spoke = true;
              firstAt ||= Date.now();
              playedMs += pcm.length / 48;
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
    if (finishing && !closed) await sleep(firstAt + playedMs - Date.now(), aborter.signal);
    reading = false;
    if (queue.length) return void pump(); // more text arrived while the tail played
    if (finishing && !closed) {
      finishing = false;
      firstAt = 0;
      playedMs = 0;
      cb.onDone?.();
    }
  }

  return {
    say(text) {
      if (closed) return;
      buf.push(text);
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
      firstAt = 0;
      playedMs = 0;
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

/** Accumulate streamed text; emit at `. ! ?` boundaries once `minChars` are in, or after `maxWaitMs`. */
function sentenceBuffer(onFlush: (text: string) => void, minChars = 40, maxWaitMs = 1000) {
  let buf = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTimer = () => { if (timer) { clearTimeout(timer); timer = undefined; } };
  const flush = () => { stopTimer(); if (buf.trim()) { onFlush(buf.trim()); buf = ''; } };
  return {
    push(text: string) {
      buf += text;
      let last = -1;
      for (let i = 0; i < buf.length; i++) {
        if ('.!?'.includes(buf[i]!) && (i === buf.length - 1 || buf[i + 1] === ' ' || buf[i + 1] === '\n')) last = i;
      }
      if (last >= 0 && last + 1 >= minChars) {
        const chunk = buf.slice(0, last + 1).trim();
        buf = buf.slice(last + 1).trimStart();
        stopTimer();
        onFlush(chunk);
      }
      stopTimer();
      if (buf) timer = setTimeout(flush, maxWaitMs);
    },
    flush,
    clear() { stopTimer(); buf = ''; },
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
