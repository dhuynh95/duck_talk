import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';

// The per-run log holds everything the terminal showed, and the startup rows carry the access key,
// so the file is the owner's and the folder it is made in is too. openLog tees process.stdout and
// process.stderr and is never undone, so each test puts both back; the project is a folder of
// its own, set before the import because paths.ts reads it once.

const project = mkdtempSync(join(tmpdir(), 'duck-talk-log-'));
process.env['PROJECT_CWD'] = project;
const { openLog } = await import('../server/log.ts');

const logs = join(project, '.duck-talk', 'logs');
const NOW = new Date(2026, 10, 20, 9, 30, 5); // 2026-11-20 09:30:05, local time
const NAME = '2026-11-20_09-30-05.log';
const writes = { out: process.stdout.write, err: process.stderr.write };
const mode = (path: string) => statSync(path).mode & 0o777;

/** openLog at a moment the test chose, so the file it names is one the test can have made already. */
function openAt(at: Date): string {
  mock.timers.enable({ apis: ['Date'], now: at });
  try {
    return openLog();
  } finally {
    mock.timers.reset();
  }
}

beforeEach(() => rmSync(join(project, '.duck-talk'), { recursive: true, force: true }));
afterEach(() => {
  process.stdout.write = writes.out;
  process.stderr.write = writes.err;
});
after(() => rmSync(project, { recursive: true, force: true }));

describe('openLog: the log is the owner\'s alone', () => {
  it('makes the file readable and writable by its owner only', () => {
    const path = openAt(NOW);
    assert.equal(join(logs, NAME), path);
    assert.equal(mode(path) & 0o077, 0, `mode is ${mode(path).toString(8)}`);
  });

  it('makes the folder it made for the logs closed to everyone else, too', () => {
    openAt(NOW);
    assert.equal(mode(logs) & 0o077, 0, `mode is ${mode(logs).toString(8)}`);
  });

  it('closes a log of the same name that was already there, and keeps what it held', () => {
    mkdirSync(logs, { recursive: true });
    const path = join(logs, NAME);
    writeFileSync(path, 'an earlier line\n', { mode: 0o644 });
    chmodSync(path, 0o644); // the mode of a file made by a relay before this fix, whatever the umask said
    assert.equal(openAt(NOW), path);
    assert.equal(mode(path) & 0o077, 0);
    assert.equal(readFileSync(path, 'utf8'), 'an earlier line\n');
  });

  it('closes the logs of the last few days too: they carry the same key, which a restart does not change', () => {
    mkdirSync(logs, { recursive: true });
    const yesterday = join(logs, '2026-11-19_18-00-00.log');
    writeFileSync(yesterday, 'key was here\n');
    chmodSync(yesterday, 0o644);
    openAt(NOW);
    assert.equal(mode(yesterday) & 0o077, 0);
  });

  it('leaves alone a folder that was there before: it is not the log\'s to change', () => {
    mkdirSync(logs, { recursive: true });
    chmodSync(logs, 0o755);
    openAt(NOW);
    assert.equal(mode(logs), 0o755);
  });

  it('still writes what the terminal shows into the file', async () => {
    const path = openAt(NOW);
    process.stdout.write('hello from the terminal\n');
    process.stderr.write('and from stderr\n');
    await new Promise((r) => setTimeout(r, 50));
    const kept = readFileSync(path, 'utf8');
    assert.match(kept, /hello from the terminal/);
    assert.match(kept, /and from stderr/);
  });

  it('forgets logs older than a week, as before', () => {
    mkdirSync(logs, { recursive: true });
    const old = join(logs, '2026-11-01_09-00-00.log');
    const recent = join(logs, '2026-11-18_09-00-00.log');
    writeFileSync(old, '');
    writeFileSync(recent, '');
    openAt(NOW);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(recent), true);
    assert.equal(dirname(old), logs);
  });
});
