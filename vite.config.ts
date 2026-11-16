import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.API_URL ?? 'http://localhost:8787';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    // changeOrigin rewrites Host to the API's own host so its Host allowlist accepts it.
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
  },
});
