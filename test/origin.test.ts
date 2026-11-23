import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extraOrigins, originAllowed, originHost } from '../server/origin.ts';

describe('originAllowed', () => {
  it('lets in a caller that sends no Origin: the app, ws, curl, the probe', () => {
    assert.equal(originAllowed(undefined), true);
  });

  const allowed = [
    'http://localhost:8765',
    'http://LOCALHOST:8765',
    'https://localhost',
    'http://duck.localhost:8765',
    'http://127.0.0.1:8765',
    'http://127.4.5.6',
    'http://[::1]:8765',
    'http://10.0.0.1:8765',
    'http://10.255.255.255',
    'http://172.16.0.1',
    'http://172.31.255.254:8765',
    'http://192.168.1.116:8790',
    'http://169.254.10.20',
    'http://[fd12:3456::1]:8765',
    'http://[fc00::1]',
    'http://[fe80::1]:8765',
    'http://[febf::1]',
    'https://box.tail1234.ts.net',
    'https://Box.Tail1234.TS.NET',
    'http://macbook.local:8765',
    'http://mybox:8765',
  ];
  for (const origin of allowed) {
    it(`allows ${origin}`, () => assert.equal(originAllowed(origin), true));
  }

  const refused = [
    'http://evil.example',
    'https://evil.example:8765',
    'http://localhost.evil.example',
    'http://ts.net.evil.example',
    'https://ts.net',
    'http://127.0.0.1.evil.example',
    'http://10.0.0.1.evil.example',
    'http://192.168.1.1.evil.example',
    'http://local.evil.example',
    'http://a.b',
    'http://8.8.8.8',
    'http://172.15.0.1',
    'http://172.32.0.1',
    'http://192.169.0.1',
    'http://[2001:db8::1]',
    'http://[fec0::1]',
    'http://[::ffff:127.0.0.1]',
    '[::1]',
    'localhost',
    'null',
    '',
    'http://',
    'http://[',
    'not a url',
    'chrome-extension://abcdefghijklmnop',
    'file:///etc/passwd',
  ];
  for (const origin of refused) {
    it(`refuses ${JSON.stringify(origin)}`, () => assert.equal(originAllowed(origin), false));
  }

  it('lets DUCK_TALK_ORIGINS name a host exactly', () => {
    const extra = extraOrigins('evil.example');
    assert.equal(originAllowed('https://evil.example', extra), true);
    assert.equal(originAllowed('https://sub.evil.example', extra), false);
    assert.equal(originAllowed('https://notevil.example', extra), false);
  });

  it('lets DUCK_TALK_ORIGINS name every host under a suffix with *.', () => {
    const extra = extraOrigins('*.corp.example');
    assert.equal(originAllowed('https://duck.corp.example', extra), true);
    assert.equal(originAllowed('https://a.b.corp.example', extra), true);
    assert.equal(originAllowed('https://corp.example.evil', extra), false);
    assert.equal(originAllowed('https://evilcorp.example', extra), false);
  });

  it('reads DUCK_TALK_ORIGINS as a trimmed, comma-separated list, empty entries ignored', () => {
    assert.deepEqual(extraOrigins(' Duck.Example.com , ,*.Corp.Example,'), ['duck.example.com', '*.corp.example']);
    assert.deepEqual(extraOrigins(undefined), []);
    assert.deepEqual(extraOrigins('  '), []);
    assert.equal(originAllowed('https://duck.example.com', extraOrigins(' Duck.Example.com , ,*.Corp.Example,')), true);
    // An empty entry is not a wildcard for everything.
    assert.equal(originAllowed('https://evil.example', extraOrigins(',')), false);
    assert.equal(originAllowed('https://evil.example', extraOrigins('*.')), false);
  });

  it('does not let DUCK_TALK_ORIGINS let in an Origin that is not a URL', () => {
    assert.equal(originAllowed('null', extraOrigins('null')), false);
  });
});

describe('originHost', () => {
  it('is the hostname alone, for the log line — never the path, query or credentials', () => {
    assert.equal(originHost('https://user:pw@Evil.Example:8443/x?key=secret'), 'evil.example');
    assert.equal(originHost('http://[::1]:8765'), '::1');
  });

  it('says what it could not read without repeating it', () => {
    assert.equal(originHost('null'), 'null');
    assert.equal(originHost('not a url ?key=secret'), '(unreadable)');
  });
});
