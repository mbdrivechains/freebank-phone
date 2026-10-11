import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFileSync } from 'node:fs';

// The page's version, shown in its footer: the app release it goes with (package.json).
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  plugins: [svelte({ hot: false })],
  define: { __PAGE_VERSION__: JSON.stringify(version) },
  base: './',
  build: {
    outDir: 'dist',
    target: ['safari16', 'chrome109', 'firefox115'],
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0, // everything as files: the relay's CSP allows only 'self'
    sourcemap: false,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['src/test-setup.ts'],
  },
});
