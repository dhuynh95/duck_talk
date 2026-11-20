import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// The page's viewport meta is what makes a phone's keyboard resize the layout rather than cover the
// composer, and nothing but this would notice it lost.

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const viewport = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(html)?.[1] ?? '';

describe('web/index.html viewport', () => {
  it('has a viewport meta', () => {
    assert.ok(viewport, 'no <meta name="viewport"> found');
  });

  it('covers the display cutouts, and lets the on-screen keyboard resize the page so the composer stays above it', () => {
    const parts = viewport.split(',').map((part) => part.trim());
    assert.ok(parts.includes('viewport-fit=cover'), viewport);
    assert.ok(parts.includes('interactive-widget=resizes-content'), viewport);
  });
});
