/**
 * Voice relay: one WebSocket per phone session, one Gemini Live session behind it.
 *
 *   ↑ binary  raw PCM Int16 LE, 16 kHz, mono          (mic)
 *   ↑ text    {"type":"mark","name":string,"at":epoch ms}   (phone reporting a moment)
 *   ↓ binary  raw PCM Int16 LE, 24 kHz, mono          (Gemini voice)
 *   ↓ text    {"type":"user"|"model"|"interrupted"|"turn_end"|"error","text"?:string}
 *
 * `?echo=1` sends binary frames straight back and never opens Gemini —
 * that tests the phone half by itself.
 *
 * Every finished turn is also appended to `.turns.jsonl` as one JSON line: what was
 * heard and said, and the moments the turn passed through. The phone, this relay and
 * the test harness all run on one Mac, so those moments share one clock and any
 * latency is a subtraction — nothing is inferred, and nothing needs synchronising.
 */

import { appendFile } from 'node:fs/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';

const PORT = Number(process.env['PORT'] ?? 8765);
const MODEL = process.env['GEMINI_MODEL'] ?? 'gemini-3.1-flash-live-preview';
const API_KEY = process.env['GEMINI_API_KEY'];
if (!API_KEY) {
  console.error('GEMINI_API_KEY missing (set it in ../.env)');
  process.exit(1);
}

const TURNS = new URL('./.turns.jsonl', import.meta.url).pathname;

/** One turn, as this relay saw it. Times are Date.now() on this Mac. */
interface Turn {
  turn: number;
  heard: string; // what Gemini made of the phone's audio
  said: string; // what Gemini's reply says
  reply_out_at: number | null; // here: first reply byte written to the phone
  reply_in_at: number | null; // phone: first reply byte received
  voice_ms: number; // reply audio sent, exactly (24 kHz Int16 = 48 bytes/ms)
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
  let turns = 0;
  let turn = blankTurn(++turns);
  const openedAt = Date.now();

  // Gemini takes ~1s to accept the setup; audio that arrives meanwhile is held, not dropped.
  let session: Session | null = null;
  const backlog: Buffer[] = [];
  const forward = (pcm: Buffer) =>
    session?.sendRealtimeInput({
      audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
    });

  ws.on('message', (data, isBinary) => {
    // Text from the phone is a mark: a moment only the phone can see, timestamped on
    // the same Mac clock this relay uses, so it lands in the turn record as-is.
    if (!isBinary) {
      const mark = parse(String(data));
      if (mark?.type === 'mark' && mark.name === 'reply_in' && typeof mark.at === 'number') {
        turn.reply_in_at = mark.at;
      }
      return;
    }
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
      onopen: () => log(`gemini connected (${Date.now() - openedAt}ms)`),
      onmessage: (msg: LiveServerMessage) => {
        if (process.env['DEBUG']) log(`raw: ${JSON.stringify(msg).slice(0, 400)}`);

        // Gemini says how long a session has left before it drops it. Without this
        // the drop arrives as an unexplained close mid-conversation.
        if (msg.goAway) log(`⚠ goAway — timeLeft: ${msg.goAway.timeLeft}`);

        // The only usage figure the API gives; nothing else here can price a session.
        if (msg.usageMetadata) {
          const u = msg.usageMetadata;
          const by = (u.responseTokensDetails ?? [])
            .map((d) => `${d.modality}:${d.tokenCount}`)
            .join(' ');
          log(`tokens: ${u.totalTokenCount} total${by ? ` ${by}` : ''}`);
        }

        const sc = msg.serverContent;
        if (!sc) return;

        if (sc.interrupted) {
          send(ws, { type: 'interrupted' });
          log('interrupted');
        }
        // Not a timing signal: Gemini sends this in the same message as the reply
        // it already produced, so it says what was heard, never when speech ended.
        // Only whoever sent the audio can time that.
        if (sc.inputTranscription?.text) {
          turn.heard += sc.inputTranscription.text;
          send(ws, { type: 'user', text: sc.inputTranscription.text });
          log(`user: ${sc.inputTranscription.text}`);
        }
        if (sc.outputTranscription?.text) {
          turn.said += sc.outputTranscription.text;
          send(ws, { type: 'model', text: sc.outputTranscription.text });
        }
        for (const part of sc.modelTurn?.parts ?? []) {
          const b64 = part.inlineData?.data;
          if (!b64) continue;
          const pcm = Buffer.from(b64, 'base64');
          turn.reply_out_at ??= Date.now();
          down += pcm.length;
          turn.voice_ms += pcm.length / 48; // 24 kHz Int16 mono
          ws.send(pcm);
        }
        // Gemini has stopped generating, but audio may still be arriving. A gap
        // between this and turnComplete is Gemini's own tail, not a slow relay.
        if (sc.generationComplete) log('generationComplete');
        // After the audio above, so the turn record covers all of it. This is also
        // the only signal that a turn is over — without it every client has to
        // guess with a timer or by matching words.
        if (sc.turnComplete) {
          send(ws, { type: 'turn_end' });
          void record(turn, log);
          turn = blankTurn(++turns);
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

function blankTurn(n: number): Turn {
  return { turn: n, heard: '', said: '', reply_out_at: null, reply_in_at: null, voice_ms: 0 };
}

function parse(text: string): { type?: string; name?: string; at?: number } | null {
  try {
    return JSON.parse(text) as { type?: string; name?: string; at?: number };
  } catch {
    return null;
  }
}

/**
 * Append the finished turn, and say on one line how far the reply got. `→phone` is
 * the hop this relay adds — the whole reason for measuring any of this.
 */
async function record(t: Turn, log: (m: string) => void): Promise<void> {
  const hop = t.reply_out_at && t.reply_in_at ? `${t.reply_in_at - t.reply_out_at}ms` : '—';
  log(`turn ${t.turn} end  ${(t.voice_ms / 1000).toFixed(1)}s of voice  →phone ${hop}`);
  await appendFile(TURNS, `${JSON.stringify(t)}\n`);
}
