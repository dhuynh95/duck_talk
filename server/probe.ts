/**
 * A phone made of code: connects to the relay, speaks, and reports what happened.
 *
 *   node probe.ts "what is two plus two"     synthesize with `say`, then send it
 *   node probe.ts --file turn.wav            send an existing recording
 *
 * Prints {heard, said, first_audio_ms, reply_pcm} — `heard` is Gemini's transcript
 * of the audio it was given, `said` is its transcript of its own reply. Both come
 * from the live session, so there is one authority on what was said.
 *
 * This tests the Mac half only. It replaces the phone, so it cannot catch a bug in
 * AudioPipe — use the `speak()` tool for that.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const URL_BASE = process.env['PROBE_URL'] ?? 'ws://localhost:8765';
const RATE = 16_000; // the relay declares audio/pcm;rate=16000
const FRAME_MS = 20;
const FRAME_BYTES = (RATE / 1000) * FRAME_MS * 2; // Int16 mono
const VOICE = process.env['PROBE_VOICE'] ?? 'Samantha';

// --- Turn audio into exactly the format the relay expects -------------------

/** `say` → AIFF → 16 kHz Int16 LE mono WAV. Returns the PCM body, header stripped. */
async function pcmFor(args: { text?: string; file?: string }): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'probe-'));
  const wav = join(dir, 'turn.wav');

  let source = args.file;
  if (!source) {
    const aiff = join(dir, 'say.aiff');
    // -a is deliberately absent: writing to a file must not touch any device.
    await run('say', ['-v', VOICE, '-o', aiff, '--', args.text ?? '']);
    source = aiff;
  }
  await run('afconvert', [source, '-o', wav, '-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1']);

  const buf = await readFile(wav);
  return buf.subarray(dataOffset(buf));
}

/** Walk the RIFF chunks to the `data` body — never assume a 44-byte header. */
function dataOffset(buf: Buffer): number {
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'data') return at + 8;
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in converted WAV');
}

// --- One turn ---------------------------------------------------------------

interface Turn {
  heard: string;
  said: string;
  first_audio_ms: number | null;
  reply_pcm: string | null;
  interrupted: boolean;
  error?: string;
}

async function turn(pcm: Buffer, timeoutMs = 30_000): Promise<Turn> {
  const ws = new WebSocket(URL_BASE);
  const reply: Buffer[] = [];
  const result: Turn = {
    heard: '',
    said: '',
    first_audio_ms: null,
    reply_pcm: null,
    interrupted: false,
  };

  let sentAt = 0;
  const done = new Promise<void>((resolve) => {
    const finish = (why?: string) => {
      if (why) result.error = why;
      resolve();
    };
    const timer = setTimeout(() => finish('timed out waiting for turn_end'), timeoutMs);

    ws.onmessage = async (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') {
        const chunk = Buffer.from(await (ev.data as Blob).arrayBuffer());
        if (result.first_audio_ms === null) result.first_audio_ms = Math.round(performance.now() - sentAt);
        reply.push(chunk);
        return;
      }
      const msg = JSON.parse(ev.data) as { type: string; text?: string };
      if (msg.type === 'user') result.heard += msg.text ?? '';
      else if (msg.type === 'model') result.said += msg.text ?? '';
      else if (msg.type === 'interrupted') result.interrupted = true;
      else if (msg.type === 'error') { clearTimeout(timer); finish(msg.text); }
      else if (msg.type === 'turn_end') { clearTimeout(timer); finish(); }
    };
    ws.onerror = () => { clearTimeout(timer); finish(`cannot reach ${URL_BASE} — is the relay running?`); };
    ws.onclose = () => { clearTimeout(timer); finish(result.said ? undefined : 'relay closed the socket'); };
  });

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    setTimeout(() => reject(new Error(`no connection to ${URL_BASE}`)), 5_000);
  });

  // Pace the frames at wall-clock speed. Sent as fast as the socket allows, a
  // whole utterance arrives in one burst and Gemini never sees speech end.
  for (let at = 0; at < pcm.length; at += FRAME_BYTES) {
    ws.send(pcm.subarray(at, at + FRAME_BYTES));
    await new Promise((r) => setTimeout(r, FRAME_MS));
  }
  sentAt = performance.now();

  // Keep streaming silence, exactly as the phone's open mic does. Gemini's voice
  // detection watches a continuous stream for speech turning to quiet; a client
  // that simply stops sending leaves the audio cached and nothing happens.
  const silence = Buffer.alloc(FRAME_BYTES);
  const keepAlive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(silence);
  }, FRAME_MS);

  await done;
  clearInterval(keepAlive);
  ws.close();

  if (reply.length) {
    result.reply_pcm = join(await mkdtemp(join(tmpdir(), 'probe-')), 'reply.pcm');
    await writeFile(result.reply_pcm, Buffer.concat(reply));
  }
  return result;
}

// --- CLI -------------------------------------------------------------------

const argv = process.argv.slice(2);
const fileAt = argv.indexOf('--file');
const args = fileAt >= 0 ? { file: argv[fileAt + 1] } : { text: argv.join(' ') };
if (!args.file && !args.text) {
  console.error('usage: node probe.ts "what is two plus two"   |   node probe.ts --file turn.wav');
  process.exit(1);
}

const pcm = await pcmFor(args);
console.log(`sending ${(pcm.length / (RATE * 2)).toFixed(1)}s of audio to ${URL_BASE}`);
const out = await turn(pcm);
console.log(JSON.stringify(out, null, 2));
process.exit(out.error ? 1 : 0);
