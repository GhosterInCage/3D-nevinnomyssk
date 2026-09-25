// Overhead wires (power lines, catenary, SIP cables) as camera-facing ribbons.
// Each wire vertex stores its centre point, tangent, side (-1/+1) and physical radius; the vertex
// shader widens the ribbon to at least ~0.7 px and fades alpha by radius / width so sub-pixel
// wires stay stable (no shimmering) and far wires fade out naturally.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';

export class WireBuilder {
  pos: number[] = [];
  tan: number[] = [];
  side: number[] = [];
  rad: number[] = [];
  idx: number[] = [];

  get count(): number { return this.pos.length / 3; }

  /** Parabolic catenary between a and b with mid-span sag (m). */
  span(ax: number, ay: number, az: number, bx: number, by: number, bz: number, sag: number, radius: number, segLen = 6): void {
    const L = Math.hypot(bx - ax, by - ay, bz - az);
    const n = Math.max(2, Math.min(40, Math.ceil(L / segLen)));
    let prev = -1;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const y = ay + (by - ay) * t - 4 * sag * t * (1 - t);
      // derivative
      const tx = bx - ax, tz = bz - az, ty = by - ay - 4 * sag * (1 - 2 * t);
      const tl = Math.hypot(tx, ty, tz) || 1;
      const base = this.count;
      for (const s of [-1, 1]) {
        this.pos.push(x, y, z);
        this.tan.push(tx / tl, ty / tl, tz / tl);
        this.side.push(s);
        this.rad.push(radius);
      }
      if (prev >= 0) this.idx.push(prev, prev + 1, base + 1, prev, base + 1, base);
      prev = base;
    }
  }

  /** Straight wire (dropper, stay). */
  line(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number): void {
    this.span(ax, ay, az, bx, by, bz, 0, radius, 1e9);
  }

  build(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aTan', new THREE.Float32BufferAttribute(this.tan, 3));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(this.side, 1));
    g.setAttribute('aRad', new THREE.Float32BufferAttribute(this.rad, 1));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const wirePix = { value: 0.0015 };

/** Update the pixel-size uniform (call once per frame). */
export function updateWireUniforms(ctx: AppContext): void {
  const cam = ctx.camera;
  const h = Math.max(1, ctx.height * ctx.pixelRatio);
  wirePix.value = (2 * Math.tan((cam.fov * Math.PI) / 360)) / h;
}

export function createWireMaterial(ctx: AppContext, color: number, metal = 0.6, rough = 0.5, minPx = 0.75): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.wPix = wirePix;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aTan;
attribute float aSide;
attribute float aRad;
uniform float wPix;
varying float wAlpha;`)
      .replace('#include <beginnormal_vertex>', `
vec3 wW = (modelMatrix * vec4(position, 1.0)).xyz;
vec3 wT = normalize(mat3(modelMatrix) * aTan);
vec3 wC = cameraPosition - wW;
float wD = length(wC);
vec3 wS = normalize(cross(wT, wC / max(wD, 1e-3)));
float wPx = wD * wPix * ${minPx.toFixed(2)};
float wWd = max(aRad, wPx);
wAlpha = clamp(aRad / wWd, 0.0, 1.0);
wAlpha = sqrt(wAlpha) * (1.0 - smoothstep(4000.0, 9000.0, wD));
vec3 objectNormal = normalize(cross(wS, wT) + vec3(0.0, 0.3, 0.0));
#ifdef USE_TANGENT
vec3 objectTangent = vec3(1.0, 0.0, 0.0);
#endif`)
      .replace('#include <begin_vertex>', `vec3 transformed = position + (inverse(mat3(modelMatrix)) * wS) * aSide * wWd;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying float wAlpha;`)
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
diffuseColor.a *= wAlpha;`);
  };
  m.customProgramCacheKey = () => `roads-wire-${minPx}`;
  m.name = 'roads-wire';
  return ctx.registerMaterial(m);
}
