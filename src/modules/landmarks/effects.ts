// Light-emitting effects: obstruction-light glows (screen-space sized sprites), the Eternal
// Flame (animated noise flame on crossed planes) and chimney plumes.
import * as THREE from 'three';

// ------------------------------------------------------------------------------------ glows
export interface GlowSpec { x: number; y: number; z: number; color: THREE.Color; size: number; blink?: boolean; day?: number; phase?: number }

const GLOW_VS = /* glsl */ `
attribute vec3 gColor;
attribute vec4 gParam;     // size (m), blink, day visibility, phase
uniform float uNight;
uniform float uTime;
uniform float uScale;      // pixels per metre at 1 m distance
uniform float uGain;       // compensates the sky module's night exposure
varying vec3 vCol;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(-mv.z, 0.1);
  float on = gParam.y > 0.5 ? step(fract(uTime * 0.75 + gParam.w), 0.4) : 1.0;
  float vis = mix(gParam.z, 1.0, uNight) * on;
  float px = gParam.x * uScale / d;
  // keep a minimum apparent size for beacons far away, fade them with distance instead
  float minPx = mix(1.5, 4.5, uNight);
  // beacons (>= 2 m) stay visible far away, small work lights fade with their apparent size
  float floorA = gParam.x >= 2.0 ? 0.5 : 0.0;
  vA = vis * uGain * clamp(px / minPx, floorA, 1.0) * clamp(1.0 - d / 30000.0, 0.0, 1.0);
  gl_PointSize = clamp(max(px, minPx), 0.0, 96.0);
  vCol = gColor;
  gl_Position = projectionMatrix * mv;
}`;

const GLOW_FS = /* glsl */ `
varying vec3 vCol;
varying float vA;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 18.0);
  float halo = exp(-r2 * 4.0) * 0.35;
  float a = (core + halo) * vA;
  gl_FragColor = vec4(vCol * a, a);
}`;

export class Glows {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  constructor(specs: GlowSpec[]) {
    const n = specs.length;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), par = new Float32Array(n * 4);
    specs.forEach((s, i) => {
      pos.set([s.x, s.y, s.z], i * 3);
      col.set([s.color.r, s.color.g, s.color.b], i * 3);
      par.set([s.size, s.blink ? 1 : 0, s.day ?? 0.05, s.phase ?? 0], i * 4);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('gColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('gParam', new THREE.BufferAttribute(par, 4));
    g.computeBoundingSphere();
    this.material = new THREE.ShaderMaterial({
      vertexShader: GLOW_VS,
      fragmentShader: GLOW_FS,
      uniforms: { uNight: { value: 0 }, uTime: { value: 0 }, uScale: { value: 600 }, uGain: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      toneMapped: false,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.points.userData.noPathTrace = true;
    this.points.name = 'landmark-glows';
  }
  update(night: number, time: number, cam: THREE.PerspectiveCamera, heightPx: number, exposure = 1): void {
    const u = this.material.uniforms;
    u.uGain.value = THREE.MathUtils.clamp(4.0 / Math.max(exposure, 1e-3), 0.25, 1.0);
    u.uNight.value = night;
    u.uTime.value = time;
    u.uScale.value = heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
  }
}

// ------------------------------------------------------------------------------------ flame
const FLAME_VS = /* glsl */ `
varying vec2 vUv;
varying vec3 vW;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FLAME_FS = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform float uGain;
varying vec2 vUv;
float h21(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
void main() {
  vec2 uv = vUv;                 // x: -..+ across (0..1), y: 0 bottom .. 1 top
  float t = uTime;
  float x = uv.x * 2.0 - 1.0;
  float y = uv.y;
  float n = fbm(vec2(x * 2.2 + uSeed, y * 3.2 - t * 2.6));
  float n2 = fbm(vec2(x * 4.5 - uSeed, y * 6.0 - t * 4.1));
  float w = (1.0 - y) * 0.9 + 0.08;                 // flame narrows upwards
  float xd = abs(x + (n - 0.5) * 0.7 * y) / w;
  float body = 1.0 - smoothstep(0.35, 1.0, xd + (n2 - 0.5) * 0.35);
  float top = 1.0 - smoothstep(0.35, 1.0, y + (n - 0.5) * 0.45);
  float a = body * top * smoothstep(0.0, 0.06, y);
  float heat = a * (1.0 - y * 0.7);
  vec3 c = mix(vec3(0.9, 0.18, 0.02), vec3(1.0, 0.62, 0.15), smoothstep(0.1, 0.6, heat));
  c = mix(c, vec3(1.0, 0.95, 0.75), smoothstep(0.55, 0.95, heat));
  c += vec3(0.1, 0.25, 0.9) * (1.0 - smoothstep(0.0, 0.12, y)) * body * 0.6;   // blue base
  if (a < 0.01) discard;
  gl_FragColor = vec4(c * a * 2.5 * uGain, a);
}`;

export function makeFlame(height = 1.1, width = 0.7, planes = 3): THREE.Group {
  const grp = new THREE.Group();
  grp.name = 'eternal-flame';
  for (let i = 0; i < planes; i++) {
    const g = new THREE.PlaneGeometry(width, height, 1, 1);
    g.translate(0, height / 2, 0);
    const m = new THREE.ShaderMaterial({
      vertexShader: FLAME_VS,
      fragmentShader: FLAME_FS,
      uniforms: { uTime: { value: 0 }, uSeed: { value: i * 3.17 }, uGain: { value: 1 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.rotation.y = (i / planes) * Math.PI;
    mesh.userData.noPathTrace = true;
    mesh.renderOrder = 11;
    grp.add(mesh);
  }
  return grp;
}

export function updateFlame(grp: THREE.Group, t: number, exposure = 1): void {
  for (const c of grp.children) {
    const m = (c as THREE.Mesh).material as THREE.ShaderMaterial;
    m.uniforms.uTime.value = t;
    m.uniforms.uGain.value = THREE.MathUtils.clamp(1.6 / Math.max(exposure, 1e-3), 0.12, 1.2);
  }
}

// ------------------------------------------------------------------------------------ plumes
// Soft rising steam / flue-gas plume from a stack: a chain of camera-facing puffs with
// lit/shadowed shading from the sun, drifting downwind. Cheap (one draw call per plume set).
const PLUME_VS = /* glsl */ `
attribute vec4 pData;        // t (0..1 along plume), puff size (m), seed, stack index
attribute vec4 pStack;       // stack top x, y, z, strength
uniform float uTime;
uniform vec2 uWind;          // m/s world xz (10 m wind; x2 at stack height)
uniform float uRise;
varying float vA;
varying vec2 vC;
varying vec2 vN;
varying float vAge;
void main() {
  float t = fract(pData.x + uTime * 0.006);
  float age = t * t * 240.0;                              // seconds since emission (dense near the source)
  vec3 top = pStack.xyz;
  float rise = uRise * (1.0 - exp(-age / 30.0)) * (0.75 + 0.5 * pData.z);
  vec2 w = uWind * 1.8 + vec2(0.4, -0.2);
  vec2 drift = w * age;
  vec3 c = top + vec3(drift.x, rise, drift.y);
  // turbulent meander grows with age
  float m = age * 0.12;
  c.x += sin(pData.z * 40.0 + age * 0.05) * m;
  c.z += cos(pData.z * 23.0 + age * 0.04) * m;
  c.y += sin(pData.z * 17.0 + age * 0.03) * m * 0.5;
  float size = pData.y * (1.0 + age * 0.11) * (0.8 + 0.4 * pData.z);
  vec2 corner = vec2(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0);
  vC = corner;
  vN = corner * 0.35 + vec2(pData.z * 7.3, pData.z * 3.1);
  vAge = t;
  vec4 mv = viewMatrix * vec4(c, 1.0);
  mv.xy += corner * size;
  vA = pStack.w * smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.3, 0.95, t)) / (1.0 + age * 0.02);
  gl_Position = projectionMatrix * mv;
}`;

const PLUME_FS = /* glsl */ `
uniform vec3 uLight;
uniform vec3 uAmb;
uniform sampler2D uNoise;
varying float vA;
varying vec2 vC;
varying vec2 vN;
varying float vAge;
void main() {
  float r2 = dot(vC, vC);
  if (r2 > 1.0) discard;
  vec4 n = texture2D(uNoise, vN);
  float body = (1.0 - r2) * (1.0 - r2) * clamp(0.45 + 1.1 * (n.g - 0.35) + 0.5 * (n.r - 0.5), 0.0, 1.5);
  float a = clamp(vA * body, 0.0, 1.0) * 0.6;
  if (a < 0.003) discard;
  float shade = 0.72 + 0.28 * vC.y;
  vec3 col = uAmb * (1.0 - vAge * 0.2) + uLight * shade;
  gl_FragColor = vec4(col * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Plumes {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  constructor(stacks: Array<{ x: number; y: number; z: number; strength: number; size: number }>, noise: THREE.Texture | null, puffs = 64) {
    const n = stacks.length * puffs;
    const base = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('uv', base.getAttribute('uv'));
    const pd = new Float32Array(n * 4), ps = new Float32Array(n * 4);
    let k = 0;
    stacks.forEach((s, si) => {
      for (let i = 0; i < puffs; i++, k++) {
        const seed = ((i * 7919 + si * 104729) % 1000) / 1000;
        // phases jittered so puffs do not march in lock-step
        pd.set([(i + seed * 0.8) / puffs, s.size * (0.7 + seed * 0.6), seed, si], k * 4);
        ps.set([s.x, s.y, s.z, s.strength], k * 4);
      }
    });
    g.setAttribute('pData', new THREE.InstancedBufferAttribute(pd, 4));
    g.setAttribute('pStack', new THREE.InstancedBufferAttribute(ps, 4));
    g.instanceCount = n;
    this.material = new THREE.ShaderMaterial({
      vertexShader: PLUME_VS,
      fragmentShader: PLUME_FS,
      uniforms: {
        uTime: { value: 0 }, uWind: { value: new THREE.Vector2(2, -1) }, uRise: { value: 45 }, uNoise: { value: noise },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uLight: { value: new THREE.Color(0.9, 0.9, 0.88) },
        uAmb: { value: new THREE.Color(0.35, 0.38, 0.42) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.userData.noPathTrace = true;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'landmark-plumes';
  }
  update(t: number, wind: THREE.Vector2, sunDir: THREE.Vector3, sunCol: THREE.Color, sunI: number, night: number): void {
    const u = this.material.uniforms;
    u.uTime.value = t;
    u.uWind.value.copy(wind);
    u.uSunDir.value.copy(sunDir);
    const day = 1 - night;
    (u.uLight.value as THREE.Color).copy(sunCol).multiplyScalar(0.25 * Math.min(sunI, 4) * day + 0.01);
    (u.uAmb.value as THREE.Color).setRGB(0.28 * day + 0.012, 0.31 * day + 0.014, 0.36 * day + 0.02);
  }
}
