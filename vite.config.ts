import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
  server: { fs: { strict: false } },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
