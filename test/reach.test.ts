import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { webLines } from '../server/reach.ts';

const reach = {
  port: 8765,
  wifi: 'ws://192.168.1.20:8765',
  anywhereHost: 'laptop.tail1234.ts.net',
  anywhere: 'wss://laptop.tail1234.ts.net',
};

/** A row's label and value, split the way the startup lines are laid out. */
function rows(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const m = /^ {2}(\S.*?) {2,}(\S.*)$/.exec(line);
    assert.ok(m, `not a startup row: ${JSON.stringify(line)}`);
    out[m[1]!] = m[2]!;
  }
  return out;
}

describe('webLines', () => {
  it('says the tailnet, localhost and LAN addresses, each with the key', () => {
    assert.deepEqual(rows(webLines(reach, 'k3y')), {
      web: 'https://laptop.tail1234.ts.net/?key=k3y',
      localhost: 'http://localhost:8765/?key=k3y',
      'web Wi-Fi': 'http://192.168.1.20:8765/?key=k3y  typing only — no microphone off localhost',
    });
  });

  it('lines the rows up with the address rows above them', () => {
    for (const line of webLines(reach, 'k3y')) assert.match(line, /^ {2}\S.{10} +\S/);
    assert.ok(webLines(reach, 'k3y').every((line) => line.indexOf('http') === 15));
  });

  it('shows what anywhere says, not a URL, when the tailnet has no door onto this port', () => {
    const lines = webLines({ ...reach, anywhereHost: null, anywhere: 'run once on this machine:  tailscale serve --bg 8765' }, 'k3y');
    const r = rows(lines);
    assert.equal(r['web'], 'run once on this machine:  tailscale serve --bg 8765');
    assert.equal(r['localhost'], 'http://localhost:8765/?key=k3y');
  });

  it('leaves out the LAN row when there is no private address', () => {
    assert.deepEqual(Object.keys(rows(webLines({ ...reach, wifi: null }, 'k3y'))), ['web', 'localhost']);
  });

  it('puts no key anywhere when the relay is open', () => {
    const lines = webLines(reach, null);
    assert.ok(!lines.join('\n').includes('key'));
    assert.deepEqual(rows(lines), {
      web: 'https://laptop.tail1234.ts.net/',
      localhost: 'http://localhost:8765/',
      'web Wi-Fi': 'http://192.168.1.20:8765/  typing only — no microphone off localhost',
    });
  });

  it('escapes a key that DUCK_TALK_KEY made up, so the address still parses', () => {
    const url = rows(webLines(reach, 'a b&c#d'))['localhost']!;
    assert.equal(new URL(url).searchParams.get('key'), 'a b&c#d');
  });
});
