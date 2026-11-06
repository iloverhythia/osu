import { defineConfig } from 'vite';

// `base` is relative so the build works from any sub-path (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // The artifact build ships without source maps (it is published as a handful of files).
    sourcemap: process.env.VITE_TARGET !== 'artifact',
    // The artifact is published as one script and one stylesheet: lazily loaded screens are bundled in.
    rollupOptions: process.env.VITE_TARGET === 'artifact' ? { output: { inlineDynamicImports: true } } : {},
  },
  test: {
    environment: 'node',
  },
} as any);
