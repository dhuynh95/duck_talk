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
 * A session is in one `?mode=`: `direct` (default) runs each instruction at once,
 * `review` holds it for a yes/no/edit first, `echo` sends binary frames straight
 * back and never opens Gemini — the phone half by itself. Orthogonal to all three,
 * `?correct=1` has a fast text model fix the instruction first, from the pairs a
 * review-mode edit taught (`.corrections.jsonl`). `?readback=1` also reads a held
 * instruction aloud, for deciding without looking at the screen.
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
// Two Gemini sessions, two jobs, two models. The ears model is pinned to a
// native-audio one because only those stream the transcript word by word as you
// speak; the newer flash-live models send it in one piece at the end, so the screen
// stays blank until the turn is routed. The voice model only has to read text back.
const EARS_MODEL = process.env['EARS_MODEL'] ?? 'gemini-2.5-flash-native-audio-preview-12-2025';
const VOICE_MODEL = process.env['VOICE_MODEL'] ?? 'gemini-3.1-flash-live-preview';
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

  const phone: Phone = {
    pcm: (buf) => { if (ws.readyState === ws.OPEN) ws.send(buf); },
    event: (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
  };
  const session = new Session(phone, ai, mode, { earsModel: EARS_MODEL, voiceModel: VOICE_MODEL, autocorrect, readback }, log);

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

console.log(`voice relay on ws://localhost:${PORT}\n  ears=${EARS_MODEL}\n  voice=${VOICE_MODEL}`);
console.log(`claude: ${billingMode()}`);

function parse(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
}
