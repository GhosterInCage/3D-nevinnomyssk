// Species definitions. Numeric ids match pipeline/vegetation_species.py (data file ids).
import type { GenParams } from './treegen';

export type BarkKind = 'oak' | 'willow' | 'pine' | 'birch';

export interface SpeciesDef {
  id: number;
  name: string;
  kind: 'tree' | 'shrub' | 'hedge';
  gen: GenParams;
  bark: BarkKind;
  barkTint: [number, number, number];
  leafTint: [number, number, number];
  /** 0..1 how much light passes through the foliage */
  translucency: number;
  /** leaf specular roughness */
  roughness: number;
  /** number of generated model variants (different seeds) */
  variants?: number;
}

// Leaf atlas cells (see pipeline/vegetation_textures.py)
const C = {
  poplar: 0, whitePoplar: 1, willow: 2, robinia: 3, chestnut: 4, linden: 5, maple: 6, elm: 7,
  walnut: 8, fruit: 9, oak: 10, birch: 11, pine: 12, spruce: 13, thuja: 14, shrub: 15,
};

const T = (r: number, g: number, b: number): [number, number, number] => [r, g, b];

export const SPECIES: SpeciesDef[] = [
  {
    id: 0, name: 'poplar_italica', kind: 'tree', variants: 2, bark: 'willow', barkTint: T(0.95, 0.93, 0.88), leafTint: T(0.95, 1.0, 0.92), translucency: 0.55, roughness: 0.80,
    gen: { kind: 'broadleaf', seed: 101, height: 22, crown: 5.4, envelope: 'column', crownBase: 0.03, points: 1000, segment: 0.55, influence: 2.4, kill: 0.9, tropism: 0.6, trunkRadius: 0.32, tipRadius: 0.012, leafSize: 1.0, leafDensity: 4.06, leafCell: C.poplar, leafTilt: 0.45, clumps: 12, clumpSize: 0.55 },
  },
  {
    id: 1, name: 'poplar_black', kind: 'tree', variants: 2, bark: 'oak', barkTint: T(0.85, 0.82, 0.78), leafTint: T(0.95, 1.0, 0.9), translucency: 0.5, roughness: 0.80,
    gen: { kind: 'broadleaf', seed: 102, height: 23, crown: 13, envelope: 'irregular', crownBase: 0.32, points: 1000, segment: 0.75, influence: 4.2, kill: 1.3, tropism: 0.12, trunkRadius: 0.48, leafSize: 1.35, leafDensity: 3.62, leafCell: C.poplar, clumps: 9, clumpSize: 0.36, lean: 0.12 },
  },
  {
    id: 2, name: 'poplar_white', kind: 'tree', bark: 'willow', barkTint: T(1.35, 1.35, 1.3), leafTint: T(1.0, 1.05, 1.0), translucency: 0.5, roughness: 0.88,
    gen: { kind: 'broadleaf', seed: 103, height: 21, crown: 12, envelope: 'dome', crownBase: 0.3, points: 950, segment: 0.7, influence: 4.0, kill: 1.25, tropism: 0.14, trunkRadius: 0.45, leafSize: 1.3, leafDensity: 3.62, leafCell: C.whitePoplar, clumps: 9, clumpSize: 0.38, lean: 0.12 },
  },
  {
    id: 3, name: 'willow', kind: 'tree', variants: 2, bark: 'willow', barkTint: T(0.85, 0.8, 0.72), leafTint: T(1.0, 1.0, 0.95), translucency: 0.6, roughness: 0.93,
    gen: { kind: 'broadleaf', seed: 104, height: 15, crown: 13, envelope: 'weeping', crownBase: 0.2, stems: 2, lean: 0.25, points: 720, segment: 0.6, influence: 3.6, kill: 1.1, tropism: -0.05, trunkRadius: 0.42, leafSize: 1.2, leafDensity: 2.9, leafCell: C.willow, leafDroop: 0.45, leafTilt: 0.5, clumps: 9, clumpSize: 0.4 },
  },
  {
    id: 4, name: 'robinia', kind: 'tree', variants: 2, bark: 'oak', barkTint: T(0.8, 0.72, 0.62), leafTint: T(1.0, 1.0, 0.92), translucency: 0.65, roughness: 0.88,
    gen: { kind: 'broadleaf', seed: 105, height: 15, crown: 9.5, envelope: 'irregular', crownBase: 0.42, points: 650, segment: 0.6, influence: 3.4, kill: 1.2, tropism: 0.08, trunkRadius: 0.3, leafSize: 1.15, leafDensity: 3.19, leafCell: C.robinia, leafTilt: 0.7, clumps: 7, clumpSize: 0.3, lean: 0.15 },
  },
  {
    id: 5, name: 'chestnut', kind: 'tree', bark: 'oak', barkTint: T(0.78, 0.72, 0.66), leafTint: T(0.95, 1.0, 0.9), translucency: 0.4, roughness: 0.80,
    gen: { kind: 'broadleaf', seed: 106, height: 16, crown: 11, envelope: 'ovate', crownBase: 0.2, points: 950, segment: 0.6, influence: 3.4, kill: 1.0, tropism: 0.1, trunkRadius: 0.42, leafSize: 1.45, leafDensity: 3.12, leafCell: C.chestnut, clumps: 12, clumpSize: 0.42 },
  },
  {
    id: 6, name: 'linden', kind: 'tree', bark: 'willow', barkTint: T(0.8, 0.78, 0.74), leafTint: T(1.0, 1.0, 0.92), translucency: 0.5, roughness: 0.80,
    gen: { kind: 'broadleaf', seed: 107, height: 18, crown: 10, envelope: 'ovate', crownBase: 0.22, points: 1000, segment: 0.6, influence: 3.2, kill: 1.0, tropism: 0.15, trunkRadius: 0.38, leafSize: 1.15, leafDensity: 3.92, leafCell: C.linden, clumps: 12, clumpSize: 0.42 },
  },
  {
    id: 7, name: 'maple', kind: 'tree', variants: 2, bark: 'willow', barkTint: T(0.7, 0.68, 0.64), leafTint: T(1.0, 1.0, 0.92), translucency: 0.5, roughness: 0.80,
    gen: { kind: 'broadleaf', seed: 108, height: 14, crown: 10.5, envelope: 'round', crownBase: 0.22, points: 900, segment: 0.55, influence: 3.0, kill: 0.95, tropism: 0.12, trunkRadius: 0.34, leafSize: 1.15, leafDensity: 3.12, leafCell: C.maple, clumps: 10, clumpSize: 0.4 },
  },
  {
    id: 8, name: 'boxelder', kind: 'tree', bark: 'willow', barkTint: T(0.78, 0.76, 0.66), leafTint: T(0.85, 0.95, 0.8), translucency: 0.6, roughness: 0.88,
    gen: { kind: 'broadleaf', seed: 109, height: 10, crown: 9, envelope: 'irregular', crownBase: 0.16, stems: 3, lean: 0.3, points: 700, segment: 0.45, influence: 2.6, kill: 0.85, tropism: 0.06, trunkRadius: 0.22, leafSize: 1.0, leafDensity: 3.33, leafCell: C.robinia, leafTilt: 0.7, clumps: 7, clumpSize: 0.36 },
  },
  {
    id: 9, name: 'elm', kind: 'tree', variants: 2, bark: 'oak', barkTint: T(0.72, 0.68, 0.62), leafTint: T(0.95, 1.0, 0.92), translucency: 0.5, roughness: 0.88,
    gen: { kind: 'broadleaf', seed: 110, height: 13, crown: 9.5, envelope: 'vase', crownBase: 0.3, points: 850, segment: 0.5, influence: 2.8, kill: 0.9, tropism: 0.1, trunkRadius: 0.3, leafSize: 0.95, leafDensity: 3.77, leafCell: C.elm, leafTilt: 0.6, clumps: 9, clumpSize: 0.3, lean: 0.12 },
  },
  {
    id: 10, name: 'walnut', kind: 'tree', variants: 2, bark: 'willow', barkTint: T(0.95, 0.93, 0.9), leafTint: T(0.98, 1.0, 0.92), translucency: 0.5, roughness: 0.80,
    gen: { kind: 'broadleaf', seed: 111, height: 15, crown: 14, envelope: 'dome', crownBase: 0.2, points: 900, segment: 0.65, influence: 3.8, kill: 1.2, tropism: 0.05, trunkRadius: 0.42, leafSize: 1.5, leafDensity: 3.33, leafCell: C.walnut, clumps: 9, clumpSize: 0.36 },
  },
  {
    id: 11, name: 'fruit', kind: 'tree', variants: 2, bark: 'oak', barkTint: T(0.72, 0.66, 0.6), leafTint: T(1.0, 1.0, 0.94), translucency: 0.5, roughness: 0.80,
    gen: { kind: 'broadleaf', seed: 112, height: 6, crown: 5.8, envelope: 'round', crownBase: 0.24, points: 650, segment: 0.26, influence: 1.4, kill: 0.45, tropism: 0.08, trunkRadius: 0.13, tipRadius: 0.008, leafSize: 0.72, leafDensity: 2.7, leafCell: C.fruit, clumps: 6, clumpSize: 0.45 },
  },
  {
    id: 12, name: 'cherry', kind: 'tree', bark: 'birch', barkTint: T(0.42, 0.34, 0.32), leafTint: T(0.95, 0.98, 0.9), translucency: 0.5, roughness: 0.80,
    gen: { kind: 'broadleaf', seed: 113, height: 5, crown: 4.4, envelope: 'irregular', crownBase: 0.2, stems: 2, lean: 0.2, points: 550, segment: 0.22, influence: 1.2, kill: 0.4, tropism: 0.18, trunkRadius: 0.1, tipRadius: 0.007, leafSize: 0.6, leafDensity: 2.7, leafCell: C.shrub, clumps: 6, clumpSize: 0.45 },
  },
  {
    id: 13, name: 'oak', kind: 'tree', bark: 'oak', barkTint: T(0.85, 0.8, 0.74), leafTint: T(0.95, 1.0, 0.9), translucency: 0.4, roughness: 0.86,
    gen: { kind: 'broadleaf', seed: 114, height: 19, crown: 15, envelope: 'dome', crownBase: 0.26, points: 1000, segment: 0.7, influence: 3.8, kill: 1.15, tropism: 0.02, trunkRadius: 0.55, leafSize: 1.4, leafDensity: 2.88, leafCell: C.oak, leafTilt: 0.6, clumps: 9, clumpSize: 0.35, lean: 0.1 },
  },
  {
    id: 14, name: 'ash', kind: 'tree', bark: 'willow', barkTint: T(0.85, 0.84, 0.8), leafTint: T(0.9, 0.98, 0.86), translucency: 0.6, roughness: 0.84,
    gen: { kind: 'broadleaf', seed: 115, height: 20, crown: 11.5, envelope: 'ellipsoid', crownBase: 0.35, points: 850, segment: 0.7, influence: 3.8, kill: 1.25, tropism: 0.15, trunkRadius: 0.4, leafSize: 1.3, leafDensity: 3.19, leafCell: C.robinia, leafTilt: 0.65, clumps: 8, clumpSize: 0.33 },
  },
  {
    id: 15, name: 'birch', kind: 'tree', bark: 'birch', barkTint: T(1.0, 1.0, 1.0), leafTint: T(1.0, 1.0, 0.92), translucency: 0.65, roughness: 0.80,
    gen: { kind: 'broadleaf', seed: 116, height: 17, crown: 7.5, envelope: 'ovate', crownBase: 0.28, points: 850, segment: 0.55, influence: 2.8, kill: 0.9, tropism: 0.1, trunkRadius: 0.26, leafSize: 0.95, leafDensity: 3.77, leafCell: C.birch, leafDroop: 0.35, clumps: 8, clumpSize: 0.38, lean: 0.08 },
  },
  {
    id: 16, name: 'pine', kind: 'tree', bark: 'pine', barkTint: T(0.95, 0.85, 0.78), leafTint: T(0.95, 1.0, 0.95), translucency: 0.3, roughness: 0.88,
    gen: { kind: 'conifer', style: 'pine', seed: 117, height: 16, crown: 7.5, crownBase: 0.45, trunkRadius: 0.3, tipRadius: 0.012, leafSize: 1.05, leafDensity: 1.7, leafCell: C.pine },
  },
  {
    id: 17, name: 'spruce', kind: 'tree', bark: 'pine', barkTint: T(0.7, 0.62, 0.58), leafTint: T(0.78, 0.9, 0.84), translucency: 0.25, roughness: 0.88,
    gen: { kind: 'conifer', style: 'spruce', seed: 118, height: 14, crown: 6.0, crownBase: 0.03, trunkRadius: 0.28, tipRadius: 0.01, leafSize: 0.95, leafDensity: 1.9, leafCell: C.spruce },
  },
  {
    id: 18, name: 'thuja', kind: 'tree', bark: 'pine', barkTint: T(0.7, 0.55, 0.45), leafTint: T(1.0, 1.0, 0.95), translucency: 0.3, roughness: 0.88,
    gen: { kind: 'conifer', style: 'thuja', seed: 119, height: 5.5, crown: 2.0, crownBase: 0.03, trunkRadius: 0.1, tipRadius: 0.008, leafSize: 0.65, leafDensity: 2.4, leafCell: C.thuja },
  },
  {
    id: 19, name: 'alder', kind: 'tree', bark: 'willow', barkTint: T(0.6, 0.58, 0.55), leafTint: T(0.85, 0.95, 0.85), translucency: 0.45, roughness: 0.80,
    gen: { kind: 'broadleaf', seed: 120, height: 15, crown: 8, envelope: 'ovate', crownBase: 0.25, points: 800, segment: 0.55, influence: 2.9, kill: 0.95, tropism: 0.16, trunkRadius: 0.3, leafSize: 1.05, leafDensity: 3.77, leafCell: C.shrub, clumps: 9, clumpSize: 0.4 },
  },
  // ------------------------------------------------ shrubs
  {
    id: 32, name: 'lilac', kind: 'shrub', bark: 'willow', barkTint: T(0.6, 0.58, 0.55), leafTint: T(1.0, 1.0, 0.95), translucency: 0.5, roughness: 0.80,
    gen: { kind: 'broadleaf', seed: 201, height: 3.0, crown: 3.0, envelope: 'bush', crownBase: 0.05, stems: 6, points: 500, segment: 0.16, influence: 0.9, kill: 0.28, tropism: 0.2, trunkRadius: 0.05, tipRadius: 0.006, leafSize: 0.55, leafDensity: 3.04, leafCell: C.shrub, clumps: 5, clumpSize: 0.45 },
  },
  {
    id: 33, name: 'shrub', kind: 'shrub', bark: 'oak', barkTint: T(0.6, 0.55, 0.5), leafTint: T(0.95, 1.0, 0.9), translucency: 0.5, roughness: 0.83,
    gen: { kind: 'broadleaf', seed: 202, height: 2.3, crown: 2.6, envelope: 'bush', crownBase: 0.05, stems: 5, points: 450, segment: 0.14, influence: 0.8, kill: 0.25, tropism: 0.12, trunkRadius: 0.04, tipRadius: 0.005, leafSize: 0.5, leafDensity: 3.04, leafCell: C.elm, clumps: 5, clumpSize: 0.45 },
  },
  {
    id: 34, name: 'rose', kind: 'shrub', bark: 'oak', barkTint: T(0.55, 0.45, 0.4), leafTint: T(0.9, 0.95, 0.85), translucency: 0.45, roughness: 0.83,
    gen: { kind: 'broadleaf', seed: 203, height: 1.4, crown: 1.9, envelope: 'bush', crownBase: 0.03, stems: 6, points: 380, segment: 0.1, influence: 0.55, kill: 0.18, tropism: 0.05, trunkRadius: 0.025, tipRadius: 0.004, leafSize: 0.4, leafDensity: 3.23, leafCell: C.elm, clumps: 5, clumpSize: 0.45 },
  },
  {
    id: 35, name: 'willow_shrub', kind: 'shrub', bark: 'willow', barkTint: T(0.65, 0.55, 0.45), leafTint: T(1.0, 1.0, 0.95), translucency: 0.6, roughness: 0.93,
    gen: { kind: 'broadleaf', seed: 204, height: 4.0, crown: 4.4, envelope: 'bush', crownBase: 0.04, stems: 7, points: 520, segment: 0.22, influence: 1.2, kill: 0.36, tropism: 0.25, trunkRadius: 0.06, tipRadius: 0.006, leafSize: 0.75, leafDensity: 2.85, leafCell: C.willow, clumps: 5, clumpSize: 0.45 },
  },
  {
    id: 36, name: 'hedge', kind: 'hedge', bark: 'oak', barkTint: T(0.6, 0.55, 0.5), leafTint: T(0.9, 0.97, 0.85), translucency: 0.35, roughness: 0.88,
    gen: { kind: 'hedge', seed: 205, height: 1.1, crown: 0.9, trunkRadius: 0, leafSize: 0.42, leafDensity: 1, leafCell: C.elm },
  },
  {
    id: 37, name: 'juniper', kind: 'shrub', bark: 'pine', barkTint: T(0.6, 0.5, 0.42), leafTint: T(0.85, 0.95, 0.9), translucency: 0.25, roughness: 0.93,
    gen: { kind: 'conifer', style: 'juniper', seed: 206, height: 1.0, crown: 2.2, crownBase: 0.02, trunkRadius: 0.05, tipRadius: 0.006, leafSize: 0.42, leafDensity: 2.2, leafCell: C.thuja },
  },
];

export const SPECIES_BY_ID = new Map(SPECIES.map((s) => [s.id, s]));
export const HEDGE_ID = 36;
