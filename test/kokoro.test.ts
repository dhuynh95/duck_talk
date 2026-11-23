import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { INSTALLER, kokoroConfig, kokoroStatus, kokoroVoice, stopKokoro, warm, whole } from '../server/kokoro.ts';
import { VoiceError } from '../server/voice.ts';

// The local voice as the relay sees it: an HTTP endpoint it asks for a sentence's audio. The
// model itself is Python and is not run here — a fake endpoint answers, so what is held to
// account is the request the relay makes, what it does with the answer, and how it starts the
// engine, which is the part that can go wrong without anyone noticing.

const dir = mkdtempSync(join(tmpdir(), 'duck-talk-kokoro-'));
after(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => stopKokoro());

const config = (url: string, home = join(dir, 'nothing-installed')) => ({ url, home, voice: 'af_heart', speed: 1 });

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** A fake engine on an ephemeral port: what was asked is kept, what is answered is up to the test. */
async function fake(answer: (body: any, res: import('node:http').ServerResponse) => void) {
  const asked: any[] = [];
  const server: Server = createServer((req, res) => {
    if (req.url === '/health') return void res.end('{"ok":true}');
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      const body = JSON.parse(text);
      asked.push({ method: req.method, url: req.url, type: req.headers['content-type'], body });
      answer(body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, asked, close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))) };
}

async function collect(chunks: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const c of chunks) out.push(c);
  return out;
}

describe('kokoroConfig', () => {
  it('is local, af_heart and normal speed unless told otherwise', () => {
    const c = kokoroConfig({});
    assert.equal(c.url, 'http://127.0.0.1:8880');
    assert.equal(c.voice, 'af_heart');
    assert.equal(c.speed, 1);
    assert.match(c.home, /duck-talk[\\/]kokoro$/);
  });

  it('takes what the environment says, drops a trailing slash, and ignores a speed that is not a positive number', () => {
    const c = kokoroConfig({ KOKORO_URL: 'http://127.0.0.1:9000//', KOKORO_VOICE: 'bf_emma', KOKORO_HOME: '/opt/k', KOKORO_SPEED: '1.25' });
    assert.deepEqual(c, { url: 'http://127.0.0.1:9000', home: '/opt/k', voice: 'bf_emma', speed: 1.25 });
    for (const bad of ['0', '-1', 'fast', '']) assert.equal(kokoroConfig({ KOKORO_SPEED: bad }).speed, 1, bad);
  });
});

describe('whole', () => {
  it('hands on only whole 16-bit samples, carrying an odd byte to the chunk that completes it', async () => {
    const out = await collect(whole((async function* () {
      yield Uint8Array.of(1, 2, 3);
      yield Uint8Array.of(4, 5, 6, 7);
      yield Uint8Array.of(8);
    })()));
    assert.ok(out.every((c) => c.length % 2 === 0), 'every chunk is whole samples');
    assert.deepEqual([...Buffer.concat(out)], [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('drops a final stray byte rather than playing half a sample, and passes nothing for nothing', async () => {
    assert.deepEqual([...Buffer.concat(await collect(whole((async function* () { yield Uint8Array.of(1, 2, 3); })())))], [1, 2]);
    assert.deepEqual(await collect(whole((async function* () { yield new Uint8Array(0); })())), []);
  });
});

describe('kokoroVoice', () => {
  it('asks for one sentence in the shape the endpoint takes, and hands back its audio', async () => {
    const engine = await fake((_, res) => res.end(Buffer.alloc(4800, 1)));
    try {
      const pcm = Buffer.concat(await collect(kokoroVoice({ ...config(engine.url), voice: 'am_adam', speed: 1.1 }).speak('Done, you are on master.', new AbortController().signal)));
      assert.equal(pcm.length, 4800);
      assert.deepEqual(engine.asked, [{
        method: 'POST',
        url: '/v1/audio/speech',
        type: 'application/json',
        body: { model: 'kokoro', input: 'Done, you are on master.', voice: 'am_adam', speed: 1.1, response_format: 'pcm' },
      }]);
    } finally {
      await engine.close();
    }
  });

  it('is called Kokoro, for the log and for what the page is told', () => {
    assert.equal(kokoroVoice(config('http://127.0.0.1:1')).name, 'Kokoro');
  });

  it('rejects, saying what the engine answered, when it answers with an error', async () => {
    const engine = await fake((_, res) => { res.statusCode = 400; res.end('{"error":"no voice called \'nope\'"}'); });
    try {
      await assert.rejects(collect(kokoroVoice(config(engine.url)).speak('Hi.', new AbortController().signal)), /answered 400.*no voice called/);
    } finally {
      await engine.close();
    }
  });

  it('stops when the turn is cancelled mid-sentence', async () => {
    const engine = await fake((_, res) => { res.write(Buffer.alloc(100)); /* and never finishes */ });
    try {
      const aborter = new AbortController();
      const reading = collect(kokoroVoice(config(engine.url)).speak('A long sentence.', aborter.signal));
      setTimeout(() => aborter.abort(), 50);
      await assert.rejects(reading, (e: Error) => e.name === 'AbortError' || /abort/i.test(e.message));
    } finally {
      await engine.close();
    }
  });
});

describe('warm: making sure the engine is there', () => {
  it('does nothing when it is already answering', async () => {
    const engine = await fake((_, res) => res.end());
    try {
      await warm(config(engine.url));
    } finally {
      await engine.close();
    }
  });

  it('says what to run when it is not installed, and the message is fit to show as it stands', async () => {
    const url = `http://127.0.0.1:${await freePort()}`;
    const failure = await warm(config(url)).then(() => null, (e: unknown) => e);
    assert.ok(failure instanceof VoiceError);
    assert.match(failure.message, /not installed/);
    assert.ok(failure.message.includes(INSTALLER), 'names the installer');
    assert.equal(await kokoroStatus(config(url)), 'missing');
  });

  it('does not start anything for an address that is not this machine, and says it is not answering', async () => {
    const failure = await warm(config('http://nothing.invalid:8880')).then(() => null, (e: unknown) => e);
    assert.ok(failure instanceof VoiceError);
    assert.match(failure.message, /not answering/);
  });

  it('starts the installed engine and waits until it answers, then asks it', async () => {
    const home = installFake('node-server');
    const port = await freePort();
    const c = config(`http://127.0.0.1:${port}`, home);
    assert.equal(await kokoroStatus(c), 'installed');
    const logs: string[] = [];
    await warm(c, (m) => logs.push(m));
    assert.equal(await kokoroStatus(c), 'running');
    assert.match(logs.join('\n'), /starting Kokoro-82M/);
    assert.match(logs.join('\n'), /kokoro: fake engine ready/);
    const pcm = Buffer.concat(await collect(kokoroVoice(c).speak('Hello.', new AbortController().signal)));
    assert.equal(pcm.length, 96, 'what the engine sent');
  });

  it('shares one start between callers that arrive together', async () => {
    const home = installFake('node-server');
    const port = await freePort();
    const c = config(`http://127.0.0.1:${port}`, home);
    const logs: string[] = [];
    await Promise.all([warm(c, (m) => logs.push(m)), warm(c, (m) => logs.push(m)), warm(c, (m) => logs.push(m))]);
    assert.equal(logs.filter((m) => /starting Kokoro-82M/.test(m)).length, 1);
  });

  it('reports why when the engine dies while starting, with the last thing it said', async () => {
    const home = installFake('dies');
    const c = config(`http://127.0.0.1:${await freePort()}`, home);
    const failure = await warm(c).then(() => null, (e: unknown) => e);
    assert.ok(failure instanceof VoiceError);
    assert.match(failure.message, /stopped while starting \(exit 3\): boom: the model is missing/);
  });

  it('tries again for the next sentence after a failed start, rather than remembering the failure', async () => {
    const home = installFake('dies');
    const c = config(`http://127.0.0.1:${await freePort()}`, home);
    await assert.rejects(warm(c), VoiceError);
    installFake('node-server', home); // fixed in the meantime
    await warm(c);
    assert.equal(await kokoroStatus(c), 'running');
  });
});

/**
 * A home the way the installer leaves it — `venv/bin/python` and the model file — except the
 * "python" is a script that runs a node stand-in (or dies), so starting it can be watched
 * without the real model. It receives the same arguments the real server would.
 */
function installFake(kind: 'node-server' | 'dies', home = mkdtempSync(join(dir, 'home-'))): string {
  mkdirSync(join(home, 'venv', 'bin'), { recursive: true });
  mkdirSync(join(home, 'models'), { recursive: true });
  writeFileSync(join(home, 'models', 'kokoro-v1.0.onnx'), '');
  const fakeServer = join(home, 'fake-server.mjs');
  writeFileSync(fakeServer, `
    import { createServer } from 'node:http';
    const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
    createServer((req, res) => {
      if (req.url === '/health') return void res.end('{"ok":true}');
      res.end(Buffer.alloc(96, 2));
    }).listen(port, '127.0.0.1', () => console.error('fake engine ready'));
  `);
  const script = kind === 'dies'
    ? '#!/bin/sh\necho "boom: the model is missing" >&2\nexit 3\n'
    : `#!/bin/sh\nexec "${process.execPath}" "${fakeServer}" "$@"\n`;
  writeFileSync(join(home, 'venv', 'bin', 'python'), script);
  chmodSync(join(home, 'venv', 'bin', 'python'), 0o755);
  return home;
}
