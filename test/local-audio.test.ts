import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { synthesize, toPcm16k } from '../server/local-audio.ts';

const FLUENT = fileURLToPath(new URL('../server/fixtures/fluent.wav', import.meta.url));
const mac = process.platform === 'darwin';

const onPath = (name: string) => (process.env['PATH'] ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
const dir = mkdtempSync(join(tmpdir(), 'duck-talk-audio-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Run `body` with PATH set to `path`, and put it back however `body` ends. */
async function withPath<T>(path: string, body: () => Promise<T>): Promise<T> {
  const was = process.env['PATH'];
  process.env['PATH'] = path;
  try {
    return await body();
  } finally {
    if (was === undefined) delete process.env['PATH'];
    else process.env['PATH'] = was;
  }
}

describe('toPcm16k', { skip: !(onPath('ffmpeg') || onPath('afconvert')) && 'neither ffmpeg nor afconvert is installed' }, () => {
  it('gives 16 kHz Int16 mono PCM with no WAV header', async () => {
    const pcm = await toPcm16k(FLUENT);
    assert.ok(pcm.length > 0);
    assert.equal(pcm.length % 2, 0);
    assert.notEqual(pcm.toString('ascii', 0, 4), 'RIFF');
    // The fixture is 16 kHz mono already, so what comes back is as long as its recording:
    // a second per 32,000 bytes, to within the encoder's rounding.
    assert.ok(Math.abs(pcm.length / 32_000 - 3.16) < 0.1, `${pcm.length / 32_000} s`);
  });
});

describe('synthesize', () => {
  it('names espeak-ng as what to install when it is missing', { skip: mac && '`say` ships with macOS' }, async () => {
    const empty = mkdtempSync(join(dir, 'empty-'));
    await assert.rejects(withPath(empty, () => synthesize('hello', dir)), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /espeak-ng/);
      assert.match(err.message, /install/i);
      return true;
    });
  });

  it('writes the speech where it was told to and returns the path', { skip: mac && '`say` ships with macOS' }, async () => {
    // A stand-in for espeak-ng that writes what it was asked to — the contract is the
    // `-w <file>` flag, and a real synthesizer is not something a test machine has.
    const bin = mkdtempSync(join(dir, 'bin-'));
    const fake = join(bin, 'espeak-ng');
    writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" != "-w" ]; do shift; done\nprintf spoken > "$2"\n');
    chmodSync(fake, 0o755);
    const out = await withPath(bin, () => synthesize('hello', dir));
    assert.ok(out.startsWith(dir), out);
    assert.equal(existsSync(out), true);
  });
});
