/**
 * A Gemini Live session used as nothing but ears: audio in, text out.
 *
 * This used to be an agent — it transcribed, then decided, then emitted a `converse`
 * function call. Measured against plain transcription on 15 phrases it lost on every
 * axis: five times the word errors ("what branch am I on" came back as "What brand
 * Jimmy on?"), first text on screen twice as late, and the function call itself cost
 * ~1.6s, because the transcript was complete at ~674ms but the call did not arrive
 * until ~2260ms. So the deciding is gone and the transcript is the instruction.
 *
 * Two signals, and the model draws the line between them itself:
 *   onPartial  the whole utterance as currently understood, revised as you speak
 *   onFinal    that utterance, finished — the only flush signal there is
 *
 * `onPartial` carries the full text every time, not a delta, because a hypothesis
 * revises itself ("what is the letter" → "what is the latest"). Callers replace
 * rather than append.
 *
 * The line is drawn by silence, and it is drawn fast — see SILENCE_MS — so a pause
 * for thought inside a sentence ends it early. A final that comes soon enough after
 * the last one is therefore the rest of that sentence, and is stitched back onto it
 * here: a final is always a whole utterance, and the caller never sees the seam.
 *
 * A final also carries the audio it was made from. Every byte went out through this
 * file, and 16 kHz Int16 is 32 bytes per millisecond, so where an utterance began and
 * ended in the stream is a subtraction rather than a measurement — the same trick the
 * turn timings use. The model has no word timestamps to offer here (asked for, and
 * `gemini-3.5-transcribe-live` returns none), so the two transcript signals are the
 * clock: the first partial says speech had started, the final says it has stopped.
 *
 *   node ears.ts --file turn.wav      feed a 16 kHz mono recording, print events
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import { wav } from './clips.ts';
import { terms, type Correction } from './corrections.ts';

export interface Ears {
  send(pcm: Buffer): void;
  close(): void;
}

export interface EarsCallbacks {
  /** `continuing` is the JOIN decision below, said out loud: this utterance carries on
   *  the previous final rather than starting something new. The text was always
   *  stitched accordingly; the caller needs the same fact, because an instruction
   *  still being spoken is not a barge-in. */
  onPartial(text: string, continuing: boolean): void;
  /** The finished utterance, and the audio it was made from — null only if the stream
   *  buffer no longer reaches back that far, which takes a minute of speech. */
  onFinal(text: string, clip: Buffer | null): void;
  /** The server hung up — a session that hit Gemini's duration limit, or a dropped
   *  network. Never called for a close() of our own. The model offers no way around
   *  it (`sessionResumption` is ignored by the transcribe model — measured), so the
   *  recovery is the caller's open path, run again. */
  onClosed?(): void;
  log?(m: string): void;
}

// How much quiet ends an utterance. Unset, the model waits about two seconds after
// the text has stopped changing before it commits it — measured on recordings with
// a real noise floor, the final came 2199ms after speech, 1990ms of it spent
// re-sending an unchanged hypothesis. At 200ms it comes at 467ms. The price is that
// a pause for thought now ends the sentence, which is what the join below repays.
// `endOfSpeechSensitivity` is deliberately not set: alongside 200 it measured slower.
const SILENCE_MS = 200;

// A final arriving this soon after the last one continues it rather than starting
// something new. Derived, not chosen: the reply's first sound reaches the listener
// about two seconds after a final (Claude ~0.9s, sentence buffer ~0.5s, voice
// ~0.75s, from the turn log), so speech inside that window cannot be an answer to
// anything heard — it is the rest of the same thought. A longer pause is not joined;
// the tail reaches Claude on its own, and Claude's own transcript holds the head.
const JOIN_MS = 2000;

// 16 kHz Int16 mono. The one conversion between "how many bytes have gone out" and
// "where are we in the stream", and the reason a clip is a subtraction.
const BYTES_PER_MS = 32;

// How far back the stream can be sliced. An utterance is seconds; this is a minute,
// which covers the longest thing anyone says in one breath plus every pause a JOIN
// stitches across, and costs about 2 MB.
const BUFFER_MS = 60_000;

// Where an utterance starts is not something the partials can tell us. The first one
// arrives when the model has committed a hypothesis, and how long that takes is the
// thing the clip exists to investigate: measured, 220ms after speech on fixtures/
// fluent.wav and 1780ms on fixtures/mumble.wav — the same sentence, badly articulated.
// A pad tuned to one clips the first word off the other.
//
// So the start is the boundary that needs no tuning: the end of the utterance before
// it. Between two finals, everything is this utterance by definition — including the
// quiet before it, which costs a moment of room tone and never costs a word.
//
// Capped, because a clip is an utterance and not the wait before one: someone silent
// for a minute and then speaking gets a few seconds of lead-in, not the minute.
const MAX_LEAD_MS = 4_000;

// The tail needs no such care: the final arrives about 650ms after speech stops, 200ms
// of which is SILENCE_MS, so trimming a little brings the end back towards the last
// word without reaching it.
const TAIL_TRIM_MS = 350;

/** A vocabulary as one readable line — seeing what is in it is the whole point. */
function oneLine(vocab: string[]): string {
  const line = vocab.join(', ');
  return line.length <= 160 ? line : `${line.slice(0, 159)}…`;
}

/**
 * `b` continuing `a`: the sentence rejoined. Each fragment was punctuated as a
 * sentence of its own — a full stop on the head, a capital on the tail — and both
 * go, or the seam shows.
 */
function join(a: string, b: string): string {
  return a ? `${a.replace(/[.?!]+$/, '')} ${b.charAt(0).toLowerCase()}${b.slice(1)}` : b;
}

export async function openEars(
  ai: GoogleGenAI,
  model: string,
  cb: EarsCallbacks,
  corrections: Correction[] = [],
): Promise<Ears> {
  const log = cb.log ?? (() => {});
  let session: Session | null = null;
  let closed = false;
  // Connecting takes ~1s; audio that arrives meanwhile is held, not dropped.
  const backlog: Buffer[] = [];
  // Kept as it is sent, so the buffer holds exactly what Gemini was given — the whole
  // claim a clip makes.
  const forward = (pcm: Buffer) => {
    keep(pcm);
    session?.sendRealtimeInput({ audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
  };

  // The utterance before this one, kept in case this one turns out to continue it.
  let prefix = '';
  let finalAt = 0;
  let speaking = false;
  // The JOIN decision for the utterance now being spoken, held for its whole length —
  // every partial of one utterance says the same thing.
  let joined = false;

  // --- The stream as something that can be sliced --------------------------
  //
  // Everything sent is kept for a minute, with `baseMs` saying where the kept part
  // starts — the position itself grows for the life of the session, so an offset into
  // the buffer is never an offset into the stream.
  const kept: Buffer[] = [];
  let keptBytes = 0;
  let baseMs = 0;
  let sentMs = 0;
  // Where the utterance now being spoken began, and where the one before it ended.
  // `utteranceAt` is set on the first partial and held for the whole utterance, JOIN
  // included — the same decision, and the same reason, as `prefix` above: a long tail
  // must not lose its head.
  let utteranceAt: number | null = null;
  let lastEndMs = 0;
  // What the session made of everything it was sent, reported when it closes. Both
  // numbers are byte counts on the one clock, so the difference is exact.
  let coveredMs = 0;
  let transcripts = 0;

  function keep(pcm: Buffer): void {
    kept.push(pcm);
    keptBytes += pcm.length;
    sentMs += pcm.length / BYTES_PER_MS;
    while (keptBytes - kept[0]!.length > BUFFER_MS * BYTES_PER_MS) {
      const dropped = kept.shift()!;
      keptBytes -= dropped.length;
      baseMs += dropped.length / BYTES_PER_MS;
    }
  }

  /** The audio between two stream positions, or null if it has already scrolled off. */
  function slice(fromMs: number, toMs: number): Buffer | null {
    if (fromMs < baseMs || toMs <= fromMs) return null;
    const from = Math.round((fromMs - baseMs) * BYTES_PER_MS);
    const to = Math.round((toMs - baseMs) * BYTES_PER_MS);
    return Buffer.concat(kept).subarray(from, to);
  }

  const vocab = terms(corrections);
  const t0 = performance.now();
  session = await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.TEXT],
      inputAudioTranscription: vocab.length ? { customVocabulary: vocab } : {},
      realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: SILENCE_MS } },
    },
    callbacks: {
      // The terms themselves, not how many of them: biasing is the one thing that
      // changes what comes back, and a count says nothing about whether the right
      // words are in the list.
      onopen: () => log(`ears connected (${Math.round(performance.now() - t0)}ms)${vocab.length ? `, biasing ${vocab.length}: ${oneLine(vocab)}` : ''}`),
      onmessage: (msg: LiveServerMessage) => {
        if (process.env['DEBUG']) log(`raw: ${JSON.stringify(msg).slice(0, 300)}`);
        const sc = msg.serverContent;
        if (!sc) return;
        const partial = sc.interimInputTranscription?.text;
        if (partial) {
          // Whether this utterance continues the last is settled on its first word
          // and held for its whole length, so a long tail cannot lose its head midway.
          if (!speaking) {
            speaking = true;
            joined = Date.now() - finalAt <= JOIN_MS;
            if (!joined) prefix = '';
            // A joined utterance keeps the head fragment's start, so the clip grows
            // with the text: each final's audio is the audio of the whole sentence so
            // far, exactly as `prefix` makes each final the whole sentence so far.
            if (!joined || utteranceAt === null) utteranceAt = Math.max(lastEndMs, sentMs - MAX_LEAD_MS, baseMs);
          }
          cb.onPartial(join(prefix, partial), joined);
        }
        // The finalized transcript. It arrives only when the utterance is over, so
        // it is both the text and the "they are done talking" signal.
        const final = sc.inputTranscription?.text;
        if (final) {
          const text = join(prefix, final);
          if (prefix) log(`joined: ${text}`);
          finalAt = Date.now();
          prefix = text;
          speaking = false;
          // The audio this transcript was made from, before the start is forgotten:
          // a join keeps `utteranceAt`, so the next fragment extends the same clip.
          const startMs = utteranceAt;
          const endMs = sentMs - TAIL_TRIM_MS;
          const clip = startMs === null ? null : slice(startMs, endMs);
          if (clip) log(`clip ${Math.round(startMs!)}–${Math.round(endMs)}ms of stream`);
          // Only the audio this final added. A joined fragment's clip reaches back to
          // the start of the whole sentence, so adding the spans up counts the head
          // once per fragment and can claim more audio than was ever sent.
          if (startMs !== null) { coveredMs += endMs - Math.max(startMs, lastEndMs); transcripts++; }
          lastEndMs = endMs;
          cb.onFinal(text, clip);
        }
      },
      onerror: (e) => log(`ears error: ${e.message}`),
      onclose: (e) => {
        const mine = closed; // close() sets it first, so a close we asked for stays quiet
        closed = true;
        session = null;
        log(`ears closed: ${e.reason || e.code}`);
        if (!mine) cb.onClosed?.();
      },
    },
  });
  backlog.splice(0).forEach(forward);

  return {
    send(pcm) {
      if (closed) return;
      if (session) forward(pcm);
      else backlog.push(pcm);
    },
    close() {
      if (closed) return;
      closed = true;
      // Audio in against audio the ears turned into utterances. The gap is the quiet
      // between sentences, and that is the point: it is a subtraction of two exact
      // counts rather than a detector, so a session where it goes badly wrong is
      // visible without anything having to decide what counts as speech.
      if (sentMs) {
        log(`ears heard ${(sentMs / 1000).toFixed(0)}s of audio, ${(coveredMs / 1000).toFixed(0)}s of it in ${transcripts} transcript${transcripts === 1 ? '' : 's'}`);
      }
      session?.close();
      session = null;
    },
  };
}

/** Words that mean a decision rather than an instruction. */
const ACCEPT_WORDS = ['accept', 'yes'];
const REJECT_WORDS = ['reject', 'no'];
const STOP_WORDS = ['stop', 'cancel'];
export type Keyword = 'accept' | 'reject' | 'stop';

/** The first control word in a transcript, matched per word. */
export function keyword(text: string): Keyword | null {
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    if (ACCEPT_WORDS.includes(w)) return 'accept';
    if (REJECT_WORDS.includes(w)) return 'reject';
    if (STOP_WORDS.includes(w)) return 'stop';
  }
  return null;
}

// --- CLI: run alone ---------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--file');
  const file = at >= 0 ? process.argv[at + 1] : undefined;
  if (!file) { console.error('usage: node ears.ts --file turn.wav   (16 kHz Int16 mono)'); process.exit(1); }
  const recording = readFileSync(file);
  const pcm = recording.subarray(recording.indexOf('data') + 8);
  const ai = new GoogleGenAI({ apiKey: process.env['GEMINI_API_KEY'] });
  const model = process.env['LISTEN_MODEL'] ?? 'gemini-3.5-transcribe-live';
  // Times are from the end of the recording, so "how long after I stopped talking"
  // is read straight off the line; negative means it arrived while still speaking.
  let spoken = 0;
  const ms = () => (spoken ? `${Math.round(performance.now() - spoken)}ms` : 'mid-speech');
  let finals = 0;
  const ears = await openEars(ai, model, {
    log: console.log,
    onPartial: (t) => console.log(`${ms()}  partial: ${t}`),
    // Every final, not just the first: a sentence split by a pause is two, and
    // exiting on the first is exactly how that would go unseen.
    // Every final, and the audio behind it: the clip is the thing worth checking by
    // ear, so it is written where `afplay` can reach it rather than described.
    onFinal: (t, clip) => {
      finals++;
      console.log(`${ms()}  FINAL:   ${t}`);
      if (!clip) return void console.log('         (no clip)');
      const out = `/tmp/ears-clip${finals}.wav`;
      writeFileSync(out, wav(clip));
      console.log(`         clip ${(clip.length / 32 / 1000).toFixed(1)}s → ${out}`);
    },
  });
  const FRAME = 640;
  for (let i = 0; i < pcm.length; i += FRAME) {
    ears.send(pcm.subarray(i, i + FRAME));
    await new Promise((r) => setTimeout(r, 20));
  }
  spoken = performance.now();
  // A phone keeps sending after you stop talking, and what it sends is the room, not
  // zeros — zeros are the easiest end-of-speech there is and would flatter the
  // timing. Stream the recording's own quietest stretch instead.
  const tone = roomTone(pcm);
  let k = 0;
  const keep = setInterval(() => { ears.send(tone.subarray(k, k + FRAME)); k = (k + FRAME) % (tone.length - FRAME); }, 20);
  setTimeout(() => {
    clearInterval(keep);
    ears.close();
    console.log(`${finals} final${finals === 1 ? '' : 's'}`);
    process.exit(finals ? 0 : 1);
  }, 4_000);
}

/** The quietest 200ms in a recording — its own noise floor. */
function roomTone(pcm: Buffer): Buffer {
  const win = 200 * 32; // 16 kHz Int16 is 32 bytes/ms
  let best = Infinity, at = 0;
  for (let i = 0; i + win <= pcm.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j += 32) sum += Math.abs(pcm.readInt16LE(j));
    if (sum < best) { best = sum; at = i; }
  }
  return pcm.subarray(at, at + win);
}
