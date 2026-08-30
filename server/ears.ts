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
 *   node ears.ts --file turn.wav      feed a 16 kHz mono recording, print events
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import type { Correction } from './corrections.ts';

export interface Ears {
  send(pcm: Buffer): void;
  close(): void;
}

export interface EarsCallbacks {
  onPartial(text: string): void;
  onFinal(text: string): void;
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

/**
 * `b` continuing `a`: the sentence rejoined. Each fragment was punctuated as a
 * sentence of its own — a full stop on the head, a capital on the tail — and both
 * go, or the seam shows.
 */
function join(a: string, b: string): string {
  return a ? `${a.replace(/[.?!]+$/, '')} ${b.charAt(0).toLowerCase()}${b.slice(1)}` : b;
}

/**
 * What this user is usually misheard saying, handed to the recogniser as vocabulary
 * to favour. The same corrections the routing ears get as prompt text, except here
 * they bias the acoustic model directly, which is what they were always trying to do.
 */
function vocabulary(corrections: Correction[]): string[] {
  const terms = new Set<string>();
  for (const c of corrections) if (c.meant.trim()) terms.add(c.meant.trim());
  return [...terms].slice(-100); // the docs put the useful ceiling around here
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
  const forward = (pcm: Buffer) =>
    session?.sendRealtimeInput({ audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });

  // The utterance before this one, kept in case this one turns out to continue it.
  let prefix = '';
  let finalAt = 0;
  let speaking = false;

  const vocab = vocabulary(corrections);
  const t0 = performance.now();
  session = await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.TEXT],
      inputAudioTranscription: vocab.length ? { customVocabulary: vocab } : {},
      realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: SILENCE_MS } },
    },
    callbacks: {
      onopen: () => log(`ears connected (${Math.round(performance.now() - t0)}ms)${vocab.length ? `, ${vocab.length} phrases biased` : ''}`),
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
            if (Date.now() - finalAt > JOIN_MS) prefix = '';
          }
          cb.onPartial(join(prefix, partial));
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
          cb.onFinal(text);
        }
      },
      onerror: (e) => log(`ears error: ${e.message}`),
      onclose: (e) => { closed = true; session = null; log(`ears closed: ${e.reason || e.code}`); },
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
  const wav = readFileSync(file);
  const pcm = wav.subarray(wav.indexOf('data') + 8);
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
    onFinal: (t) => { finals++; console.log(`${ms()}  FINAL:   ${t}`); },
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
