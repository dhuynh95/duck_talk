import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';

// The relay is run the way a person runs it — `cli.ts` in a folder — because the thing
// worth proving is the gate on the real upgrade path, not a copy of it built for a test.
const CLI = fileURLToPath(new URL('../server/cli.ts', import.meta.url));
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

interface Relay {
  port: number;
  /** The project folder the relay was started in; its state is under `.duck-talk/`. */
  dir: string;
  /** Everything the relay has printed so far, both streams. */
  output(): string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address() as { port: number };
  await new Promise((done) => probe.close(done));
  return port;
}

/** A relay in a folder of its own, resolved once it has said where it listens. */
async function startRelay(...args: string[]): Promise<Relay> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'duck-talk-relay-'));
  // An empty PATH, and an absolute `node` to run it: a relay that finds `tailscale` on
  // the machine running the tests repoints that machine's own front door at this port.
  const empty = mkdtempSync(join(tmpdir(), 'duck-talk-path-'));
  const env = { ...process.env, GEMINI_API_KEY: 'fake', PATH: empty };
  for (const name of ['ANTHROPIC_API_KEY', 'DUCK_TALK_KEY', 'DUCK_TALK_OPEN', 'PORT', 'PROJECT_CWD']) delete env[name];

  const child: ChildProcess = spawn(process.execPath, [CLI, '--port', String(port), '--cwd', dir, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let printed = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { printed += chunk; });

  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  const stop = async () => {
    child.kill('SIGTERM');
    await exited;
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`relay did not start in 10 s:\n${printed}`)), 10_000);
      const look = () => {
        if (!new RegExp(`simulator +ws://localhost:${port}`).test(printed)) return;
        clearTimeout(timer);
        resolve();
      };
      child.stdout?.on('data', look);
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`relay exited early:\n${printed}`)); });
      look();
    });
  } catch (err) {
    await stop();
    throw err;
  }
  return { port, dir, output: () => printed, stop };
}

/** The status the upgrade was refused with. Fails if the socket opened or never answered. */
function refusal(url: string): Promise<{ status: number; length: string | undefined }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      ws.terminate();
      resolve({ status: res.statusCode ?? 0, length: res.headers['content-length'] });
    });
    ws.on('open', () => { ws.terminate(); reject(new Error(`${url} was let in`)); });
    ws.on('error', reject);
  });
}

/** The first frame a socket is sent, parsed — and the socket closed behind it. */
function firstFrame(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let frame: Record<string, unknown> | undefined;
    ws.once('message', (data) => { frame = JSON.parse(String(data)) as Record<string, unknown>; ws.close(); });
    ws.on('close', () => (frame ? resolve(frame) : reject(new Error(`${url} closed without a frame`))));
    ws.on('unexpected-response', (_req, res) => { res.resume(); reject(new Error(`${url} was refused: ${res.statusCode}`)); });
    ws.on('error', reject);
  });
}

describe('a relay with a key', () => {
  let relay: Relay;
  let key: string;
  const at = (query: string) => `ws://127.0.0.1:${relay.port}/${query}`;
  const opened = () => (relay.output().match(/\[\d+\] open /g) ?? []).length;

  before(async () => {
    relay = await startRelay();
    key = readFileSync(join(relay.dir, '.duck-talk', 'key'), 'utf8').trim();
  });
  after(() => relay.stop());

  it('makes a key for itself and keeps it', () => {
    assert.match(key, /^[A-Za-z0-9_-]{22}$/);
  });

  it('serves the client over plain HTTP, with no key', async () => {
    const res = await fetch(`http://127.0.0.1:${relay.port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.match(await res.text(), /<title>/);
  });

  it('refuses a data connection that brings no key', async () => {
    assert.deepEqual(await refusal(at('?data=1')), { status: 401, length: '0' });
  });

  it('refuses a data connection whose key is empty', async () => {
    assert.equal((await refusal(at('?data=1&key='))).status, 401);
  });

  it('refuses a data connection whose key is too short', async () => {
    assert.equal((await refusal(at(`?data=1&key=${key.slice(0, 5)}`))).status, 401);
  });

  it('refuses a data connection whose key is too long', async () => {
    assert.equal((await refusal(at(`?data=1&key=${key}x`))).status, 401);
  });

  it('refuses a data connection whose key is the right length and wrong', async () => {
    const wrong = (key[0] === 'a' ? 'b' : 'a') + key.slice(1);
    assert.equal((await refusal(at(`?data=1&key=${wrong}`))).status, 401);
  });

  it('refuses a voice connection that brings no key', async () => {
    assert.equal((await refusal(at('?mode=direct'))).status, 401);
    assert.equal((await refusal(at('?mode=review&correct=1&readback=1'))).status, 401);
  });

  it('refuses a voice connection whose key is wrong', async () => {
    assert.equal((await refusal(at('?mode=direct&key=nope'))).status, 401);
  });

  it('opens no session for a socket it refuses', async () => {
    const before = opened();
    await refusal(at('?data=1'));
    await refusal(at('?mode=direct'));
    assert.equal(opened(), before);
  });

  it('lets a data connection in with the key, and says which relay it is', async () => {
    assert.deepEqual(await firstFrame(at(`?data=1&key=${key}`)), { type: 'relay', version: VERSION });
  });

  it('keeps the key out of its own log', async () => {
    const before = opened();
    await firstFrame(at(`?data=1&key=${key}`));
    assert.equal(opened(), before + 1);
    assert.ok(/\[\d+\] open \(/.test(relay.output()));
    assert.ok(!relay.output().includes(key));
  });
});

describe('a relay started with --open', () => {
  let relay: Relay;
  const at = (query: string) => `ws://127.0.0.1:${relay.port}/${query}`;

  before(async () => { relay = await startRelay('--open'); });
  after(() => relay.stop());

  it('makes no key', () => {
    assert.equal(existsSync(join(relay.dir, '.duck-talk', 'key')), false);
  });

  it('lets a data connection in with no key', async () => {
    assert.deepEqual(await firstFrame(at('?data=1')), { type: 'relay', version: VERSION });
  });

  it('does not mind what key it is brought', async () => {
    assert.equal((await firstFrame(at('?data=1&key=whatever'))).type, 'relay');
  });
});
