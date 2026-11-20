import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Read VITE_* variables from the repository-root .env. Only VITE_* reach the browser.
  envDir: repoRoot,
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Same-origin API calls in development; CORS on the API stays restricted.
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } },
  },
  preview: { port: 4173, proxy: { '/api': 'http://127.0.0.1:3000' } },
  // dist/.vite/manifest.json lets scripts/check-bundle.mjs compute per-route budgets.
  build: { manifest: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
