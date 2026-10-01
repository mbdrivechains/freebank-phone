import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte({ hot: false })],
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
