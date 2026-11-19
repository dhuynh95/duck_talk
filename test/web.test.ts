import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { webHandler } from '../server/web.ts';

const SECRET = 'the-text-that-must-never-be-served';
const APP_JS = 'export const answer = 42;\n';

// The served root is `outer/web`; the secret and a second directory whose name begins
// with the root's sit beside it, so a path that escapes the root actually finds them.
const outer = mkdtempSync(join(tmpdir(), 'duck-talk-web-'));
const root = join(outer, 'web');
mkdirSync(join(root, 'sub'), { recursive: true });
mkdirSync(join(outer, 'web-other'));
writeFileSync(join(root, 'index.html'), '<!doctype html><title>duck</title>');
writeFileSync(join(root, 'app.js'), APP_JS);
writeFileSync(join(root, 'style.css'), 'body { margin: 0 }');
writeFileSync(join(root, 'sub', 'page.js'), 'export {};');
writeFileSync(join(outer, 'secret.txt'), SECRET);
writeFileSync(join(outer, 'web-other', 'leak.txt'), SECRET);

const server = http.createServer(webHandler(root));
let port = 0;
before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  server.close();
  rmSync(outer, { recursive: true, force: true });
});

/** A request whose path goes out exactly as written — `fetch` would tidy `/../` away before the server saw it. */
function request(method: string, path: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('webHandler', () => {
  it('GET / serves index.html as text/html', async () => {
    const res = await request('GET', '/');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/html(;|$)/);
    assert.match(res.body, /<title>duck<\/title>/);
  });

  it('GET /app.js is text/javascript and carries the file', async () => {
    const res = await request('GET', '/app.js');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/javascript(;|$)/);
    assert.equal(res.body, APP_JS);
    assert.equal(res.headers['content-length'], String(APP_JS.length));
  });

  it('serves css, and a file in a subdirectory', async () => {
    const css = await request('GET', '/style.css');
    assert.equal(css.status, 200);
    assert.match(String(css.headers['content-type']), /^text\/css(;|$)/);
    const nested = await request('GET', '/sub/page.js');
    assert.equal(nested.status, 200);
    assert.equal(nested.body, 'export {};');
  });

  it('ignores a query string', async () => {
    const res = await request('GET', '/app.js?v=7');
    assert.equal(res.status, 200);
    assert.equal(res.body, APP_JS);
  });

  it('answers every response with no-cache, nosniff and no-referrer', async () => {
    for (const path of ['/app.js', '/missing']) {
      const res = await request('GET', path);
      assert.equal(res.headers['cache-control'], 'no-cache', path);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
      assert.equal(res.headers['referrer-policy'], 'no-referrer', path);
    }
  });

  it('HEAD /style.css is 200 with the file size as content-length and no body', async () => {
    const res = await request('HEAD', '/style.css');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-length'], String('body { margin: 0 }'.length));
    assert.equal(res.body, '');
  });

  it('GET /missing is 404', async () => {
    const res = await request('GET', '/missing');
    assert.equal(res.status, 404);
  });

  it('a directory is 404, not a listing', async () => {
    assert.equal((await request('GET', '/sub')).status, 404);
    assert.equal((await request('GET', '/sub/')).status, 404);
  });

  it('POST / is 405, and says what is allowed', async () => {
    const res = await request('POST', '/');
    assert.equal(res.status, 405);
    assert.equal(res.headers['allow'], 'GET, HEAD');
  });

  describe('a path that is not inside the root is 404 and never reads outside it', () => {
    const paths = [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/..%2Fsecret.txt',
      '/sub/../../secret.txt',
      '/sub/%2e%2e/%2e%2e/secret.txt',
      '/../web-other/leak.txt', // a sibling whose name starts with the root's
      '/..\\secret.txt',
      '/..%5csecret.txt',
      '//etc/passwd',
      '/%00',
      '/app.js%00.png',
      '/%zz', // a bad escape
      '/%E0%A4%A',
    ];
    for (const path of paths) {
      it(path, async () => {
        const res = await request('GET', path);
        assert.equal(res.status, 404);
        assert.ok(!res.body.includes(SECRET));
      });
    }
  });
});
