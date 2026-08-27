/**
 * Voice relay: one WebSocket per phone session, one Gemini Live session behind it.
 *
 *   ↑ binary  raw PCM Int16 LE, 16 kHz, mono          (mic)
 *   ↓ binary  raw PCM Int16 LE, 24 kHz, mono          (Gemini voice)
 *   ↓ text    {"type":"user"|"model"|"interrupted"|"error","text"?:string}
 *
 * `?echo=1` sends binary frames straight back and never opens Gemini —
 * that tests the phone half by itself.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';

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
  const echo = new URL(req.url ?? '/', 'ws://x').searchParams.get('echo') === '1';
  const log = (msg: string) => console.log(`[${id}] ${msg}`);
  log(`open${echo ? ' (echo)' : ''}`);

  if (echo) {
    ws.on('message', (data) => ws.send(data));
    ws.on('close', () => log('close'));
    return;
  }

  void relay(ws, log).catch((e) => {
    send(ws, { type: 'error', text: String(e) });
    log(`gemini connect failed: ${e}`);
    ws.close();
  });
});

console.log(`voice relay on ws://localhost:${PORT}  model=${MODEL}`);

// --- One relay: pipe phone audio into Gemini and Gemini back to the phone ---

async function relay(ws: WebSocket, log: (m: string) => void): Promise<void> {
  let up = 0;
  let down = 0;
  let speechEndedAt = 0; // latency instrument: inputTranscription → first audio

  // Gemini takes ~1s to accept the setup; audio that arrives meanwhile is held, not dropped.
  let session: Session | null = null;
  const backlog: Buffer[] = [];
  const forward = (pcm: Buffer) =>
    session?.sendRealtimeInput({
      audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
    });

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const pcm = data as Buffer;
    up += pcm.length;
    if (session) forward(pcm);
    else backlog.push(pcm);
  });

  ws.on('close', () => {
    log(`close  ↑${kb(up)}  ↓${kb(down)}`);
    session?.close();
  });

  session = await ai.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
    callbacks: {
      onopen: () => log('gemini connected'),
      onmessage: (msg: LiveServerMessage) => {
        if (process.env['DEBUG']) log(`raw: ${JSON.stringify(msg).slice(0, 400)}`);
        const sc = msg.serverContent;
        if (!sc) return;

        if (sc.interrupted) {
          send(ws, { type: 'interrupted' });
          log('interrupted');
        }
        if (sc.inputTranscription?.text) {
          speechEndedAt = performance.now();
          send(ws, { type: 'user', text: sc.inputTranscription.text });
          log(`user: ${sc.inputTranscription.text}`);
        }
        if (sc.outputTranscription?.text) {
          send(ws, { type: 'model', text: sc.outputTranscription.text });
        }
        for (const part of sc.modelTurn?.parts ?? []) {
          const b64 = part.inlineData?.data;
          if (!b64) continue;
          if (speechEndedAt) {
            log(`first audio ${Math.round(performance.now() - speechEndedAt)}ms after speech`);
            speechEndedAt = 0;
          }
          const pcm = Buffer.from(b64, 'base64');
          down += pcm.length;
          ws.send(pcm);
        }
      },
      onerror: (e) => {
        send(ws, { type: 'error', text: e.message });
        log(`gemini error: ${e.message}`);
      },
      onclose: (e) => {
        log(`gemini closed: ${e.reason || e.code}`);
        ws.close();
      },
    },
  });

  if (ws.readyState !== ws.OPEN) {
    session.close();
    return;
  }
  backlog.splice(0).forEach(forward);
}

function send(ws: WebSocket, msg: { type: string; text?: string }): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function kb(n: number): string {
  return `${(n / 1024).toFixed(0)}KB`;
}
