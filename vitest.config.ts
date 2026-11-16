import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // Node by default; UI tests opt into jsdom with a file-level comment.
    environment: 'node',
    restoreMocks: true,
  },
});
