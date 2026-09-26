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
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
    include: [
      'three', 'postprocessing', 'n8ao', 'proj4', 'earcut', 'three-mesh-bvh', 'three-gpu-pathtracer',
      '@takram/three-atmosphere', '@takram/three-atmosphere/shaders/bruneton',
      '@takram/three-geospatial', '@takram/three-geospatial/shaders', '@dgreenheck/ez-tree',
    ],
  },
});
