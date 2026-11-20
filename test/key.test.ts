import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { forgetKey, hasStoredKey, keepKey, needsKey, socketUrl, takeKey } from '../web/key.js';

/** A Storage that remembers what it is given, and can be told to refuse. */
function memory(initial: Record<string, string> = {}, refuse: 'get' | 'set' | 'remove' | null = null) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem(name: string) {
      if (refuse === 'get') throw new Error('storage is blocked');
      return items.get(name) ?? null;
    },
    setItem(name: string, value: string) {
      if (refuse === 'set') throw new Error('storage is full');
      items.set(name, value);
    },
    removeItem(name: string) {
      if (refuse === 'remove') throw new Error('storage is blocked');
      items.delete(name);
    },
  };
}

describe('takeKey', () => {
  it('stores ?key=abc, calls replace with the URL minus key, and returns abc', () => {
    const storage = memory();
    const replaced: string[] = [];
    const key = takeKey({ search: '?key=abc', pathname: '/', hash: '' }, storage, (url) => replaced.push(url));
    assert.equal(key, 'abc');
    assert.equal(storage.items.get('duck-talk-key'), 'abc');
    assert.deepEqual(replaced, ['/']); // no stray `?`
  });

  it('keeps the other parameters, the path and the hash', () => {
    const replaced: string[] = [];
    takeKey({ search: '?a=1&key=abc&b=two%20words', pathname: '/chat', hash: '#top' }, memory(), (url) => replaced.push(url));
    assert.deepEqual(replaced, ['/chat?a=1&b=two+words#top']);
  });

  it('still returns the key from the URL when storage refuses it', () => {
    const replaced: string[] = [];
    const key = takeKey({ search: '?key=abc', pathname: '/', hash: '' }, memory({}, 'set'), (url) => replaced.push(url));
    assert.equal(key, 'abc');
    assert.deepEqual(replaced, ['/']);
  });

  it('prefers the key in the URL over the one it already holds', () => {
    const storage = memory({ 'duck-talk-key': 'old' });
    assert.equal(takeKey({ search: '?key=new', pathname: '/', hash: '' }, storage, () => {}), 'new');
    assert.equal(storage.items.get('duck-talk-key'), 'new');
  });

  it('falls back to storage when the URL has no key, and does not touch the address bar', () => {
    const replaced: string[] = [];
    const key = takeKey({ search: '', pathname: '/', hash: '' }, memory({ 'duck-talk-key': 'kept' }), (url) => replaced.push(url));
    assert.equal(key, 'kept');
    assert.deepEqual(replaced, []);
  });

  it('treats an empty ?key= as no key', () => {
    const replaced: string[] = [];
    const storage = memory({ 'duck-talk-key': 'kept' });
    assert.equal(takeKey({ search: '?key=', pathname: '/', hash: '' }, storage, (url) => replaced.push(url)), 'kept');
    assert.deepEqual(replaced, []);
  });

  it('returns null when there is no key anywhere', () => {
    assert.equal(takeKey({ search: '', pathname: '/', hash: '' }, memory(), () => {}), null);
  });

  it('tolerates storage that throws, and storage that is not there', () => {
    const loc = { search: '', pathname: '/', hash: '' };
    assert.equal(takeKey(loc, memory({ 'duck-talk-key': 'kept' }, 'get'), () => {}), null);
    assert.equal(takeKey(loc, null, () => {}), null);
    assert.equal(takeKey({ ...loc, search: '?key=abc' }, null, () => {}), 'abc');
  });
});

describe('keepKey', () => {
  it('stores the key where takeKey will find it', () => {
    const storage = memory();
    assert.equal(keepKey(storage, 'abc'), true);
    assert.equal(takeKey({ search: '', pathname: '/', hash: '' }, storage, () => {}), 'abc');
  });

  it('says false when storage refuses, and when there is none', () => {
    assert.equal(keepKey(memory({}, 'set'), 'abc'), false);
    assert.equal(keepKey(null, 'abc'), false);
  });
});

describe('forgetKey', () => {
  it('removes the stored key', () => {
    const storage = memory({ 'duck-talk-key': 'abc' });
    forgetKey(storage);
    assert.equal(storage.items.has('duck-talk-key'), false);
  });

  it('tolerates storage that throws, and storage that is not there', () => {
    forgetKey(memory({ 'duck-talk-key': 'abc' }, 'remove'));
    forgetKey(null);
  });
});

describe('hasStoredKey', () => {
  it('is true when a key is kept, false when none is', () => {
    assert.equal(hasStoredKey(memory({ 'duck-talk-key': 'abc' })), true);
    assert.equal(hasStoredKey(memory()), false);
  });

  it('is false for an empty key, for storage that throws, and for storage that is not there', () => {
    assert.equal(hasStoredKey(memory({ 'duck-talk-key': '' })), false);
    assert.equal(hasStoredKey(memory({ 'duck-talk-key': 'abc' }, 'get')), false);
    assert.equal(hasStoredKey(null), false);
  });

  it('turns false once the key is forgotten', () => {
    const storage = memory({ 'duck-talk-key': 'abc' });
    forgetKey(storage);
    assert.equal(hasStoredKey(storage), false);
  });
});

describe('socketUrl', () => {
  it('maps https to wss and http to ws', () => {
    assert.equal(socketUrl({ protocol: 'https:', host: 'duck.ts.net' }, {}, null), 'wss://duck.ts.net/');
    assert.equal(socketUrl({ protocol: 'http:', host: 'localhost:8765' }, {}, null), 'ws://localhost:8765/');
  });

  it('skips undefined params and appends the key last', () => {
    const url = socketUrl({ protocol: 'https:', host: 'duck.ts.net' }, { data: '1', chat: undefined, model: 'm' }, 'abc');
    assert.equal(url, 'wss://duck.ts.net/?data=1&model=m&key=abc');
  });

  it('leaves the key off when there is none', () => {
    assert.equal(socketUrl({ protocol: 'http:', host: 'h' }, { data: '1' }, null), 'ws://h/?data=1');
  });

  it('encodes values', () => {
    const url = socketUrl({ protocol: 'http:', host: 'h' }, { chat: 'a b&c=d' }, 'k/+');
    assert.equal(url, 'ws://h/?chat=a%20b%26c%3Dd&key=k%2F%2B');
  });
});

describe('needsKey: does this relay want a key at all', () => {
  /** A fetch that answers with `body` and `status`, and remembers what it was asked. */
  function answering(body: string, status = 200) {
    const asked: { url: string; init: unknown }[] = [];
    const fetchImpl = async (url: string, init?: unknown) => {
      asked.push({ url, init });
      return new Response(body, { status });
    };
    return { asked, fetchImpl };
  }
  const verdict = async (body: string, status = 200) => needsKey(answering(body, status).fetchImpl);

  it('asks /access.json, and not from the cache', async () => {
    const { asked, fetchImpl } = answering('{"required":true}');
    await needsKey(fetchImpl);
    assert.deepEqual(asked, [{ url: '/access.json', init: { cache: 'no-store' } }]);
  });

  it('is false only for a relay that says it is open', async () => {
    assert.equal(await verdict('{"required":false}'), false);
  });

  it('is true for a relay that says it wants a key', async () => {
    assert.equal(await verdict('{"required":true}'), true);
  });

  it('only the field matters: anything else in the object is ignored', async () => {
    assert.equal(await verdict('{"required":false,"extra":1}'), false);
  });

  it('fails closed, to the key form, on anything it cannot be sure of', async () => {
    assert.equal(await verdict('{"required":false}', 500), true, 'a server error');
    assert.equal(await verdict('{"required":false}', 404), true, 'an older relay with no such address');
    assert.equal(await verdict('not json'), true, 'a body that is not JSON');
    assert.equal(await verdict(''), true, 'an empty body');
    assert.equal(await verdict('{}'), true, 'no field');
    assert.equal(await verdict('{"required":"false"}'), true, 'the word, not the boolean');
    assert.equal(await verdict('{"required":0}'), true, 'falsy is not false');
    assert.equal(await verdict('{"required":null}'), true);
    assert.equal(await verdict('null'), true);
    assert.equal(await verdict('false'), true, 'a bare false is not an object');
    assert.equal(await verdict('[false]'), true);
    assert.equal(await verdict('[]'), true);
  });

  it('fails closed when the request fails, however it fails', async () => {
    assert.equal(await needsKey(() => Promise.reject(new Error('offline'))), true);
    assert.equal(await needsKey(() => { throw new Error('no fetch here'); }), true);
    assert.equal(await needsKey(async () => ({ ok: true, json: () => Promise.reject(new Error('cut off')) }) as unknown as Response), true);
  });
});
