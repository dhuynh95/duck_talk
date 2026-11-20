import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// paths.ts reads PROJECT_CWD once, at import, so every case imports a fresh copy of it.
const root = mkdtempSync(join(tmpdir(), 'duck-talk-paths-'));
after(() => {
  chmodSync(join(root, 'locked'), 0o700);
  rmSync(root, { recursive: true, force: true });
});
let n = 0;

async function paths(project: string): Promise<typeof import('../server/paths.ts')> {
  const before = process.env['PROJECT_CWD'];
  process.env['PROJECT_CWD'] = project;
  try {
    return await import(`../server/paths.ts?case=${++n}`);
  } finally {
    if (before === undefined) delete process.env['PROJECT_CWD'];
    else process.env['PROJECT_CWD'] = before;
  }
}

describe('state()', () => {
  it('makes .duck-talk closed to other users, with a .gitignore that ignores all of it', async () => {
    const project = join(root, 'fresh');
    mkdirSync(project);
    const { state } = await paths(project);
    state('key');
    assert.equal(statSync(join(project, '.duck-talk')).mode & 0o777, 0o700);
    assert.equal(readFileSync(join(project, '.duck-talk', '.gitignore'), 'utf8'), '*\n');
  });

  it('gives an existing .duck-talk a .gitignore and leaves its mode alone', async () => {
    const project = join(root, 'existing');
    mkdirSync(join(project, '.duck-talk'), { recursive: true, mode: 0o755 });
    chmodSync(join(project, '.duck-talk'), 0o755);
    const { state } = await paths(project);
    state('turns.jsonl');
    assert.equal(statSync(join(project, '.duck-talk')).mode & 0o777, 0o755);
    assert.equal(readFileSync(join(project, '.duck-talk', '.gitignore'), 'utf8'), '*\n');
  });

  it('never overwrites a .gitignore that is already there', async () => {
    const project = join(root, 'kept');
    mkdirSync(join(project, '.duck-talk'), { recursive: true });
    writeFileSync(join(project, '.duck-talk', '.gitignore'), 'mine\n');
    const { state } = await paths(project);
    state('key');
    assert.equal(readFileSync(join(project, '.duck-talk', '.gitignore'), 'utf8'), 'mine\n');
  });

  it('a folder it cannot write does not throw from the .gitignore — the real file still fails', async () => {
    const project = join(root, 'locked');
    mkdirSync(project);
    chmodSync(project, 0o500);
    const { state } = await paths(project);
    const file = state('key');
    assert.equal(existsSync(join(project, '.duck-talk')), false);
    assert.throws(() => writeFileSync(file, 'x'), { code: 'ENOENT' });
  });
});
