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
  const fromUrl = params.get('key');

  if (fromUrl) {
    keepKey(storage, fromUrl); // if it cannot be kept it still opens this page
    params.delete('key');
    const rest = params.toString();
    replace(loc.pathname + (rest ? `?${rest}` : '') + loc.hash);
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

/**
 * Whether this relay wants a key, for a page that has none. A relay started with `--open`
 * checks nothing, and says so at `/access.json`; false is only ever that answer, read whole.
 * Everything else — no answer, a refusal, a body that is not that — is true, because the
 * mistake that costs a person a form they can fill in is better than the one that boots an
 * app whose every socket is refused.
 *
 * @param {(url: string, init: { cache: 'no-store' }) => Promise<Pick<Response, 'ok' | 'json'>>} fetchImpl
 * @returns {Promise<boolean>}
 */
export async function needsKey(fetchImpl) {
  try {
    const res = await fetchImpl('/access.json', { cache: 'no-store' });
    if (!res.ok) return true;
    const body = await res.json();
    return !(typeof body === 'object' && body !== null && !Array.isArray(body) && body.required === false);
  } catch {
    return true;
  }
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
