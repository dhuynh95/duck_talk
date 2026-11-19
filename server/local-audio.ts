/**
 * Speech and sound conversion for the tools beside the relay — `probe.ts` and `lab.ts`
 * act as a phone and need a spoken question as 16 kHz PCM — on whichever machine they
 * are run on.
 *
 * macOS has `say` and `afconvert` built in; Linux has neither, so there it is
 * `espeak-ng` and `ffmpeg`, which a package manager installs. Each tool is looked for
 * when it is needed, and a missing one is an error that says what to install, rather
 * than a bare ENOENT that names a binary the reader has never heard of.
 *
 * Source-only, like the tools that use it: the relay itself never makes or converts
 * audio, so this is not part of the package.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const mac = process.platform === 'darwin';

/** The rate the relay declares for what a phone sends: `audio/pcm;rate=16000`. */
const RATE = 16_000;

/** For a `.catch`: "no such program" becomes an instruction; anything else is passed on. */
const needs = (name: string, install: string) => (e: unknown): never => {
  if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${name} is not installed — ${install}`);
  throw e;
};

/**
 * Speak `text` into a file in `dir` and return its path — an AIFF from `say` on a Mac,
 * a WAV from `espeak-ng` elsewhere. `voice` is that tool's own name for one, and left
 * out it is `say`'s Samantha or espeak-ng's default.
 */
export async function synthesize(text: string, dir: string, voice?: string): Promise<string> {
  if (mac) {
    const out = join(dir, 'speech.aiff');
    // -a is deliberately absent: writing to a file must not touch any device.
    await run('say', ['-v', voice ?? 'Samantha', '-o', out, '--', text]).catch(needs('say', 'it ships with macOS'));
    return out;
  }
  const out = join(dir, 'speech.wav');
  await run('espeak-ng', [...(voice ? ['-v', voice] : []), '-w', out, '--', text]).catch(needs('espeak-ng', 'for example `sudo apt install espeak-ng`'));
  return out;
}

/** Any audio file → 16 kHz Int16 LE mono PCM, with no header, ready to stream as frames. */
export async function toPcm16k(source: string): Promise<Buffer> {
  if (!mac) {
    // The PCM comes back on stdout, so the buffer has to hold all of it: an hour of audio
    // is 115 MB, and the default 1 MB is thirty seconds.
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', source, '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-'], {
      encoding: 'buffer',
      maxBuffer: 512 * 1024 * 1024,
    }).catch(needs('ffmpeg', 'for example `sudo apt install ffmpeg`'));
    return stdout;
  }

  const dir = await mkdtemp(join(tmpdir(), 'duck-talk-pcm-'));
  try {
    const wav = join(dir, 'turn.wav');
    await run('afconvert', [source, '-o', wav, '-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1']).catch(needs('afconvert', 'it ships with macOS'));
    const buf = await readFile(wav);
    return buf.subarray(dataOffset(buf));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
