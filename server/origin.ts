/**
 * Which web pages may open a socket: the second gate, and the one a key cannot be.
 *
 * A browser lets any page it has loaded open a WebSocket to any address, the relay's
 * included, and it does not ask the relay first. With a key that page still needs the
 * key; with `--open` it needs nothing, and an open relay is Claude Code in your project
 * for whatever site is in a tab on a machine that can reach it. What the browser does
 * do is say where the page came from, in `Origin`, which a page cannot forge. So a
 * socket that brings an `Origin` has to come from somewhere a relay is served:
 * this machine, the local network, a tailnet — and a name `DUCK_TALK_ORIGINS` adds,
 * for a reverse proxy or a domain of your own. A caller that sends none — the iPhone
 * app, `ws`, curl, the probe — is not a browser, and is let through to the key.
 *
 * It is the page's hostname that is checked, not that it matches `Host`: a rebound DNS
 * name makes the two agree, and a hostname that resolves to this machine is not one a
 * hostile page can borrow without being on the list.
 */

/** `DUCK_TALK_ORIGINS`, read: exact hostnames and `*.suffix`, lower-case, empty entries gone. */
export function extraOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '' && entry !== '*.');
}

/** The hostname an `Origin` names, lower-case and unbracketed — or null for one that is not an http(s) URL. */
function hostOf(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return host === '' ? null : host;
}

/** For the log: the hostname alone, never the rest of what a stranger sent. */
export function originHost(origin: string): string {
  if (origin === 'null') return 'null';
  return hostOf(origin) ?? '(unreadable)';
}

/** Whether a socket bringing this `Origin` header may go on to the key check. */
export function originAllowed(origin: string | undefined, extra: string[] = []): boolean {
  if (origin === undefined) return true;
  const host = hostOf(origin);
  if (host === null) return false;
  return local(host) || extra.some((entry) => (entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry));
}

/** This machine, the local network, or a tailnet. */
function local(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.ts.net') || host.endsWith('.local')) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (host.includes(':')) {
    if (host === '::1') return true;
    const first = parseInt(host.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // ULA fc00::/7, link-local fe80::/10
  }
  // A single label — `mybox` — is a name only a local resolver answers.
  return !host.includes('.');
}
