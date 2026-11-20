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
function startRelay(...args: string[]): Promise<Relay> {
  return startRelayWith({}, ...args);
}

/** The same, with something more in its environment. */
async function startRelayWith(extra: Record<string, string>, ...args: string[]): Promise<Relay> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'duck-talk-relay-'));
  // An empty PATH, and an absolute `node` to run it: a relay that finds `tailscale` on
  // the machine running the tests repoints that machine's own front door at this port.
  const empty = mkdtempSync(join(tmpdir(), 'duck-talk-path-'));
  const env = { ...process.env, GEMINI_API_KEY: 'fake', PATH: empty };
  for (const name of ['ANTHROPIC_API_KEY', 'DUCK_TALK_KEY', 'DUCK_TALK_OPEN', 'DUCK_TALK_ORIGINS', 'PORT', 'PROJECT_CWD']) delete env[name];
  Object.assign(env, extra);

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
        // The `stt` row is the last of the address rows, so every address is out by then.
        if (!new RegExp(`simulator +ws://localhost:${port}`).test(printed) || !/^ {2}stt /m.test(printed)) return;
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
function refusal(url: string, origin?: string): Promise<{ status: number; length: string | undefined }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin === undefined ? {} : { origin });
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
function firstFrame(url: string, origin?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin === undefined ? {} : { origin });
    let frame: Record<string, unknown> | undefined;
    ws.once('message', (data) => { frame = JSON.parse(String(data)) as Record<string, unknown>; ws.close(); });
    ws.on('close', () => (frame ? resolve(frame) : reject(new Error(`${url} closed without a frame`))));
    ws.on('unexpected-response', (_req, res) => { res.resume(); reject(new Error(`${url} was refused: ${res.statusCode}`)); });
    ws.on('error', reject);
  });
}

/** Resolves once the relay has printed a line matching `pattern`, or fails after ~2 s. */
async function printed(relay: Relay, pattern: RegExp): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const line = relay.output().split('\n').find((l) => pattern.test(l));
    if (line !== undefined) return line;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`no line matching ${pattern} in:\n${relay.output()}`);
}

/** What a relay answers at `/access.json`, with the headers that matter and the body as sent. */
async function access(relay: Relay, method = 'GET', path = '/access.json') {
  const res = await fetch(`http://127.0.0.1:${relay.port}${path}`, { method });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

/** What every answer about the gate says about how it may be kept and read. */
function assertGuarded(headers: Headers) {
  assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
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

  it('says at /access.json, with no key, that one is required — and says nothing else', async () => {
    const res = await access(relay);
    assert.equal(res.status, 200);
    assertGuarded(res.headers);
    assert.equal(res.body, '{"required":true}');
    assert.equal(res.headers.get('content-length'), String(res.body.length));
    assert.ok(!res.body.includes(key));
  });

  it('does not echo what /access.json is brought, key or not', async () => {
    for (const query of ['?key=x', `?key=${key}`, '?key=', '?required=false']) {
      const res = await access(relay, 'GET', `/access.json${query}`);
      assert.equal(res.status, 200, query);
      assert.equal(res.body, '{"required":true}', query);
      assert.ok(!res.body.includes(key), query);
    }
  });

  it('answers HEAD /access.json with the headers and no body', async () => {
    const get = await access(relay);
    const head = await access(relay, 'HEAD');
    assert.equal(head.status, 200);
    assertGuarded(head.headers);
    assert.equal(head.headers.get('content-length'), String(get.body.length));
    assert.equal(head.body, '');
  });

  it('refuses any other method at /access.json with 405, and says what is allowed', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await access(relay, method);
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('allow'), 'GET, HEAD', method);
      assert.equal(res.headers.get('cache-control'), 'no-store', method);
      assert.ok(!res.body.includes(key), method);
    }
  });

  it('answers /access.json only at that address: near misses are plain 404s', async () => {
    for (const path of ['/access.json/', '/access.json.bak', '/Access.json', '/x/access.json', '/access']) {
      const res = await access(relay, 'GET', path);
      assert.equal(res.status, 404, path);
      assert.ok(!res.body.includes('required'), path);
      assert.ok(!res.body.includes(key), path);
    }
  });

  it('is still the gate after /access.json has been read: a socket with no key is refused', async () => {
    await access(relay);
    assert.deepEqual(await refusal(at('?data=1')), { status: 401, length: '0' });
  });

  it('prints the key in its startup addresses and nowhere else', async () => {
    const before = opened();
    await firstFrame(at(`?data=1&key=${key}`));
    assert.equal(opened(), before + 1);
    assert.ok(/\[\d+\] open \(/.test(relay.output()));
    const withKey = relay.output().split('\n').filter((line) => line.includes(key));
    assert.ok(withKey.some((line) => line.includes(`http://localhost:${relay.port}/?key=${key}`)));
    for (const line of withKey) assert.match(line, /^ {2}(web|localhost|web Wi-Fi) +http\S*\/\?key=/, 'the key is in a line that is not an address row');
  });
});

describe('a relay with a key, asked from a web page', () => {
  let relay: Relay;
  let key: string;
  const at = (query: string) => `ws://127.0.0.1:${relay.port}/${query}`;

  before(async () => {
    relay = await startRelay();
    key = readFileSync(join(relay.dir, '.duck-talk', 'key'), 'utf8').trim();
  });
  after(() => relay.stop());

  it('refuses a page from anywhere else with a 403, even with the right key', async () => {
    assert.deepEqual(await refusal(at(`?data=1&key=${key}`), 'https://evil.example'), { status: 403, length: '0' });
  });

  it('says which host it refused in one line, and not the key', async () => {
    await refusal(at(`?data=1&key=${key}`), 'https://evil.example:8443/path?key=leak');
    const line = await printed(relay, /refused origin/);
    assert.match(line, /refused origin evil\.example$/);
    assert.ok(!line.includes(key));
    assert.ok(!line.includes('leak'));
  });

  it('lets in its own page on localhost', async () => {
    assert.equal((await firstFrame(at(`?data=1&key=${key}`), `http://localhost:${relay.port}`)).type, 'relay');
  });

  it('lets in its own page behind Tailscale', async () => {
    assert.equal((await firstFrame(at(`?data=1&key=${key}`), 'https://box.tail1234.ts.net')).type, 'relay');
  });

  it('lets in a caller that sends no Origin at all', async () => {
    assert.equal((await firstFrame(at(`?data=1&key=${key}`))).type, 'relay');
  });

  it('still asks a page it lets in for the key', async () => {
    assert.equal((await refusal(at('?data=1'), `http://localhost:${relay.port}`)).status, 401);
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

  it('prints its addresses with no key in them', () => {
    assert.match(relay.output(), new RegExp(`^ {2}localhost +http://localhost:${relay.port}/$`, 'm'));
    assert.ok(!relay.output().includes('?key='));
  });

  it('says at /access.json that no key is required', async () => {
    const res = await access(relay);
    assert.equal(res.status, 200);
    assertGuarded(res.headers);
    assert.equal(res.body, '{"required":false}');
  });

  it('says so whatever key it is brought, and answers HEAD and 405 as a relay with a key does', async () => {
    assert.equal((await access(relay, 'GET', '/access.json?key=whatever')).body, '{"required":false}');
    const head = await access(relay, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    const post = await access(relay, 'POST');
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  });

  it('still serves the client over plain HTTP', async () => {
    const res = await fetch(`http://127.0.0.1:${relay.port}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>/);
  });

  it('does not mind what key it is brought', async () => {
    assert.equal((await firstFrame(at('?data=1&key=whatever'))).type, 'relay');
  });
});

describe('a relay started with --open, asked from a web page', () => {
  it('refuses a page from anywhere else: open is to whoever can reach the port, not to every site in a browser', async () => {
    const relay = await startRelay('--open');
    try {
      const url = `ws://127.0.0.1:${relay.port}/?data=1`;
      assert.deepEqual(await refusal(url, 'https://evil.example'), { status: 403, length: '0' });
      assert.equal((await refusal(`ws://127.0.0.1:${relay.port}/?mode=direct`, 'null')).status, 403);
      assert.match(await printed(relay, /refused origin/), /refused origin evil\.example$/);
      assert.equal((await firstFrame(url, `http://localhost:${relay.port}`)).type, 'relay');
    } finally {
      await relay.stop();
    }
  });

  it('lets in a host DUCK_TALK_ORIGINS names', async () => {
    const relay = await startRelayWith({ DUCK_TALK_ORIGINS: 'evil.example' }, '--open');
    try {
      assert.equal((await firstFrame(`ws://127.0.0.1:${relay.port}/?data=1`, 'https://evil.example')).type, 'relay');
      assert.equal((await refusal(`ws://127.0.0.1:${relay.port}/?data=1`, 'https://other.example')).status, 403);
    } finally {
      await relay.stop();
    }
  });
});
