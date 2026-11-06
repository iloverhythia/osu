import { defineConfig } from 'vite';

// `base` is relative so the build works from any sub-path (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
  },
} as any);
