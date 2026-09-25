// Registry of feature modules. Each lives in src/modules/<id>/index.ts and
// default-exports a CityModule. Modules are loaded in parallel with dynamic
// import(); a module that fails to load or init is reported and skipped.
import type { CityModule } from '../core/context';

export const MODULES: Array<{ id: string; load: () => Promise<{ default: CityModule }> }> = [
  { id: 'sky', load: () => import('./sky') },
  { id: 'terrain', load: () => import('./terrain') },
  { id: 'water', load: () => import('./water') },
  { id: 'roads', load: () => import('./roads') },
  { id: 'buildings', load: () => import('./buildings') },
  { id: 'vegetation', load: () => import('./vegetation') },
  { id: 'landmarks', load: () => import('./landmarks') },
  { id: 'traffic', load: () => import('./traffic') },
  { id: 'physics', load: () => import('./physics') },
  { id: 'pathtracer', load: () => import('./pathtracer') },
  { id: 'ui', load: () => import('./ui') },
];
