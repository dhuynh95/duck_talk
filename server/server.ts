/**
 * Voice relay: one WebSocket per phone, one Session behind it (ears + Claude + voice).
 *
 *   ↑ binary  raw PCM Int16 LE, 16 kHz, mono          (mic)
 *   ↑ text    {"type":"mark","name","at"}             a moment only the phone can see
 *             {"type":"approve","text"?} / {"type":"reject"}   decide a held instruction
 *             {"type":"mute","on":bool}               output mute
 *   ↓ binary  raw PCM Int16 LE, 24 kHz, mono          (Claude's voice)
 *   ↓ text    {"type":"user"|"model"|"tool"|"approval"|"interrupted"|"turn_end"|"error","text"?}
 *
 * `?echo=1` sends binary frames straight back and never opens a session — the phone
 * half by itself. `?mode=review` holds each instruction for a spoken yes/no before
 * Claude runs; the default is direct.
 *
 * Every finished turn is appended to `.turns.jsonl`. The phone, this relay and the
 * test harness all run on one Mac, so those timestamps share one clock and any
 * latency is a subtraction, never a measurement.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { GoogleGenAI } from '@google/genai';
import { Session, type Mode, type Phone } from './session.ts';
import { billingMode } from './claude.ts';

const PORT = Number(process.env['PORT'] ?? 8765);
const MODEL = process.env['GEMINI_MODEL'] ?? 'gemini-3.1-flash-live-preview';
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
  const echo = url.searchParams.get('echo') === '1';
  const mode: Mode = url.searchParams.get('mode') === 'review' ? 'review' : 'direct';
  const log = (msg: string) => console.log(`[${id}] ${msg}`);
  log(`open${echo ? ' (echo)' : ` (${mode})`}`);

  if (echo) {
    ws.on('message', (data) => ws.send(data));
    ws.on('close', () => log('close'));
    return;
  }

  const phone: Phone = {
    pcm: (buf) => { if (ws.readyState === ws.OPEN) ws.send(buf); },
    event: (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
  };
  const session = new Session(phone, ai, MODEL, mode, log);

  ws.on('message', (data, isBinary) => {
    if (isBinary) session.send(data as Buffer);
    else { const f = parse(String(data)); if (f) session.frame(f); }
  });
  ws.on('close', () => { log('close'); void session.close(); });

  session.open().catch((e) => {
    phone.event({ type: 'error', text: String(e) });
    log(`open failed: ${e}`);
    ws.close();
  });
});

console.log(`voice relay on ws://localhost:${PORT}  model=${MODEL}`);
console.log(`claude: ${billingMode()}`);

function parse(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
}
