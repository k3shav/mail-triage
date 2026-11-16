// Build steps around `tsc`: `clean` removes old output; `assets` copies the
// setup page's static files next to the compiled module that serves them.
import { cpSync, rmSync } from 'node:fs';

const step = process.argv[2];
if (step === 'clean') rmSync('dist', { recursive: true, force: true });
else if (step === 'assets') cpSync('src/server/setup/public', 'dist/node/server/setup/public', { recursive: true });
else throw new Error('usage: node scripts/build.mjs clean|assets');
