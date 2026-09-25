// Materials for props: vertex-coloured PBR with an emissive channel (aEmit) for lamp lenses and
// traffic-signal lenses (per-instance signal state), plus the night glow sprites of street lamps.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';

export interface PropUniforms {
  pNight: THREE.IUniform<number>;
}

export function createPropMaterial(ctx: AppContext, u: PropUniforms, opts: {
  key: string; metal?: number; rough?: number; emitColor?: THREE.Color; emitNight?: number; emitDay?: number; signal?: boolean; side?: THREE.Side;
}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: opts.metal ?? 0.1, roughness: opts.rough ?? 0.7, side: opts.side ?? THREE.DoubleSide });
  const col = { value: opts.emitColor ?? new THREE.Color(1, 0.9, 0.75) };
  const iN = { value: opts.emitNight ?? 25 };
  const iD = { value: opts.emitDay ?? 0.0 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.pNight = u.pNight;
    sh.uniforms.pEmitCol = col;
    sh.uniforms.pEmitN = iN;
    sh.uniforms.pEmitD = iD;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aEmit;
varying float vEmit;
${opts.signal ? 'attribute float aState;\nvarying float vState;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vEmit = aEmit;
${opts.signal ? 'vState = aState;' : ''}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float pNight;
uniform vec3 pEmitCol;
uniform float pEmitN;
uniform float pEmitD;
varying float vEmit;
${opts.signal ? 'varying float vState;' : ''}`)
      .replace('#include <emissivemap_fragment>', opts.signal ? `#include <emissivemap_fragment>
{
  int id = int(vEmit + 0.5);
  if (id > 0) {
    vec3 c = id == 1 ? vec3(1.0, 0.04, 0.02) : id == 2 ? vec3(1.0, 0.45, 0.0) : vec3(0.05, 1.0, 0.45);
    float on = abs(float(id) - (vState + 1.0)) < 0.5 ? 1.0 : 0.0;
    diffuseColor.rgb = mix(diffuseColor.rgb, c * 0.08, 0.7);
    totalEmissiveRadiance += c * on * mix(pEmitD, pEmitN, pNight);
  }
}` : `#include <emissivemap_fragment>
if (vEmit > 0.5) totalEmissiveRadiance += pEmitCol * mix(pEmitD, pEmitN, pNight);`);
  };
  m.customProgramCacheKey = () => `roads-prop-${opts.signal ? 's' : 'l'}`;
  m.name = `roads-prop-${opts.key}`;
  return ctx.registerMaterial(m);
}

/** Additive glow sprites for lamp heads (visible at night from far away). */
export function createGlowPoints(positions: Float32Array, colors: Float32Array, u: PropUniforms): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeBoundingSphere();
  const m = new THREE.ShaderMaterial({
    uniforms: { pNight: u.pNight, pScale: { value: 160 } },
    vertexShader: /* glsl */ `
      uniform float pNight;
      uniform float pScale;
      attribute vec3 color;
      varying vec3 vCol;
      varying float vA;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = -mv.z;
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(pScale * 1.6 / max(d, 1.0), 2.0, 14.0);
        vCol = color;
        vA = pNight * (1.0 - smoothstep(6000.0, 12000.0, d)) * smoothstep(40.0, 150.0, d);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      varying float vA;
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r = dot(p, p);
        if (r > 1.0) discard;
        float core = exp(-r * 9.0);
        float halo = exp(-r * 2.5) * 0.35;
        gl_FragColor = vec4(vCol * (core * 6.0 + halo) * vA, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = 5;
  pts.userData.noPathTrace = true;
  pts.name = 'roads-lamp-glow';
  return pts;
}
