import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('public app renderer source', () => {
  it('does not contain literal HTML entity source text for middle dots', () => {
    const source = readFileSync(resolve(process.cwd(), 'public/app.js'), 'utf8');
    expect(source).not.toContain('&middot;');
    expect(source).toContain(' · ');
  });
});
