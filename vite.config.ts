import { defineConfig } from 'vitest/config';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = import.meta.dirname;

// Camera access needs HTTPS on anything but localhost. If a certificate pair
// exists in .cert/ (see the README: mkcert), the dev and preview servers use it.
const certFile = resolve(root, '.cert/cert.pem');
const keyFile = resolve(root, '.cert/key.pem');
const https = existsSync(certFile) && existsSync(keyFile) ? { cert: readFileSync(certFile), key: readFileSync(keyFile) } : undefined;

// Hosts other than localhost that may reach the dev server: free Cloudflare
// quick tunnels (README) hand out names under trycloudflare.com.
const allowedHosts = ['.trycloudflare.com'];

// Static multi-page build. `base: './'` keeps every asset path relative so the
// same dist/ folder works on GitHub Pages under any repository name.
export default defineConfig({
  base: './',
  server: { https, allowedHosts },
  preview: { https, allowedHosts },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        send: resolve(root, 'send/index.html'),
        receive: resolve(root, 'receive/index.html'),
        abtest: resolve(root, 'abtest/index.html'),
      },
    },
  },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120000 },
});
