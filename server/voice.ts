/**
 * A Gemini Live session used as a streaming text-to-speech reader: text in,
 * 24 kHz PCM out. It never thinks; the prompt tells it to read, word for word.
 *
 * Lifted from src/client/routes/live/tts-session.ts + buffer.ts. Text is cut at
 * sentence boundaries before it goes to Gemini, so audio starts before Claude has
 * finished a paragraph. `onFlush` reports each sentence as it is sent — the caller
 * feeds those to the ears session so it knows what the user just heard.
 *
 *   node voice.ts "Hello there. How are you?"     write reply.pcm, print timings
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Modality, type Session } from '@google/genai';

const PROMPT = readFileSync(new URL('./prompts/voice.md', import.meta.url), 'utf8');

/** Which voice Claude speaks in. Any of the Live API's prebuilt names. */
const VOICE_NAME = process.env['VOICE_NAME'] ?? 'Sulafat';

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
  onFlush?(text: string): void;
  onDone?(): void;
  isMuted?(): boolean;
  log?(m: string): void;
}

export async function openVoice(ai: GoogleGenAI, model: string, cb: VoiceCallbacks): Promise<Voice> {
  const log = cb.log ?? (() => {});
  let session: Session | null = null;
  let closed = false;
  let finishing = false;
  let muted = false; // set by interrupt(): audio still in flight for the old turn is dropped
  let pendingSends = 0;
  // Gemini still finishes what it was reading after an interrupt, so its turnComplete
  // arrives late. Left to count, it would close whatever turn came next — in review
  // mode the reply, whose readback was just cancelled. Swallow one per cancelled send.
  let stale = 0;

  const sendText = (text: string) => {
    if (!session || closed) return;
    pendingSends++;
    cb.onFlush?.(text);
    session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: `[READ]: ${text}` }] }],
      turnComplete: true,
    });
  };
  const buf = sentenceBuffer(sendText);

  session = await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: PROMPT,
      outputAudioTranscription: {},
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
    },
    callbacks: {
      onopen: () => log('voice connected'),
      onmessage: (msg) => {
        const sc = msg.serverContent;
        if (!sc) return;
        for (const p of sc.modelTurn?.parts ?? []) {
          if (p.inlineData?.data && !closed && !muted && !cb.isMuted?.()) cb.onPcm(Buffer.from(p.inlineData.data, 'base64'));
        }
        if (sc.turnComplete) {
          if (stale > 0) { stale--; return; }
          pendingSends = Math.max(0, pendingSends - 1);
          if (finishing && pendingSends === 0) {
            finishing = false;
            cb.onDone?.();
          }
        }
      },
      onerror: (e) => log(`voice error: ${e.message}`),
      onclose: (e) => { closed = true; session = null; log(`voice closed: ${e.reason || e.code}`); },
    },
  });

  return {
    say(text) {
      if (closed) return;
      muted = false;
      buf.push(text);
    },
    finish() {
      if (closed) return;
      buf.flush();
      if (pendingSends === 0) cb.onDone?.();
      else finishing = true;
    },
    interrupt() {
      if (closed) return;
      muted = true;
      finishing = false;
      stale += pendingSends; // their turnCompletes are still coming; they belong to nothing
      pendingSends = 0;
      buf.clear();
    },
    close() {
      if (closed) return;
      closed = true;
      buf.clear();
      session?.close();
    },
  };
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
  const model = process.env['GEMINI_MODEL'] ?? 'gemini-3.1-flash-live-preview';
  const chunks: Buffer[] = [];
  let t0 = 0;
  let first = 0;
  const voice = await openVoice(ai, model, {
    log: console.log,
    onPcm: (pcm) => { if (!first) first = Math.round(performance.now() - t0); chunks.push(pcm); },
    onFlush: (s) => console.log(`sent: ${s}`),
    onDone: () => {
      const pcm = Buffer.concat(chunks);
      writeFileSync('reply.pcm', pcm);
      console.log(`first audio ${first}ms, ${(pcm.length / 48 / 1000).toFixed(1)}s of voice → reply.pcm`);
      console.log('play: afconvert reply.pcm -f WAVE -d LEI16@24000 -c 1 reply.wav && afplay reply.wav');
      voice.close();
      process.exit(0);
    },
  });
  t0 = performance.now();
  voice.say(text);
  voice.finish();
  setTimeout(() => { console.error('timed out'); process.exit(1); }, 30_000);
}
