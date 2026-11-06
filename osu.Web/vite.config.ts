import { defineConfig } from 'vite';

// `base` is relative so the build works from any sub-path (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // The artifact build ships without source maps (it is published as a handful of files).
    sourcemap: process.env.VITE_TARGET !== 'artifact',
  },
  test: {
    environment: 'node',
  },
} as any);
