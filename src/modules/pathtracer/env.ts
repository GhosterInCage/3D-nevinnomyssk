// Environment maps for the path tracer.
//
// three-gpu-pathtracer importance-samples an equirectangular HDR map whose
// pixels it needs on the CPU (to build the CDF). The sky module publishes its
// sky light as a PMREM (CubeUV) texture, so we render that PMREM into a float
// equirect target on the GPU and read it back. Without the sky module a
// simple analytic clear sky is generated instead (plus a sun disc for the
// directly visible background).
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// same convention as three-gpu-pathtracer's equirectUvToDirection()
const DIR = /* glsl */ `
vec3 ptEquirectDir(vec2 uv) {
  uv.x -= 0.5;
  uv.y = 1.0 - uv.y;
  float theta = uv.x * 2.0 * PI;
  float phi = uv.y * PI;
  float sp = sin(phi);
  return vec3(sp * cos(theta), cos(phi), sp * sin(theta));
}
`;

function cubeUVDefines(imageHeight: number): Record<string, number | string> {
  const maxMip = Math.log2(imageHeight) - 2;
  const texelHeight = 1.0 / imageHeight;
  const texelWidth = 1.0 / (3 * Math.max(Math.pow(2, maxMip), 7 * 16));
  return {
    ENVMAP_TYPE_CUBE_UV: '',
    CUBEUV_TEXEL_WIDTH: texelWidth.toFixed(10),
    CUBEUV_TEXEL_HEIGHT: texelHeight.toFixed(10),
    CUBEUV_MAX_MIP: `${maxMip.toFixed(1)}`,
  };
}

function readFloatTarget(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget, w: number, h: number): Float32Array | null {
  try {
    if (rt.texture.type === THREE.FloatType) {
      const buf = new Float32Array(w * h * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
      return buf;
    }
    const half = new Uint16Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, half);
    const out = new Float32Array(w * h * 4);
    for (let i = 0; i < half.length; i++) out[i] = THREE.DataUtils.fromHalfFloat(half[i]);
    return out;
  } catch (e) {
    console.warn('[pathtracer] env readback failed', e);
    return null;
  }
}

function makeDataTexture(data: Float32Array, w: number, h: number, name: string): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.name = name;
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function renderQuad(renderer: THREE.WebGLRenderer, mat: THREE.ShaderMaterial, w: number, h: number, floatOK: boolean): Float32Array | null {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: floatOK ? THREE.FloatType : THREE.HalfFloatType,
    format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  const prevXr = renderer.xr.enabled;
  renderer.xr.enabled = false;
  try {
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    return readFloatTarget(renderer, rt, w, h);
  } finally {
    renderer.setRenderTarget(prev);
    renderer.xr.enabled = prevXr;
    rt.dispose();
    quad.geometry.dispose();
  }
}

/** Render a PMREM (CubeUV) texture into an equirect float DataTexture. */
export function pmremToEquirect(renderer: THREE.WebGLRenderer, pmrem: THREE.Texture, w: number, h: number, floatOK: boolean, scale = 1): THREE.DataTexture | null {
  const img = pmrem.image as { height?: number } | undefined;
  const H = img?.height;
  if (!H) return null;
  const mat = new THREE.ShaderMaterial({
    defines: cubeUVDefines(H),
    uniforms: { envMap: { value: pmrem }, uScale: { value: scale } },
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      #include <common>
      uniform sampler2D envMap;
      uniform float uScale;
      varying vec2 vUv;
      #include <cube_uv_reflection_fragment>
      ${DIR}
      void main() {
        vec3 d = ptEquirectDir(vUv);
        vec3 c = textureCubeUV(envMap, d, 0.0).rgb * uScale;
        gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
      }`,
    depthTest: false, depthWrite: false, toneMapped: false,
  });
  try {
    const data = renderQuad(renderer, mat, w, h, floatOK);
    if (!data) return null;
    // guard against NaN/Inf from the source
    for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) data[i] = 0;
    return makeDataTexture(data, w, h, 'pt-env');
  } finally {
    mat.dispose();
  }
}

/**
 * Analytic clear sky (no sun disc) in scene radiance units (noon sun
 * irradiance ~3). Used when the sky module is not loaded.
 */
export function analyticSky(renderer: THREE.WebGLRenderer, sunDir: THREE.Vector3, w: number, h: number, floatOK: boolean, withSun: boolean, sunColor: THREE.Color, sunIntensity: number): THREE.DataTexture | null {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: sunDir.clone().normalize() },
      uSunCol: { value: sunColor.clone().multiplyScalar(sunIntensity) },
      uWithSun: { value: withSun ? 1 : 0 },
    },
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      #include <common>
      uniform vec3 uSun;
      uniform vec3 uSunCol;
      uniform float uWithSun;
      varying vec2 vUv;
      ${DIR}
      void main() {
        vec3 d = ptEquirectDir(vUv);
        float el = max(uSun.y, -0.2);
        float day = smoothstep(-0.12, 0.08, el);
        float mu = dot(d, uSun);
        vec3 zenith = vec3(0.10, 0.20, 0.45) * (0.25 + 0.75 * day);
        vec3 horizon = vec3(0.42, 0.46, 0.52) * (0.2 + 0.8 * day);
        // warmer horizon at low sun
        horizon = mix(horizon, vec3(0.75, 0.48, 0.28) * 0.6, (1.0 - smoothstep(0.05, 0.35, el)) * day);
        float t = pow(clamp(d.y, 0.0, 1.0), 0.45);
        vec3 c = mix(horizon, zenith, t);
        // mie glow around the sun
        c += uSunCol * 0.018 * pow(max(mu, 0.0), 12.0) + uSunCol * 0.004 * pow(max(mu, 0.0), 2.0);
        if (d.y < 0.0) {
          // lambertian ground seen through haze
          vec3 g = vec3(0.12, 0.11, 0.08) * (max(el, 0.0) * uSunCol / PI + 0.25 * day);
          c = mix(horizon * 0.8, g, smoothstep(0.0, -0.15, d.y));
        }
        c *= mix(0.02, 1.0, day);
        if (uWithSun > 0.5) {
          // sun disc (0.53 deg), limb darkened; its radiance integrates to the sun irradiance
          float cosR = cos(0.00465);
          if (mu > cosR) {
            float r = sqrt(max(0.0, 1.0 - (1.0 - mu) / (1.0 - cosR)));
            float solidAngle = 2.0 * PI * (1.0 - cosR);
            c += uSunCol / solidAngle * (0.4 + 0.6 * r);
          }
        }
        gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
      }`,
    depthTest: false, depthWrite: false, toneMapped: false,
  });
  try {
    const data = renderQuad(renderer, mat, w, h, floatOK);
    return data ? makeDataTexture(data, w, h, withSun ? 'pt-bg' : 'pt-env') : null;
  } finally {
    mat.dispose();
  }
}

/** Uniform environment (last-resort fallback). */
export function constantEnv(value: number): THREE.DataTexture {
  const w = 16, h = 8;
  const d = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[4 * i] = value * 0.8; d[4 * i + 1] = value * 0.9; d[4 * i + 2] = value; d[4 * i + 3] = 1; }
  return makeDataTexture(d, w, h, 'pt-env-const');
}

/** 1x1 black equirect (transparent background in composite mode). */
export function blackEquirect(): THREE.DataTexture {
  return makeDataTexture(new Float32Array([0, 0, 0, 0]), 1, 1, 'pt-black');
}
