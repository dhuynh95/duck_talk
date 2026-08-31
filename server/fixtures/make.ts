/**
 * Recordings for `node ears.ts --file`, made with the same voice model the relay
 * speaks through. Real prosody, breath, and a real noise floor — the pauses in them
 * are the pauses a person makes, not the digital zero `say` produces, which is the
 * easiest end-of-speech there is and hides every endpointing bug.
 *
 * Written at 16 kHz Int16 mono, the format ears.ts declares.
 *
 *   node fixtures/make.ts      regenerate every .wav here (costs a TTS call each)
 */

import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GoogleGenAI } from '@google/genai';

const run = promisify(execFile);
const DIR = fileURLToPath(new URL('.', import.meta.url));
const MODEL = process.env['VOICE_MODEL'] ?? 'gemini-3.1-flash-tts-preview';

// One request per recording, so a pause is inside one continuous utterance rather
// than a seam between two files.
const FIXTURES: Record<string, string> = {
  fluent:
    'Read this naturally at a normal pace.\n\nwhat is the latest commit in this repository',
  hesitate_short:
    'Read this as someone thinking aloud. Pause naturally where the ellipsis is, about one second, and keep the same sentence going afterwards.\n\nwhat is the latest commit ... in this repository',
  hesitate_long:
    'Read this as someone thinking aloud, unsure of themselves. Take a long pause at the ellipsis, two full seconds of silence, then continue the same sentence.\n\nso what is the latest commit ... umm ... in this repository',
  // The one recording that reliably defeats the ears: it comes back as "Just come in
  // and" / "hazelnut tree" — a mishearing and a split utterance at once, which is
  // exactly the pair the corrections and the clips exist for. Accents do not do this;
  // measured, a thick French accent transcribed perfectly. Poor articulation does.
  mumble:
    'Read this in a low mumble, trailing off at the end of words, poor articulation, as if half asleep.\n\nwhat is the latest commit in this repository',
};

const ai = new GoogleGenAI({ apiKey: process.env['GEMINI_API_KEY'] });

for (const [name, prompt] of Object.entries(FIXTURES)) {
  const stream = await ai.models.generateContentStream({
    model: MODEL,
    contents: prompt,
    config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Sulafat' } } } },
  });
  const parts: Buffer[] = [];
  for await (const chunk of stream) {
    const data = chunk.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
    if (data) parts.push(Buffer.from(data, 'base64'));
  }
  const pcm24 = Buffer.concat(parts);
  const raw = `${DIR}${name}.pcm`;
  writeFileSync(raw, pcm24);
  // The voice speaks at 24 kHz; the ears listen at 16.
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', raw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', `${DIR}${name}.wav`]);
  await run('rm', [raw]);
  // Where the quiet actually is, since that is the point of the recording.
  const { stdout, stderr } = await run('ffmpeg', ['-i', `${DIR}${name}.wav`, '-af', 'silencedetect=noise=-40dB:d=0.4', '-f', 'null', '-']).catch((e: { stdout: string; stderr: string }) => e);
  const quiet = (stdout + stderr).split('\n').filter((l) => l.includes('silence_duration')).map((l) => l.replace(/.*silence_duration: /, '').trim() + 's');
  console.log(`${name.padEnd(16)} ${(pcm24.length / 48 / 1000).toFixed(1)}s${quiet.length ? `, quiet for ${quiet.join(', ')}` : ''}`);
}
