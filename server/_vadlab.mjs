/* VAD experiment: isolate speech-end → transcript → tool call. No Claude, no TTS. */
import { readFileSync } from 'node:fs';
import { GoogleGenAI, Modality, Type } from '@google/genai';

const PROMPT = readFileSync('./prompts/ears.md', 'utf8');
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-live-preview';
const TOOLS = [{ functionDeclarations: [{
  name: 'converse',
  description: 'Forward a user instruction or question to Claude Code. Use this whenever the user wants Claude Code to do or answer something.',
  parameters: { type: Type.OBJECT, properties: { instruction: { type: Type.STRING } }, required: ['instruction'] },
}]}];

const wav = readFileSync(process.argv[2]);
const pcm = wav.subarray(wav.indexOf('data') + 8);
const FRAME = 640, FRAME_MS = 20;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function trial({ silenceMs, hybrid, label }) {
  const cfg = { responseModalities: [Modality.AUDIO], tools: TOOLS, systemInstruction: PROMPT, inputAudioTranscription: {} };
  if (silenceMs != null) cfg.realtimeInputConfig = { automaticActivityDetection: { silenceDurationMs: silenceMs } };

  let tEnd = 0, tScript = 0, tTool = 0, heard = '', instruction = '';
  const done = Promise.withResolvers();
  const s = await ai.live.connect({ model: MODEL, config: cfg, callbacks: {
    onmessage: (m) => {
      const now = performance.now();
      for (const fc of m.toolCall?.functionCalls ?? []) {
        if (!tTool) { tTool = now; instruction = String(fc.args?.instruction ?? ''); }
        s.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { result: 'done' } }] });
        done.resolve();
      }
      const t = m.serverContent?.inputTranscription?.text;
      if (t) { if (!tScript) tScript = now; heard += t; }
    },
    onerror: e => { console.error('err', e.message); done.resolve(); },
    onclose: () => done.resolve(),
  }});

  for (let i = 0; i < pcm.length; i += FRAME) {
    s.sendRealtimeInput({ audio: { data: pcm.subarray(i, i + FRAME).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
    await sleep(FRAME_MS);
  }
  tEnd = performance.now();
  if (hybrid) s.sendRealtimeInput({ audioStreamEnd: true });   // finalize now, skip the silence wait

  const silence = Buffer.alloc(FRAME).toString('base64');
  const keep = hybrid ? null : setInterval(() => s.sendRealtimeInput({ audio: { data: silence, mimeType: 'audio/pcm;rate=16000' } }), FRAME_MS);
  const timer = setTimeout(() => done.resolve(), 15000);
  await done.promise;
  clearTimeout(timer); if (keep) clearInterval(keep);
  s.close();
  return {
    label,
    transcript_ms: tScript ? Math.round(tScript - tEnd) : null,
    tool_ms: tTool ? Math.round(tTool - tEnd) : null,
    heard: heard.trim(), instruction,
  };
}

const arms = [
  { label: 'default',        silenceMs: null,  hybrid: false },
  { label: 'silence=500',    silenceMs: 500,   hybrid: false },
  { label: 'silence=200',    silenceMs: 200,   hybrid: false },
  { label: 'hybrid(streamEnd)', silenceMs: null, hybrid: true },
];
const N = Number(process.env.N ?? 3);
for (const a of arms) {
  const runs = [];
  for (let i = 0; i < N; i++) { runs.push(await trial(a)); await sleep(800); }
  const nums = runs.map(r => r.tool_ms).filter(x => x != null);
  const med = nums.length ? nums.sort((x,y)=>x-y)[Math.floor(nums.length/2)] : null;
  console.log(JSON.stringify({ arm: a.label, tool_ms: runs.map(r=>r.tool_ms), median: med,
    transcript_ms: runs.map(r=>r.transcript_ms), heard: runs[0].heard, instruction: runs[0].instruction }));
}
