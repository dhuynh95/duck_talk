import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// What the transcript, a chat title or a tool name might say is somebody else's text.
// The client only ever puts it on the page as text, and these are the ways of putting
// something on the page that would read it as markup instead.
const BANNED = /innerHTML|outerHTML|insertAdjacentHTML|document\s*\.\s*write|createContextualFragment|parseFromString/;

const root = new URL('../web/', import.meta.url);

/** `name:line` for every line of `text` that uses a banned call. */
function scan(name: string, text: string): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, index) => {
    if (BANNED.test(line)) hits.push(`${name}:${index + 1}`);
  });
  return hits;
}

/** The files under web/ that are the client's own code and markup. */
function clientFiles(): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) => /\.(js|html)$/.test(file));
}

describe('web/ puts text on the page as text', () => {
  it('no file under web/ uses innerHTML, outerHTML, insertAdjacentHTML, document.write, createContextualFragment or parseFromString', () => {
    const files = clientFiles();
    // A walk that found nothing would pass for the wrong reason.
    assert.ok(files.includes('index.html'), `web/index.html was not found among ${files.join(', ')}`);
    assert.ok(files.includes('main.js'), `web/main.js was not found among ${files.join(', ')}`);

    const hits = files.flatMap((file) => scan(`web/${file}`, readFileSync(join(root.pathname, file), 'utf8')));
    assert.deepEqual(hits, [], `markup-parsing calls at:\n${hits.join('\n')}`);
  });

  it('the scan sees each banned call, and names the line', () => {
    for (const call of [
      'el.innerHTML = x;',
      'el.outerHTML = x;',
      'el.insertAdjacentHTML("beforeend", x);',
      'document.write(x);',
      'document . write(x);',
      'range.createContextualFragment(x);',
      'new DOMParser().parseFromString(x, "text/html");',
    ]) {
      assert.deepEqual(scan('planted.js', `const fine = 1;\n${call}\n`), ['planted.js:2'], call);
    }
  });

  it('the scan leaves alone code that sets text', () => {
    assert.deepEqual(scan('fine.js', 'el.textContent = x;\nel.append(document.createTextNode(x));\n'), []);
  });
});
