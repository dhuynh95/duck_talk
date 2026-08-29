/**
 * A Gemini Live session you can poke at: hold one open, push audio into it, and read
 * back every raw message it sent with the time it arrived. For answering questions
 * the SDK docs do not — which fields actually arrive, in what order, and when.
 *
 *   node lab.ts                          open a transcribe-live session on :8799
 *   node lab.ts --model <id> --ears      open the production ears session instead
 *
 * Knobs, once it is up:
 *   curl -X POST 'localhost:8799/say?text=what+is+the+latest+commit'   speak a phrase
 *   curl -X POST 'localhost:8799/file?path=/tmp/turn.wav'              send a recording
 *   curl -X POST 'localhost:8799/silence?ms=1500'                      stream quiet
 *   curl -X POST 'localhost:8799/end'                                  audioStreamEnd
 *   curl localhost:8799/log                                            what came back
 *   curl -X POST localhost:8799/clear                                  forget it
 *
 * Times are ms from the last moment audio was sent, so "when did this arrive after I
 * stopped talking" is read directly off the log.
 */

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GoogleGenAI, Modality, Type, type LiveServerMessage, type Session, type Tool } from '@google/genai';

const run = promisify(execFile);
const PORT = Number(process.env['LAB_PORT'] ?? 8799);
const FRAME = 640;
const FRAME_MS = 20;

const argv = process.argv.slice(2);
const ears = argv.includes('--ears');
const at = argv.indexOf('--model');
const MODEL = at >= 0 ? argv[at + 1]! : ears ? 'gemini-2.5-flash-native-audio-preview-12-2025' : 'gemini-3.5-transcribe-live';

const TOOLS: Tool[] = [{ functionDeclarations: [{
  name: 'converse',
  description: 'Forward a user instruction or question to Claude Code.',
  parameters: { type: Type.OBJECT, properties: { instruction: { type: Type.STRING } }, required: ['instruction'] },
}]}];

const ai = new GoogleGenAI({ apiKey: process.env['GEMINI_API_KEY'] });
const log: { at: number; msg: unknown }[] = [];
let audioEndedAt = performance.now();
let session: Session | null = null;

const config = ears
  ? { responseModalities: [Modality.AUDIO], tools: TOOLS, inputAudioTranscription: {}, outputAudioTranscription: {},
      systemInstruction: 'You are a silent dispatcher. Call the converse tool with what the user said. Never speak.' }
  : { responseModalities: [Modality.TEXT], inputAudioTranscription: {} };

session = await ai.live.connect({
  model: MODEL,
  config,
  callbacks: {
    onopen: () => console.log(`lab: ${MODEL} open on :${PORT}`),
    onmessage: (m: LiveServerMessage) => {
      log.push({ at: Math.round(performance.now() - audioEndedAt), msg: m });
      // Answer tool calls so the session keeps running rather than waiting on us.
      for (const fc of m.toolCall?.functionCalls ?? []) {
        session?.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { result: 'done' } }] });
      }
    },
    onerror: (e) => log.push({ at: Math.round(performance.now() - audioEndedAt), msg: { ERROR: e.message } }),
    onclose: (e) => log.push({ at: Math.round(performance.now() - audioEndedAt), msg: { CLOSED: e.reason || e.code } }),
  },
});

/** Push PCM in at wall-clock speed, the way a phone does. */
async function stream(pcm: Buffer): Promise<void> {
  for (let i = 0; i < pcm.length; i += FRAME) {
    session?.sendRealtimeInput({ audio: { data: pcm.subarray(i, i + FRAME).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
    await new Promise((r) => setTimeout(r, FRAME_MS));
  }
  audioEndedAt = performance.now();
}

async function pcmForText(text: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'lab-'));
  const aiff = join(dir, 'a.aiff'), wav = join(dir, 'a.wav');
  await run('say', ['-v', process.env['LAB_VOICE'] ?? 'Samantha', '-o', aiff, '--', text]);
  await run('afconvert', [aiff, '-o', wav, '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1']);
  return pcmOf(await readFile(wav));
}

const pcmOf = (buf: Buffer) => buf.subarray(buf.indexOf('data') + 8);

createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://x');
    const q = url.searchParams;
    const reply = (body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 2)); };
    try {
      switch (url.pathname) {
        case '/say':     await stream(await pcmForText(q.get('text') ?? '')); return reply({ sent: 'audio', text: q.get('text') });
        case '/file':    await stream(pcmOf(await readFile(q.get('path')!))); return reply({ sent: 'file', path: q.get('path') });
        case '/silence': await stream(Buffer.alloc(Math.round(Number(q.get('ms') ?? 1000) * 32))); return reply({ sent: 'silence' });
        case '/end':     session?.sendRealtimeInput({ audioStreamEnd: true }); return reply({ sent: 'audioStreamEnd' });
        case '/clear':   log.length = 0; return reply({ cleared: true });
        case '/log':     return reply({ model: MODEL, n: log.length, log });
        default:         return reply({ model: MODEL, knobs: ['/say?text=', '/file?path=', '/silence?ms=', '/end', '/log', '/clear'] });
      }
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  })();
}).listen(PORT);
