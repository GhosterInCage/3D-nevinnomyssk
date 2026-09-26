// Small, guarded patches of three-gpu-pathtracer 0.0.24's path tracing kernel.
//
// Light selection: next-event estimation picks "one of the lights" or "the
// environment" uniformly (1/(N+1) each). In a sunny city the sun delivers
// most of the direct light, so a sun-vs-sky split of ~70/30 cuts the noise of
// sunlit surfaces substantially. The patch replaces the uniform choice by a
// uniform `ptLightProb` (probability of sampling the light set) and fixes all
// pdfs/MIS weights that used `lightsDenom` accordingly. Every replacement is
// verified; if the kernel source differs (other library version) nothing is
// changed and the stock behaviour stays.
import type * as THREE from 'three';

interface Rep { from: RegExp; to: string; min: number }

const REPS: Rep[] = [
  // globals
  { from: /float lightsDenom;/, to: 'float lightsDenom;\n\t\t\t\tuniform float ptLightProb;\n\t\t\t\tfloat ptLightSel;', min: 1 },
  // compute the selection probability right after lightsDenom
  {
    from: /(lightsDenom =[\s\S]*?float\( lights\.count \+ 1u \);)/,
    to: '$1\n\t\t\t\t\tptLightSel = lights.count == 0u ? 0.0 : ( ( environmentIntensity == 0.0 || envMapInfo.totalSum == 0.0 ) ? 1.0 : ptLightProb );',
    min: 1,
  },
  // choice of light vs environment in NEE
  { from: /rand\( 5 \) < float\( lights\.count \) \/ lightsDenom/, to: 'rand( 5 ) < ptLightSel', min: 1 },
  // light pdf in NEE
  { from: /float lightPdf = lightRec\.pdf \/ lightsDenom;/, to: 'float lightPdf = lightRec.pdf * ptLightSel / float( lights.count );', min: 1 },
  // env pdf (NEE and MIS on environment hits)
  { from: /envPdf \/= lightsDenom;/g, to: 'envPdf *= ( 1.0 - ptLightSel );', min: 2 },
  // MIS on area-light hits
  { from: /lightRec\.pdf \/ lightsDenom/g, to: '( lightRec.pdf * ptLightSel / float( lights.count ) )', min: 1 },
];

/** Patch the material in place (before its first compile). Returns true on success. */
export function patchLightSelection(material: THREE.ShaderMaterial, prob = 0.7): boolean {
  let src = material.fragmentShader;
  if (src.includes('ptLightProb')) return true;
  for (const r of REPS) {
    const n = (src.match(new RegExp(r.from.source, 'g')) || []).length;
    if (n < r.min) {
      console.warn('[pathtracer] kernel patch skipped (unexpected source):', r.from.source.slice(0, 40));
      return false;
    }
    src = src.replace(r.from, r.to);
  }
  material.fragmentShader = src;
  material.uniforms.ptLightProb = { value: prob };
  // MaterialBase exposes uniforms as properties; keep the pattern for this one too
  Object.defineProperty(material, 'ptLightProb', {
    get() { return this.uniforms.ptLightProb.value; },
    set(v: number) { this.uniforms.ptLightProb.value = v; },
    configurable: true,
  });
  material.needsUpdate = true;
  return true;
}
