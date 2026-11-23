// @ts-check
// The access key, on the browser's side: first visit arrives with `?key=` from the URL
// the relay printed, the page keeps it in localStorage and takes it out of the address bar
// (so it is not in the history, or on a screen, or in a screenshot), and every later visit
// reads it back. localStorage can be missing or refuse (a private window, blocked site data),
// so every touch of it is in a try/catch, and a key that could not be kept is still good for
// this page load.

const STORAGE_NAME = 'duck-talk-key';

/** @typedef {Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>} KeyStorage */

/**
 * The key to connect with, or null if the page has none: the one in the URL (stored, and
 * removed from the address bar through `replace`), else the one kept from before.
 *
 * @param {{ search: string, pathname: string, hash: string }} loc
 * @param {KeyStorage | null} storage
 * @param {(url: string) => void} replace
 * @returns {string | null}
 */
export function takeKey(loc, storage, replace) {
  const params = new URLSearchParams(loc.search);
  const fromUrl = params.getAll('key').find(Boolean); // `?key=&key=abc` has one, and `?key=` has none

  if (fromUrl) {
    keepKey(storage, fromUrl); // if it cannot be kept it still opens this page
    params.delete('key'); // every one of them, empty or not
    const rest = params.toString();
    try {
      replace(loc.pathname + (rest ? `?${rest}` : '') + loc.hash);
    } catch {
      // history.replaceState refuses some addresses (`//index.html` reads as another origin) and
      // some sandboxes: the key is in the address bar a little longer, and the page still opens.
    }
    return fromUrl;
  }

  try {
    return storage?.getItem(STORAGE_NAME) || null;
  } catch {
    return null;
  }
}

/**
 * Stores the key; false if the browser would not.
 * @param {KeyStorage | null} storage
 * @param {string} key
 */
export function keepKey(storage, key) {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_NAME, key);
    return true;
  } catch {
    return false;
  }
}

/** Whether a key is kept in storage, as opposed to held for this page load only. @param {Pick<KeyStorage, 'getItem'> | null} storage */
export function hasStoredKey(storage) {
  try {
    return !!storage?.getItem(STORAGE_NAME);
  } catch {
    return false;
  }
}

/** Drops the stored key: a relay that refused it, or the person asking to be rid of it. @param {KeyStorage | null} storage */
export function forgetKey(storage) {
  try {
    storage?.removeItem(STORAGE_NAME);
  } catch {
    // Nothing to forget that we could reach.
  }
}

/** @typedef {(url: string, init: { cache: 'no-store', signal: AbortSignal }) => Promise<Pick<Response, 'ok' | 'json'>>} AccessFetch */

/** How long `/access.json` is waited for before the answer is "could not tell". */
const ACCESS_TIMEOUT = 4000;

/**
 * What this relay says about its key, at `/access.json`: `'open'` (started with --open, so no key
 * is checked), `'keyed'` (one is), or `'unknown'` — no answer in `timeoutMs`, a refusal, a body that
 * is not that answer. Read whole, as `{"required": <boolean>}`, and nothing else counts.
 *
 * Two pages ask. One with no key, deciding whether to show the form; and one whose key the relay
 * will not take, which a browser cannot see — a WebSocket refused on the upgrade looks exactly like
 * one that found no relay — and which asks so as to tell those two apart (relay.js).
 *
 * @param {AccessFetch} fetchImpl
 * @param {number} [timeoutMs]
 * @returns {Promise<'open' | 'keyed' | 'unknown'>}
 */
export async function accessState(fetchImpl, timeoutMs = ACCESS_TIMEOUT) {
  const abort = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  // A fetch that ignores its signal still loses the race: the page is not held on it either way.
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve('unknown');
    }, timeoutMs);
  });
  const asked = (async () => {
    try {
      const res = await fetchImpl('/access.json', { cache: 'no-store', signal: abort.signal });
      if (!res.ok) return 'unknown';
      const body = await res.json();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'unknown';
      if (body.required === false) return 'open';
      if (body.required === true) return 'keyed';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  })();
  try {
    return /** @type {'open' | 'keyed' | 'unknown'} */ (await Promise.race([asked, late]));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether this relay wants a key, for a page that has none. A relay started with `--open`
 * checks nothing, and says so at `/access.json`; false is only ever that answer, read whole.
 * Everything else — no answer, one that does not come in time, a refusal, a body that is not
 * that — is true, because the mistake that costs a person a form they can fill in is better than
 * the one that boots an app whose every socket is refused, or a page that stays blank.
 *
 * @param {AccessFetch} fetchImpl
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function needsKey(fetchImpl, timeoutMs = ACCESS_TIMEOUT) {
  return (await accessState(fetchImpl, timeoutMs)) !== 'open';
}

/**
 * The relay's WebSocket address for this page's origin. The key goes last, and only if
 * there is one.
 *
 * @param {{ protocol: string, host: string }} base  `location` or the like
 * @param {Record<string, string | undefined>} params
 * @param {string | null} key
 */
export function socketUrl(base, params, key) {
  const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:';
  /** @type {string[]} */
  const pairs = [];
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  }
  if (key !== null) pairs.push(`key=${encodeURIComponent(key)}`);
  return `${scheme}//${base.host}/${pairs.length ? `?${pairs.join('&')}` : ''}`;
}
