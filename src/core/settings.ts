// Global settings: quality tier + URL parameters used for testing/deep links.
//
// URL parameters (all optional):
//   cam=x,y,z,heading,pitch   world position (m) + heading (deg cw from north) + pitch (deg, negative = down)
//   ll=lon,lat,alt,heading,pitch  same but geographic; alt = metres above ground
//   time=HH.hh                local time of day (MSK), e.g. time=18.5
//   date=YYYY-MM-DD           date (default 2026-07-15)
//   quality=low|medium|high|ultra
//   only=terrain,sky          load only these modules (comma list)
//   skip=vegetation           do not load these modules
//   mode=fly|walk|drive       initial control mode
//   shot=1                    screenshot/test mode: no UI chrome, deterministic time, no intro animation
//   debug=1                   show stats + lil-gui debug panel

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export const QUALITY_ORDER: Quality[] = ['low', 'medium', 'high', 'ultra'];

export interface QualityProfile {
  pixelRatio: number;      // max device pixel ratio
  shadowMapSize: number;
  shadowCascades: number;
  shadowFar: number;       // metres
  ao: boolean;
  bloom: boolean;
  vegetationDensity: number; // 0..1 multiplier of instances
  drawDistance: number;      // metres for detailed city layers
  grass: boolean;
  waterReflections: boolean;
  clouds: 'none' | 'simple' | 'volumetric';
}

export const QUALITY: Record<Quality, QualityProfile> = {
  low:    { pixelRatio: 1,   shadowMapSize: 1024, shadowCascades: 2, shadowFar: 800,  ao: false, bloom: false, vegetationDensity: 0.3, drawDistance: 4000,  grass: false, waterReflections: false, clouds: 'simple' },
  medium: { pixelRatio: 1,   shadowMapSize: 2048, shadowCascades: 3, shadowFar: 1500, ao: true,  bloom: true,  vegetationDensity: 0.6, drawDistance: 8000,  grass: true,  waterReflections: true,  clouds: 'simple' },
  high:   { pixelRatio: 1.5, shadowMapSize: 2048, shadowCascades: 4, shadowFar: 2500, ao: true,  bloom: true,  vegetationDensity: 1.0, drawDistance: 14000, grass: true,  waterReflections: true,  clouds: 'volumetric' },
  ultra:  { pixelRatio: 2,   shadowMapSize: 4096, shadowCascades: 4, shadowFar: 4000, ao: true,  bloom: true,  vegetationDensity: 1.0, drawDistance: 22000, grass: true,  waterReflections: true,  clouds: 'volumetric' },
};

export class Settings {
  readonly params: URLSearchParams;
  quality: Quality;
  readonly shot: boolean;
  readonly debug: boolean;
  readonly only: Set<string> | null;
  readonly skip: Set<string>;

  constructor(search = location.search) {
    this.params = new URLSearchParams(search);
    const q = this.params.get('quality') as Quality | null;
    let stored: Quality | null = null;
    try { stored = localStorage.getItem('nev3d.quality') as Quality | null; } catch { /* ignore */ }
    this.quality = q && QUALITY[q] ? q : stored && QUALITY[stored] ? stored : Settings.guessQuality();
    this.shot = this.params.get('shot') === '1';
    this.debug = this.params.get('debug') === '1';
    const only = this.params.get('only');
    this.only = only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
    this.skip = new Set((this.params.get('skip') || '').split(',').map((s) => s.trim()).filter(Boolean));
  }

  get profile(): QualityProfile {
    return QUALITY[this.quality];
  }

  setQuality(q: Quality): void {
    this.quality = q;
    try { localStorage.setItem('nev3d.quality', q); } catch { /* ignore */ }
  }

  wants(moduleId: string): boolean {
    if (this.skip.has(moduleId)) return false;
    return !this.only || this.only.has(moduleId);
  }

  numbers(name: string): number[] | null {
    const v = this.params.get(name);
    if (!v) return null;
    const a = v.split(',').map(Number);
    return a.every((x) => Number.isFinite(x)) ? a : null;
  }

  static guessQuality(): Quality {
    const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    if (mobile) return 'low';
    const mem = (navigator as any).deviceMemory ?? 8;
    return mem >= 8 ? 'high' : 'medium';
  }
}
