/**
 * The client's files, served from the relay's own port: the page is a few static
 * files in `web/`, so the relay is also the web server and there is nothing else to
 * run, and being served from the relay's origin is what lets the page open its
 * WebSocket without a cross-origin dance.
 *
 * The one thing that must not go wrong is the path. A request names a file, and a
 * stranger chooses the name, so anything that resolves outside `root` is simply not
 * found — a 404, never a 403 that confirms there was something there. These files
 * hold no secrets (the key rides the WebSocket, not a page), so there is no gate here.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { type FileHandle, open } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';

// A Map, not an object: `x.constructor` is a file name a stranger can ask for, and an
// object would answer it with a function.
const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.wav', 'audio/wav'],
  ['.json', 'application/json'],
  ['.webmanifest', 'application/manifest+json'],
]);

// no-cache, not no-store: the browser may keep a copy but must ask before using it, so
// an edit shows on the next reload and an unchanged file costs one round trip.
const HEADERS = {
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/**
 * The file a request URL names, as an absolute path inside `base`, or null if it names
 * none. `base` is already resolved. The query string is not part of the name.
 */
function target(base: string, url: string | undefined): string | null {
  const raw = (url ?? '').split(/[?#]/, 1)[0] ?? '';
  if (!raw.startsWith('/')) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // a bad escape names nothing
  }
  // Decoded, so `%00` and `%5c` are caught as well as the literal characters. A
  // backslash is a separator on some platforms and this relay should not care which.
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  // Prefixing a dot keeps `/etc/passwd` and `//etc/passwd` relative to the root, and
  // `resolve` then settles every `..`. What is left is inside `base` or it is not.
  const file = resolve(base, '.' + (decoded === '/' ? '/index.html' : decoded));
  return file.startsWith(base + sep) ? file : null;
}

function refuse(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...extra });
  res.end(message);
}

async function serve(base: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    refuse(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }
  const file = target(base, req.url);
  if (!file) return refuse(res, 404, 'Not found');

  // Open once and ask the handle, so what is measured is what is sent even if the file
  // is replaced meanwhile.
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG') return refuse(res, 404, 'Not found');
    throw err;
  }

  let streaming = false;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return refuse(res, 404, 'Not found'); // a directory is not a listing

    res.writeHead(200, {
      ...HEADERS,
      'Content-Type': TYPES.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
      'Content-Length': info.size,
    });
    if (req.method === 'HEAD') return void res.end();

    // The stream closes the handle when it ends or is destroyed. A client that goes away
    // mid-file tears both down through `pipeline`, and that is not an error worth a log.
    pipeline(handle.createReadStream(), res, () => {});
    streaming = true;
  } finally {
    if (!streaming) await handle.close();
  }
}

/** A request handler serving the files under `root`: `GET` and `HEAD`, `/` being `index.html`. */
export function webHandler(root: string): (req: IncomingMessage, res: ServerResponse) => void {
  const base = resolve(root);
  return (req, res) => {
    serve(base, req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else refuse(res, 500, 'Internal server error');
    });
  };
}
