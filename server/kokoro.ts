/**
 * The local voice: Kokoro-82M, running on this machine, as one more `VoiceEngine`.
 *
 * Gemini's text-to-speech is metered — the free tier stops at ten sentences a day — and
 * Kokoro is not: an 82-million-parameter model that runs faster than real time on a laptop
 * CPU, with no key, no network and no limit. It is the other choice in the page's Settings
 * ("Local voice"), and the relay does not care which one is reading: both are a function
 * from a sentence to 24 kHz PCM (see `VoiceEngine`).
 *
 * The model is Python, so it runs as a small server of its own (`kokoro/server.py`) that
 * answers `POST /v1/audio/speech` — the OpenAI shape, `response_format: "pcm"` being 24 kHz
 * 16-bit mono, which is exactly what the page plays. `kokoro/install.sh` puts it in a
 * private folder (`~/.local/share/duck-talk/kokoro`) once; this file starts it the first
 * time it is needed and stops it with the relay. Anything else that speaks the same
 * endpoint can be pointed at with `KOKORO_URL`, and is then only asked, never started.
 *
 *   KOKORO_URL    where it listens        http://127.0.0.1:8880
 *   KOKORO_HOME   where it is installed   ~/.local/share/duck-talk/kokoro
 *   KOKORO_VOICE  which of its voices     af_heart
 *   KOKORO_SPEED  how fast it reads       1
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { packaged } from './paths.ts';
import { VoiceError, type VoiceEngine } from './voice.ts';

export interface KokoroConfig {
  /** Where the engine listens, or should. The relay only ever starts one at a local address. */
  url: string;
  /** Where the installer put the Python environment and the model. */
  home: string;
  /** One of Kokoro's voices: `af_heart`, `am_adam`, `bf_emma`, … */
  voice: string;
  speed: number;
}

export function kokoroConfig(env: Record<string, string | undefined> = process.env): KokoroConfig {
  const data = env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share');
  const speed = Number(env['KOKORO_SPEED']);
  return {
    url: (env['KOKORO_URL'] || 'http://127.0.0.1:8880').replace(/\/+$/, ''),
    home: env['KOKORO_HOME'] || join(data, 'duck-talk', 'kokoro'),
    voice: env['KOKORO_VOICE'] || 'af_heart',
    speed: Number.isFinite(speed) && speed > 0 ? speed : 1,
  };
}

/** The installer that ships with the relay, for the message that says what to run. */
export const INSTALLER = packaged('./kokoro/install.sh');
const SERVER = packaged('./kokoro/server.py');
const MODEL = 'kokoro-v1.0.onnx';

const python = (c: KokoroConfig) => join(c.home, 'venv', 'bin', 'python');
const installed = (c: KokoroConfig) => existsSync(python(c)) && existsSync(join(c.home, 'models', MODEL));
const isLocal = (url: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).host.replace(/:\d+$/, ''));

async function healthy(url: string, ms = 1000): Promise<boolean> {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(ms) })).ok;
  } catch {
    return false;
  }
}

/** For the startup banner: is it answering, only installed, or not there at all. */
export async function kokoroStatus(config: KokoroConfig): Promise<'running' | 'installed' | 'missing'> {
  if (await healthy(config.url, 500)) return 'running';
  return installed(config) ? 'installed' : 'missing';
}

// One start at a time, shared by every connection — the model is loaded once, by whoever
// needs it first, and a second connection joins the wait instead of starting another.
const starting = new Map<string, Promise<void>>();
let child: ChildProcess | null = null;
let hooked = false;

/**
 * Make sure the engine is answering: it already is, or it is started here. Resolves when it
 * is ready to speak; rejects with a message fit to show, which says what to do about it.
 */
export function warm(config: KokoroConfig, log: (m: string) => void = () => {}): Promise<void> {
  let ready = starting.get(config.url);
  if (!ready) {
    ready = start(config, log).catch((e) => {
      starting.delete(config.url); // the next sentence tries again rather than inheriting this failure
      throw e;
    });
    starting.set(config.url, ready);
  }
  return ready;
}

async function start(config: KokoroConfig, log: (m: string) => void): Promise<void> {
  if (await healthy(config.url)) return;
  if (!isLocal(config.url)) throw new VoiceError(`The local voice at ${config.url} is not answering.`);
  if (!installed(config)) throw new VoiceError(`The local voice is not installed. Run once:  bash ${INSTALLER}`);

  log('local voice: starting Kokoro-82M');
  const port = new URL(config.url).port || '80';
  const proc = spawn(python(config), [SERVER, '--models', join(config.home, 'models'), '--port', port, '--parent', String(process.pid)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  if (!hooked) {
    hooked = true;
    process.on('exit', () => child?.kill());
  }
  let last = '';
  const note = (data: Buffer) => {
    for (const line of String(data).split('\n')) {
      if (!line.trim()) continue;
      last = line.trim().slice(0, 200);
      log(`kokoro: ${last}`);
    }
  };
  proc.stdout.on('data', note);
  proc.stderr.on('data', note);
  proc.once('exit', () => {
    if (child === proc) child = null;
    starting.delete(config.url); // gone: the next sentence starts it again
  });
  // `close`, not `exit`: it comes after the last of the engine's output has been read, so the
  // message can say what it said on its way down.
  const stopped = new Promise<never>((_, reject) => {
    proc.once('error', (e) => reject(new VoiceError(`The local voice could not be started: ${e.message}`)));
    proc.once('close', (code) => reject(new VoiceError(`The local voice stopped while starting (exit ${code})${last ? `: ${last}` : ''}`)));
  });
  let over = false; // the race below is decided, and the polling with it
  const answering = (async () => {
    for (const deadline = Date.now() + 90_000; !over && Date.now() < deadline; ) {
      if (await healthy(config.url, 500)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!over) throw new VoiceError('The local voice did not come up within 90 seconds.');
  })();
  try {
    await Promise.race([stopped, answering]);
  } finally {
    over = true;
  }
}

/** Stop what `warm` started. For a test, and for the relay to call on its way out. */
export function stopKokoro(): void {
  child?.kill();
  child = null;
  starting.clear();
}

/**
 * The engine itself. `speak` is one request per sentence; it starts the server first if it
 * has to, and when the server has gone away it forgets that it was ready, so the retry that
 * follows a failed sentence starts it again.
 */
export function kokoroVoice(config: KokoroConfig, log: (m: string) => void = () => {}): VoiceEngine {
  return {
    name: 'Kokoro',
    async *speak(text, signal) {
      await until(warm(config, log), signal);
      let res: Response;
      try {
        res = await fetch(`${config.url}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'kokoro', input: text, voice: config.voice, speed: config.speed, response_format: 'pcm' }),
          signal,
        });
      } catch (e) {
        if (!signal.aborted) starting.delete(config.url);
        throw e;
      }
      if (!res.ok || !res.body) {
        const why = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
        throw new Error(`the local voice answered ${res.status}${why ? `: ${why}` : ''}`);
      }
      yield* whole(res.body);
    },
  };
}

/** `promise`, or as soon as `signal` aborts — a turn that is cancelled is not held to a start it no longer needs. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const abort = () => resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', abort); resolve(v); },
      (e) => { signal.removeEventListener('abort', abort); reject(e); },
    );
  });
}

/**
 * Chunks of a byte stream cut at whole 16-bit samples. A network read can end in the
 * middle of one, and a speaker handed half a sample plays everything after it a byte out
 * of step — static — so the odd byte waits for the chunk that completes it.
 */
export async function* whole(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Buffer> {
  let odd: number | null = null;
  for await (const chunk of chunks) {
    let bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (odd !== null) {
      bytes = Buffer.concat([Buffer.from([odd]), bytes]);
      odd = null;
    }
    if (bytes.length % 2) {
      odd = bytes[bytes.length - 1]!;
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    if (bytes.length) yield bytes;
  }
}
