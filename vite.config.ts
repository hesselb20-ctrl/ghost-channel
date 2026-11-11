import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Static multi-page build. `base: './'` keeps every asset path relative so the
// same dist/ folder works on GitHub Pages under any repository name.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        send: resolve(import.meta.dirname, 'send/index.html'),
        receive: resolve(import.meta.dirname, 'receive/index.html'),
        abtest: resolve(import.meta.dirname, 'abtest/index.html'),
      },
    },
  },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120000 },
});
