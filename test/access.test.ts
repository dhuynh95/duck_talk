import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { isOpen, keyMatches, loadKey } from '../server/access.ts';

const dir = mkdtempSync(join(tmpdir(), 'duck-talk-access-'));
after(() => rmSync(dir, { recursive: true, force: true }));

describe('loadKey', () => {
  it('creates a 22-char base64url key, mode 0o600, and returns the same key on the next call', () => {
    const file = join(dir, 'made-key');
    const first = loadKey(file, {});
    assert.match(first, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(loadKey(file, {}), first);
    assert.equal(readFileSync(file, 'utf8').trim(), first);
  });

  it('DUCK_TALK_KEY wins and writes no file', () => {
    const file = join(dir, 'env-key');
    assert.equal(loadKey(file, { DUCK_TALK_KEY: 'from-the-environment' }), 'from-the-environment');
    assert.equal(existsSync(file), false);
  });

  it('DUCK_TALK_KEY wins over a key already on disk, and leaves that file alone', () => {
    const file = join(dir, 'both-key');
    writeFileSync(file, 'on-disk', { mode: 0o600 });
    assert.equal(loadKey(file, { DUCK_TALK_KEY: 'from-the-environment' }), 'from-the-environment');
    assert.equal(readFileSync(file, 'utf8'), 'on-disk');
  });

  it('an empty DUCK_TALK_KEY is no key at all, so the file still decides', () => {
    const file = join(dir, 'empty-env-key');
    const key = loadKey(file, { DUCK_TALK_KEY: '' });
    assert.match(key, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(readFileSync(file, 'utf8'), key);
  });

  it('a blank key file is replaced rather than accepted, and ends up private', () => {
    const file = join(dir, 'blank-key');
    writeFileSync(file, '\n', { mode: 0o644 });
    const key = loadKey(file, {});
    assert.match(key, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it('a key file with a trailing newline is read back without it', () => {
    const file = join(dir, 'edited-key');
    writeFileSync(file, 'typed-by-hand\n', { mode: 0o600 });
    assert.equal(loadKey(file, {}), 'typed-by-hand');
  });
});

describe('keyMatches', () => {
  const key = 'abcdefghijklmnopqrstuv';

  it('accepts equal and rejects null, undefined, "", shorter, longer and same-length-different keys without throwing', () => {
    assert.equal(keyMatches(key, key), true);
    assert.equal(keyMatches(null, key), false);
    assert.equal(keyMatches(undefined, key), false);
    assert.equal(keyMatches('', key), false);
    assert.equal(keyMatches(key.slice(0, -1), key), false);
    assert.equal(keyMatches(key + 'x', key), false);
    assert.equal(keyMatches('X' + key.slice(1), key), false);
  });

  it('rejects what is not a string, and an empty key never matches an empty guess', () => {
    assert.equal(keyMatches(12 as unknown as string, key), false);
    assert.equal(keyMatches({} as unknown as string, key), false);
    assert.equal(keyMatches('', ''), false);
  });

  it('compares bytes, so a guess of the right length in characters but not in bytes does not throw', () => {
    assert.equal(keyMatches('é'.repeat(key.length), key), false);
  });
});

describe('isOpen', () => {
  it('is true for --open and for DUCK_TALK_OPEN=1, false otherwise', () => {
    assert.equal(isOpen(['--open'], {}), true);
    assert.equal(isOpen(['--awake', '--open'], {}), true);
    assert.equal(isOpen([], { DUCK_TALK_OPEN: '1' }), true);
    assert.equal(isOpen([], {}), false);
    assert.equal(isOpen(['--awake'], {}), false);
    assert.equal(isOpen([], { DUCK_TALK_OPEN: '0' }), false);
    assert.equal(isOpen([], { DUCK_TALK_OPEN: '' }), false);
  });
});
