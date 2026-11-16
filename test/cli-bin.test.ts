import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('CLI entrypoint', () => {
  it('starts with a Node shebang so the installed package bin runs on macOS and Linux', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.bin['mail-triage']).toBe('dist/node/cli/index.js');
    expect(pkg.files).toContain('dist');
    const source = readFileSync(new URL('../src/cli/index.ts', import.meta.url), 'utf8');
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});
