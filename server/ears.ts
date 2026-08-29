/**
 * A Gemini Live session used as ears: phone audio in, decisions out. It hears
 * (`onHeard`), routes an instruction to Claude (`onConverse`), and spots the yes /
 * no / stop words a user says while something is held or playing (`onKeyword`).
 * It never speaks — its own audio is discarded here, and if it tries anyway the
 * transcript of what it would have said goes to `onSilentSpeech` as a warning.
 *
 * Cancelling is `onKeyword('stop')` and nothing else. Gemini's own `interrupted`
 * signal means "my speech was cut off", and this session is muzzled, so it never
 * fires when it matters; a `stop` tool needed a model round-trip and always lost
 * to the transcript. Both were tried, measured, and removed.
 *
 * Lifted from src/client/routes/live/gemini.ts (routing) and voice-approval.ts
 * (keywords, which the browser matched with its own speech recognizer; here
 * Gemini's transcript is the recognizer).
 *
 *   node ears.ts --file turn.wav      feed a 16 kHz mono recording, print events
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Modality, Type, type LiveServerMessage, type Session, type Tool } from '@google/genai';
import { render, type Correction } from './corrections.ts';

const PROMPT = readFileSync(new URL('./prompts/ears.md', import.meta.url), 'utf8');

// How long Gemini waits through quiet before deciding you have stopped talking —
// its default is ~800ms, and that wait is the largest slice of the gap between a
// question ending and Claude starting. How much 500ms buys back depends on the ears
// model: ~370ms on gemini-3.1-flash-live, but within the noise on the 2.5
// native-audio model pinned above, where only 300ms measurably helps (~270ms). 300
// is not the default because it fragments the utterance — the same phrase came back
// as "Repow." instead of "In this repo." — and a clean running transcript is why the
// 2.5 model is pinned in the first place. Routing survived either way.
const VAD_SILENCE_MS = Number(process.env['VAD_SILENCE_MS'] ?? 500);

const TOOLS: Tool[] = [{
  functionDeclarations: [
    {
      name: 'converse',
      description: 'Forward a user instruction or question to Claude Code. Use this whenever the user wants Claude Code to do or answer something.',
      parameters: {
        type: Type.OBJECT,
        properties: { instruction: { type: Type.STRING, description: 'The instruction to send to Claude Code' } },
        required: ['instruction'],
      },
    },
  ],
}];

export const ACCEPT_WORDS = ['accept', 'yes'];
export const REJECT_WORDS = ['reject', 'no'];
export const STOP_WORDS = ['stop', 'cancel'];
export type Keyword = 'accept' | 'reject' | 'stop';

/** What the session does with an instruction; sent back to Gemini as the tool result. */
export type ConverseOutcome = 'done' | 'held' | 'rejected';

export interface Ears {
  send(pcm: Buffer): void;
  /** Put text into Gemini's context as its own prior speech — what the user just heard. */
  context(text: string): void;
  close(): void;
}

export interface EarsCallbacks {
  onHeard(text: string): void;
  onConverse(instruction: string): ConverseOutcome;
  onKeyword(word: Keyword): void;
  onSilentSpeech(text: string): void;
  log?(m: string): void;
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
  // Gemini takes ~1s to accept the setup; audio that arrives meanwhile is held, not dropped.
  const backlog: Buffer[] = [];
  const forward = (pcm: Buffer) =>
    session?.sendRealtimeInput({ audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });

  const t0 = performance.now();
  session = await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      tools: TOOLS,
      // What this user is usually misheard saying, so routing gets it right the
      // first time. A Live session's prompt is fixed once open — an edit made
      // during the session reaches it through `context()` instead.
      systemInstruction: PROMPT + render(corrections),
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: VAD_SILENCE_MS } },
    },
    callbacks: {
      onopen: () => log(`ears connected (${Math.round(performance.now() - t0)}ms)`),
      onmessage: (msg: LiveServerMessage) => {
        if (process.env['DEBUG']) log(`raw: ${JSON.stringify(msg).slice(0, 400)}`);

        for (const fc of msg.toolCall?.functionCalls ?? []) {
          let response: Record<string, unknown>;
          if (fc.name === 'converse') {
            const instruction = String((fc.args as { instruction?: unknown } | undefined)?.instruction ?? '');
            const outcome = cb.onConverse(instruction);
            response = outcome === 'rejected' ? { status: 'rejected' } : { result: outcome };
          } else {
            response = { error: `Unknown tool: ${fc.name}` };
          }
          // Answer at once: the tool is BLOCKING on Gemini's side, and Claude's reply
          // reaches the user through the voice session, not through this one.
          session?.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response }] });
        }

        const sc = msg.serverContent;
        if (!sc) return;
        if (sc.inputTranscription?.text) {
          const text = sc.inputTranscription.text;
          cb.onHeard(text);
          const word = keyword(text);
          if (word) cb.onKeyword(word);
        }
        // Gemini's own voice is discarded — the phone only ever hears the voice session.
        if (sc.outputTranscription?.text) cb.onSilentSpeech(sc.outputTranscription.text);
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
    context(text) {
      if (closed || !session) return;
      session.sendClientContent({ turns: [{ role: 'model', parts: [{ text }] }], turnComplete: false });
    },
    close() {
      if (closed) return;
      closed = true;
      session?.close();
      session = null;
    },
  };
}

/** First keyword in a transcript fragment, matched per word, like the browser listener did. */
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
  const model = process.env['GEMINI_MODEL'] ?? 'gemini-3.1-flash-live-preview';
  const ears = await openEars(ai, model, {
    log: console.log,
    onHeard: (t) => console.log(`heard: ${t}`),
    onConverse: (i) => { console.log(`converse: ${i}`); return 'done'; },
    onKeyword: (w) => console.log(`keyword: ${w}`),
    onSilentSpeech: (t) => console.log(`silent speech: ${t}`),
  });
  const FRAME = 640; // 20 ms
  for (let i = 0; i < pcm.length; i += FRAME) {
    ears.send(pcm.subarray(i, i + FRAME));
    await new Promise((r) => setTimeout(r, 20));
  }
  const silence = Buffer.alloc(FRAME);
  const keep = setInterval(() => ears.send(silence), 20);
  setTimeout(() => { clearInterval(keep); ears.close(); process.exit(0); }, 8_000);
}
