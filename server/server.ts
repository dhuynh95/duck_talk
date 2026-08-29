/**
 * Voice relay: one WebSocket per phone, one Session behind it (ears + Claude + voice).
 *
 *   ↑ binary  raw PCM Int16 LE, 16 kHz, mono          (mic)
 *   ↑ text    {"type":"mark","name","at"}             a moment only the phone can see
 *             {"type":"approve","text"?} / {"type":"reject"}   decide a held instruction
 *             {"type":"mute","on":bool}               output mute
 *   ↓ binary  raw PCM Int16 LE, 24 kHz, mono          (Claude's voice)
 *   ↓ text    {"type":"user"|"model"|"tool"|"approval"|"interrupted"|"turn_end"|"error","text"?}
 *             a `user` event also carries `partial`: true replaces the line, false ends it
 *
 * A session is in one `?mode=`: `direct` (default) runs each instruction at once,
 * `review` holds it for a yes/no/edit first, `echo` sends binary frames straight
 * back and never opens Gemini — the phone half by itself. Orthogonal to all three,
 * `?correct=1` has a fast text model fix the instruction first, from the pairs a
 * review-mode edit taught (`.corrections.jsonl`). `?readback=1` also reads a held
 * instruction aloud, for deciding without looking at the screen.
 *
 * `?data=1` is a connection that only reads and edits `.corrections.jsonl`, so the
 * phone can show that screen without a voice session running.
 *
 * Every finished turn is appended to `.turns.jsonl`. The phone, this relay and the
 * test harness all run on one Mac, so those timestamps share one clock and any
 * latency is a subtraction, never a measurement.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { GoogleGenAI } from '@google/genai';
import { Session, type Mode, type Phone } from './session.ts';
import { billingMode } from './claude.ts';
import { load, remove, save } from './corrections.ts';

const PORT = Number(process.env['PORT'] ?? 8765);
// Two jobs, two models: one Live session transcribes what you say, and a
// text-to-speech model reads Claude's answer back a sentence at a time. Only the
// first is a session — see voice.ts for why the reader is better off without one.
const STT_MODEL = process.env['STT_MODEL'] ?? 'gemini-3.5-transcribe-live';
const VOICE_MODEL = process.env['VOICE_MODEL'] ?? 'gemini-3.1-flash-tts-preview';
const API_KEY = process.env['GEMINI_API_KEY'];
if (!API_KEY) {
  console.error('GEMINI_API_KEY missing (set it in ../.env)');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });
const wss = new WebSocketServer({ port: PORT });
let nextId = 1;

wss.on('connection', (ws, req) => {
  const id = nextId++;
  const url = new URL(req.url ?? '/', 'ws://x');
  const asked = url.searchParams.get('mode');
  const mode: Mode = asked === 'review' || asked === 'echo' ? asked : 'direct';
  const autocorrect = url.searchParams.get('correct') === '1';
  const readback = url.searchParams.get('readback') === '1';
  const log = (msg: string) => console.log(`[${id}] ${msg}`);
  log(`open (${mode}${autocorrect ? ', autocorrect' : ''}${readback ? ', readback' : ''})`);

  if (mode === 'echo') {
    ws.on('message', (data) => ws.send(data));
    ws.on('close', () => log('close'));
    return;
  }

  // `?data=1` reads and edits the corrections and nothing else — no Gemini, no
  // Claude — so the phone can open that screen whether or not a session is live.
  // Every message is answered with the whole list, so the phone never has to guess
  // what the file now says.
  if (url.searchParams.get('data') === '1') {
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const f = parse(String(raw));
      if (f?.['type'] === 'correction_save') {
        const at = typeof f['at'] === 'number' ? f['at'] : Date.now();
        const heard = String(f['heard'] ?? '').trim();
        const meant = String(f['meant'] ?? '').trim();
        if (heard && meant) { save({ at, heard, proposed: String(f['proposed'] ?? heard), meant }); log(`correction saved: ${heard} → ${meant}`); }
      } else if (f?.['type'] === 'correction_delete' && typeof f['at'] === 'number') {
        remove(f['at']);
        log(`correction deleted`);
      }
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'corrections', items: load() }));
    });
    ws.on('close', () => log('close'));
    return;
  }

  const phone: Phone = {
    pcm: (buf) => { if (ws.readyState === ws.OPEN) ws.send(buf); },
    event: (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
  };
  const session = new Session(phone, ai, mode, { sttModel: STT_MODEL, voiceModel: VOICE_MODEL, autocorrect, readback }, log);

  ws.on('message', (data, isBinary) => {
    if (isBinary) session.send(data as Buffer);
    else { const f = parse(String(data)); if (f) session.frame(f); }
  });
  ws.on('close', () => { log('close'); void session.close().catch((e) => log(`close failed: ${e}`)); });

  session.open().catch((e) => {
    phone.event({ type: 'error', text: String(e) });
    log(`open failed: ${e}`);
    ws.close();
  });
});

// One session's bad moment must not disconnect every phone. Node exits on an
// uncaught error by default; here the connection that caused it is already broken,
// and the others are not, so log loudly and keep serving.
process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

console.log(`voice relay on ws://localhost:${PORT}\n  stt=${STT_MODEL}\n  voice=${VOICE_MODEL}`);
console.log(`claude: ${billingMode()}`);

function parse(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
}
