// Materials of the traffic module.
//  * vehicle uber-material: one MeshPhysicalMaterial for every part of a vehicle (paint with
//    clearcoat + per-instance colour/metallic/dirt, glass, trim, chrome, rubber, lamps), driven by the
//    per-vertex aMat = (roughness, metalness, flags, emissive code) and per-instance iColor / iData
//    (wheel angle, brake level or -1 = parked/lights off, metallic, dirt). Wheels spin in the vertex
//    shader (aWheel = axle centre y/z). One draw call per vehicle type and LOD.
//  * pedestrian material: walk cycle in the vertex shader (aBone), clothing colours per instance.
//  * bird material: wing flapping.
//  * headlight beam material: additive light pools projected in front of cars at night.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';

export interface TrafficUniforms {
  tNight: THREE.IUniform<number>;
  tTime: THREE.IUniform<number>;
  tHead: THREE.IUniform<THREE.Vector2>; // headlight intensity day / night
}

export function makeUniforms(): TrafficUniforms {
  return { tNight: { value: 0 }, tTime: { value: 0 }, tHead: { value: new THREE.Vector2(1.2, 26) } };
}

export function createVehicleMaterial(ctx: AppContext, u: TrafficUniforms, key: string): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 1, metalness: 1, clearcoat: 1, clearcoatRoughness: 0.07, envMapIntensity: 1.0,
  });
  m.name = `traffic-vehicle-${key}`;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tNight = u.tNight;
    sh.uniforms.tHead = u.tHead;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aMat;
attribute vec3 aWheel;
attribute vec3 iColor;
attribute vec4 iData;
varying vec4 vMat;
varying vec2 vState;
varying float vLocalY;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
if (aWheel.z > 0.5) {
  float wc = cos(iData.x), ws = sin(iData.x);
  objectNormal.yz = vec2(wc * objectNormal.y - ws * objectNormal.z, ws * objectNormal.y + wc * objectNormal.z);
}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
if (aWheel.z > 0.5) {
  float wc = cos(iData.x), ws = sin(iData.x);
  vec2 wq = transformed.yz - aWheel.xy;
  transformed.yz = aWheel.xy + vec2(wc * wq.x - ws * wq.y, ws * wq.x + wc * wq.y);
}
float paintF = mod(aMat.z, 2.0);
vMat = vec4(mix(aMat.x, 0.26, paintF), mix(aMat.y, iData.z * 0.72, paintF), aMat.z, aMat.w);
vState = vec2(iData.y, iData.w * paintF);
vLocalY = position.y;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
vColor.rgb *= mix(vec3(1.0), iColor, mod(aMat.z, 2.0));`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float tNight;
uniform vec2 tHead;
varying vec4 vMat;
varying vec2 vState;
varying float vLocalY;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float dirtK = vState.y * (1.0 - smoothstep(0.2, 0.95, vLocalY));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.18, 0.155), dirtK * 0.55);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = min(1.0, vMat.x + dirtK * 0.35);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = vMat.y * (1.0 - dirtK * 0.5);`)
      .replace('material.clearcoat = clearcoat;', 'material.clearcoat = clearcoat * step(1.5, vMat.z) * (1.0 - dirtK);')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  int code = int(vMat.w + 0.5);
  if (code > 0) {
    float on = step(-0.5, vState.x);
    float rear = step(1.5, vState.x);
    float brake = rear > 0.5 ? 0.5 : max(vState.x, 0.0);
    vec3 e = vec3(0.0);
    if (code == 1) e = vec3(1.0, 0.93, 0.8) * mix(tHead.x, tHead.y, tNight) * on * (1.0 - rear);
    else if (code == 2) e = vec3(1.0, 0.03, 0.01) * (tNight * 3.0 + brake * (1.6 + tNight * 5.0)) * on;
    else if (code == 3) e = vec3(1.0, 0.45, 0.03) * tNight * 0.6 * on;
    else if (code == 4) e = vec3(1.0, 0.42, 0.04) * mix(1.4, 4.5, tNight) * on;
    else if (code == 5) e = vec3(1.0, 0.85, 0.62) * tNight * 0.9 * on;
    else if (code == 6) e = vec3(1.0, 0.95, 0.85) * mix(0.0, 1.2, tNight);
    totalEmissiveRadiance += e;
  }
}`);
  };
  m.customProgramCacheKey = () => 'traffic-vehicle-v1';
  return ctx.registerMaterial(m);
}

/** Pedestrians: bones 0 body, 1 left leg, 2 right leg, 3 left arm, 4 right arm, 5 head.
 *  Per instance iColor = top (jacket), iData = (phase, stride 0..1, pants colour index, skin/hair seed). */
export function createPedMaterial(ctx: AppContext, u: TrafficUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  m.name = 'traffic-ped';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tTime = u.tTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aBone;
attribute vec4 aMat;
attribute vec3 iColor;
attribute vec4 iData;
attribute vec3 iColor2;
uniform float tTime;
varying float vRough;
vec2 pedRot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
float pPh = iData.x;
float pAmp = iData.y;
float pSw = sin(pPh);
float pAng = 0.0;
vec2 pPivot = vec2(0.0);
int pB = int(aBone + 0.5);
if (pB == 1) { pAng = pSw * 0.45 * pAmp; pPivot = vec2(0.92, 0.0); }
else if (pB == 2) { pAng = -pSw * 0.45 * pAmp; pPivot = vec2(0.92, 0.0); }
else if (pB == 3) { pAng = -pSw * 0.38 * pAmp; pPivot = vec2(1.38, 0.0); }
else if (pB == 4) { pAng = pSw * 0.38 * pAmp; pPivot = vec2(1.38, 0.0); }
objectNormal.yz = pedRot(objectNormal.yz, -pAng);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
if (pB >= 1 && pB <= 4) {
  vec2 q = transformed.yz - pPivot;
  transformed.yz = pPivot + pedRot(q, -pAng);
}
transformed.y += abs(cos(pPh)) * 0.035 * pAmp;
vRough = aMat.x;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
{
  // aMat.w: 1 top (jacket), 2 bottom (trousers/skirt), 3 skin, 4 hair, 5 shoes, 0 fixed colour
  int part = int(aMat.w + 0.5);
  float seed = iData.w;
  vec3 skin = mix(vec3(0.62, 0.42, 0.32), vec3(0.42, 0.26, 0.18), fract(seed * 7.13));
  vec3 hair = mix(vec3(0.05, 0.035, 0.025), vec3(0.32, 0.22, 0.12), fract(seed * 3.7));
  if (fract(seed * 11.3) > 0.85) hair = vec3(0.55, 0.53, 0.5);
  if (part == 1) vColor.rgb = iColor;
  else if (part == 2) vColor.rgb = iColor2;
  else if (part == 3) vColor.rgb = skin;
  else if (part == 4) vColor.rgb = hair;
  else if (part == 5) vColor.rgb = vec3(0.03);
}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vRough;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = vRough;`);
  };
  m.customProgramCacheKey = () => 'traffic-ped-v1';
  return ctx.registerMaterial(m);
}

/** Birds: bone 1/2 = left/right wing, flapping by iData.x phase, iData.y flap amplitude. */
export function createBirdMaterial(ctx: AppContext): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
  m.name = 'traffic-bird';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aBone;
attribute vec4 iData;
attribute vec3 iColor;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  int b = int(aBone + 0.5);
  if (b == 1 || b == 2) {
    float s = b == 1 ? 1.0 : -1.0;
    float a = sin(iData.x) * 0.9 * iData.y + 0.15;
    float c = cos(a), sn = sin(a);
    vec2 q = vec2(transformed.x * s, transformed.y);
    q = vec2(c * q.x - sn * q.y, sn * q.x + c * q.y);
    transformed.x = q.x * s; transformed.y = q.y;
  }
}`)
      .replace('#include <color_vertex>', `#include <color_vertex>
vColor.rgb *= iColor;`);
  };
  m.customProgramCacheKey = () => 'traffic-bird-v1';
  return ctx.registerMaterial(m);
}

/** Additive headlight pools on the road (quad per car, fades with distance, only at night). */
export function createBeamMaterial(u: TrafficUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { tNight: u.tNight },
    vertexShader: /* glsl */`
      attribute vec4 iBeam; // intensity, unused
      varying vec2 vUv;
      varying float vI;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vI = iBeam.x;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform float tNight;
      varying vec2 vUv;
      varying float vI;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        // uv.x across (0..1), uv.y along the beam (0 at the car, 1 far)
        float x = (vUv.x - 0.5) * 2.0;
        float y = vUv.y;
        float spread = mix(0.45, 1.0, y);
        float q = abs(x) / spread;
        float lat = exp(-q * q * 3.5);
        float lon = smoothstep(0.0, 0.2, y) * (1.0 - smoothstep(0.25, 1.0, y));
        float a = lat * lon * vI * tNight;
        gl_FragColor = vec4(vec3(1.0, 0.92, 0.78) * a * 0.07, 1.0);
        #include <fog_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}

/** Night glow sprites for head / tail lights of distant vehicles (additive points). */
export function createLightGlow(u: TrafficUniforms, cap: number): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setDrawRange(0, 0);
  const m = new THREE.ShaderMaterial({
    uniforms: { tNight: u.tNight },
    vertexShader: /* glsl */ `
      uniform float tNight;
      attribute vec3 color;
      varying vec3 vCol;
      varying float vA;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = -mv.z;
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(260.0 / max(d, 1.0), 1.6, 9.0);
        vCol = color;
        vA = tNight * (1.0 - smoothstep(2500.0, 5000.0, d)) * smoothstep(25.0, 90.0, d);
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
        if (r > 1.0 || vA <= 0.0) discard;
        float core = exp(-r * 10.0);
        float halo = exp(-r * 3.0) * 0.25;
        gl_FragColor = vec4(vCol * (core * 4.0 + halo) * vA, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = 3;
  pts.userData.noPathTrace = true;
  pts.name = 'traffic-light-glow';
  return pts;
}
