/**
 * A Gemini Live session used as nothing but ears: audio in, text out.
 *
 * The alternative to `ears.ts`. That one is a small agent — it transcribes, then
 * decides, then emits a `converse` function call. This one only transcribes, and the
 * finalized transcript IS the instruction. What that buys, measured on this repo:
 * roughly five times fewer transcription errors, first text on screen twice as
 * early, and the ~1.6s the function call cost is simply gone.
 *
 * Two signals, and the model draws the line between them itself:
 *   onPartial  the whole utterance as currently understood, revised as you speak
 *   onFinal    that utterance, finished — the only flush signal there is
 *
 * `onPartial` carries the full text every time, not a delta, because a hypothesis
 * revises itself ("what is the letter" → "what is the latest"). Callers replace
 * rather than append.
 *
 *   node listen.ts --file turn.wav      feed a 16 kHz mono recording, print events
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import type { Correction } from './corrections.ts';

export interface Listener {
  send(pcm: Buffer): void;
  close(): void;
}

export interface ListenerCallbacks {
  onPartial(text: string): void;
  onFinal(text: string): void;
  log?(m: string): void;
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

export async function openListen(
  ai: GoogleGenAI,
  model: string,
  cb: ListenerCallbacks,
  corrections: Correction[] = [],
): Promise<Listener> {
  const log = cb.log ?? (() => {});
  let session: Session | null = null;
  let closed = false;
  // Connecting takes ~1s; audio that arrives meanwhile is held, not dropped.
  const backlog: Buffer[] = [];
  const forward = (pcm: Buffer) =>
    session?.sendRealtimeInput({ audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });

  const vocab = vocabulary(corrections);
  const t0 = performance.now();
  session = await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.TEXT],
      inputAudioTranscription: vocab.length ? { customVocabulary: vocab } : {},
    },
    callbacks: {
      onopen: () => log(`listen connected (${Math.round(performance.now() - t0)}ms)${vocab.length ? `, ${vocab.length} phrases biased` : ''}`),
      onmessage: (msg: LiveServerMessage) => {
        if (process.env['DEBUG']) log(`raw: ${JSON.stringify(msg).slice(0, 300)}`);
        const sc = msg.serverContent;
        if (!sc) return;
        const partial = sc.interimInputTranscription?.text;
        if (partial) cb.onPartial(partial);
        // The finalized transcript. It arrives only when the utterance is over, so
        // it is both the text and the "they are done talking" signal.
        const final = sc.inputTranscription?.text;
        if (final) cb.onFinal(final);
      },
      onerror: (e) => log(`listen error: ${e.message}`),
      onclose: (e) => { closed = true; session = null; log(`listen closed: ${e.reason || e.code}`); },
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

// --- CLI: run alone ---------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--file');
  const file = at >= 0 ? process.argv[at + 1] : undefined;
  if (!file) { console.error('usage: node listen.ts --file turn.wav   (16 kHz Int16 mono)'); process.exit(1); }
  const wav = readFileSync(file);
  const pcm = wav.subarray(wav.indexOf('data') + 8);
  const ai = new GoogleGenAI({ apiKey: process.env['GEMINI_API_KEY'] });
  const model = process.env['LISTEN_MODEL'] ?? 'gemini-3.5-transcribe-live';
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const listener = await openListen(ai, model, {
    log: console.log,
    onPartial: (t) => console.log(`${ms()}ms  partial: ${t}`),
    onFinal: (t) => { console.log(`${ms()}ms  FINAL:   ${t}`); listener.close(); process.exit(0); },
  });
  const FRAME = 640;
  for (let i = 0; i < pcm.length; i += FRAME) {
    listener.send(pcm.subarray(i, i + FRAME));
    await new Promise((r) => setTimeout(r, 20));
  }
  const silence = Buffer.alloc(FRAME);
  const keep = setInterval(() => listener.send(silence), 20);
  setTimeout(() => { clearInterval(keep); listener.close(); process.exit(1); }, 12_000);
}
