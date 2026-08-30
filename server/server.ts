/**
 * Voice relay: one WebSocket per phone, one Session behind it (ears + Claude + voice).
 *
 *   ↑ binary  raw PCM Int16 LE, 16 kHz, mono          (mic)
 *   ↑ text    {"type":"mark","name","at"}             a moment only the phone can see
 *             {"type":"approve","text"?} / {"type":"reject"}   decide a held instruction
 *   ↓ binary  raw PCM Int16 LE, 24 kHz, mono          (Claude's voice)
 *   ↓ text    {"type":"user"|"model"|"tool"|"approval"|"interrupted"|"turn_end"|"error","text"?}
 *             a `user` event also carries `partial`: true replaces the line, false ends it
 *
 * A session is in one `?mode=`: `direct` (default) runs each instruction at once,
 * `review` holds it for a yes/no/edit first. Orthogonal to both, `?correct=1` has a
 * fast text model fix the instruction first, from the pairs a review-mode edit
 * taught (`.corrections.jsonl`). `?readback=1` also reads a held instruction aloud,
 * for deciding without looking at the screen. `?resume=<id>` carries on a past chat
 * instead of starting one — any session Claude Code has in this project, including
 * the ones you started in a terminal.
 *
 * `?data=1` is a connection that reads and edits what the relay can see and nothing
 * else — the corrections, the prompts it says to each model, and the chats — so the
 * phone can show those screens with no voice session running. Every message is answered
 * with all of it, so the phone never has to ask twice or guess what the files now
 * say. The exception is one chat's messages, which are only sent when asked for by
 * `chat_open`, because they are the one part that is not small. `fork` branches a
 * chat at one message and answers with the new one, which is `chat_open` on it.
 *
 * Every finished turn is appended to `.turns.jsonl`. The phone, this relay and the
 * test harness all run on one Mac, so those timestamps share one clock and any
 * latency is a subtraction, never a measurement.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { GoogleGenAI } from '@google/genai';
import { Session, type Mode, type Phone } from './session.ts';
import { billingMode } from './claude.ts';
import { chat, chats, fork } from './chats.ts';
import { load, remove, save } from './corrections.ts';
import { all as prompts, isName, write as writePrompt } from './prompts.ts';

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
  const mode: Mode = asked === 'review' ? 'review' : 'direct';
  const autocorrect = url.searchParams.get('correct') === '1';
  const readback = url.searchParams.get('readback') === '1';
  // A chat to carry on rather than start. The id came from this relay's own turn
  // records, so it is one Claude Code can resume in this `cwd`.
  const resume = url.searchParams.get('resume') ?? undefined;
  const log = (msg: string) => console.log(`[${id}] ${msg}`);
  log(`open (${mode}${autocorrect ? ', autocorrect' : ''}${readback ? ', readback' : ''}${resume ? `, resuming ${resume}` : ''})`);

  // `?data=1` edits what the relay owns and nothing else — no Gemini, no Claude — so
  // the phone can open those screens whether or not a session is live. Every message
  // is answered with all of it, so the phone never has to guess what the files say.
  if (url.searchParams.get('data') === '1') {
    ws.on('message', async (raw, isBinary) => {
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
      } else if (f?.['type'] === 'prompt_save' && isName(f['name'])) {
        writePrompt(f['name'], String(f['text'] ?? ''));
        log(`prompt saved: ${f['name']}`);
      }
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: 'corrections', items: load() }));
      // Every prompt with its text, and with when it takes effect — so the phone can
      // grey out one it cannot usefully change without knowing what any of them are.
      ws.send(JSON.stringify({ type: 'prompts', prompts: prompts() }));
      // Branching a chat has to happen before the list is sent, or the new one is
      // missing from the answer that reports it.
      let forked: string | null = null;
      if (f?.['type'] === 'fork' && typeof f['id'] === 'string' && typeof f['at'] === 'string') {
        try {
          forked = await fork(f['id'], f['at']);
          log(`forked ${f['id']} at ${f['at']} -> ${forked}`);
        } catch (e) {
          log(`fork failed: ${e}`);
        }
      }
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: 'chats', chats: await chats() }));
      // The list is small and always sent; a chat's messages are not, so they come
      // only when one is opened — or when a fork has just made one worth opening.
      const open = forked ?? (f?.['type'] === 'chat_open' && typeof f['id'] === 'string' ? f['id'] : null);
      if (open) {
        ws.send(JSON.stringify({ type: 'chat', id: open, messages: await chat(open), forked: forked !== null }));
      }
    });
    ws.on('close', () => log('close'));
    return;
  }

  const phone: Phone = {
    pcm: (buf) => { if (ws.readyState === ws.OPEN) ws.send(buf); },
    event: (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
  };
  const session = new Session(phone, ai, mode, { sttModel: STT_MODEL, voiceModel: VOICE_MODEL, autocorrect, readback, resume }, log);

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
