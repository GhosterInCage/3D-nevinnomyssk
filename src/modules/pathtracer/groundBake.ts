// Ground albedo bake for the path tracer.
//
// The terrain module's ground shader (class-blended detail textures, fields,
// lawns, yards, wet banks...) cannot run inside the path tracer, whose terrain
// proxy would otherwise only carry the 10 m macro albedo. Here that exact
// shader is rendered once, top-down, over a square around the camera with no
// lights and a uniform white environment of radiance 1: the diffuse output of
// a lambertian surface under such lighting is its albedo. A small correction
// removes the (rough dielectric) specular term. Where the CDLOD mesh has no
// patches (behind the camera) the macro albedo shows through.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';

export interface GroundBakeResult {
  texture: THREE.Texture;
  x0: number;
  z0: number;
  size: number;
}

const quadVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class GroundBake {
  private rtA: THREE.WebGLRenderTarget | null = null;
  private rtB: THREE.WebGLRenderTarget | null = null;
  private whiteEnv: THREE.WebGLRenderTarget | null = null;

  constructor(private ctx: AppContext) {}

  private ensureTargets(n: number): void {
    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter } as const;
    if (!this.rtA || this.rtA.width !== n) {
      this.rtA?.dispose(); this.rtB?.dispose();
      this.rtA = new THREE.WebGLRenderTarget(n, n, { ...opts, depthBuffer: true });
      this.rtB = new THREE.WebGLRenderTarget(n, n, { ...opts, depthBuffer: false });
      this.rtB.texture.colorSpace = THREE.LinearSRGBColorSpace;
      this.rtB.texture.wrapS = this.rtB.texture.wrapT = THREE.ClampToEdgeWrapping;
    }
  }

  private white(): THREE.Texture {
    if (!this.whiteEnv) {
      const pm = new THREE.PMREMGenerator(this.ctx.renderer);
      const sc = new THREE.Scene();
      sc.background = new THREE.Color(1, 1, 1);
      this.whiteEnv = pm.fromScene(sc, 0, 0.1, 10);
      pm.dispose();
    }
    return this.whiteEnv.texture;
  }

  /**
   * Bake the ground albedo over [cx-half, cx+half] x [cz-half, cz+half]. `macro` is the 10 m albedo
   * map of the whole region (uv = ((x+H)/S, 1-(z+H)/S), flipY image) used where no terrain draws.
   */
  bake(cx: number, cz: number, half: number, n: number, macro: THREE.Texture | null): GroundBakeResult | null {
    const ctx = this.ctx;
    const terrain = ctx.get<any>('terrain');
    const group: THREE.Object3D | undefined = terrain?.mesh;
    const hf = ctx.heightfield;
    if (!group || !hf) return null;
    const r = ctx.renderer;
    this.ensureTargets(n);
    const rtA = this.rtA!, rtB = this.rtB!;
    const size = 2 * half;
    const x0 = cx - half, z0 = cz - half;
    const gy = hf.sample(cx, cz);

    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevAlpha = r.getClearAlpha();
    const prevColor = new THREE.Color();
    r.getClearColor(prevColor);
    const prevTone = r.toneMapping;
    const prevShadow = r.shadowMap.enabled;
    const quadScene = new THREE.Scene();
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const disposables: Array<{ dispose(): void }> = [];
    try {
      r.toneMapping = THREE.NoToneMapping;
      r.shadowMap.enabled = false;
      r.autoClear = false;
      r.setRenderTarget(rtA);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, false);

      // 1. macro albedo underlay (alpha 0.5 marks "not shaded by the terrain material")
      if (macro) {
        const H = hf.half, S = 2 * hf.half;
        const m = new THREE.ShaderMaterial({
          uniforms: { tMacro: { value: macro }, uReg: { value: new THREE.Vector4(x0, z0, size, 0) }, uHS: { value: new THREE.Vector2(H, S) } },
          vertexShader: quadVert,
          fragmentShader: /* glsl */ `
            uniform sampler2D tMacro; uniform vec4 uReg; uniform vec2 uHS; varying vec2 vUv;
            void main() {
              // bake texel -> world (row 0 = south edge)
              float x = uReg.x + vUv.x * uReg.z;
              float z = uReg.y + (1.0 - vUv.y) * uReg.z;
              vec2 uv = vec2((x + uHS.x) / uHS.y, 1.0 - (z + uHS.x) / uHS.y);
              gl_FragColor = vec4(texture2D(tMacro, uv).rgb, 0.5);
            }`,
          depthTest: false, depthWrite: false, toneMapped: false,
        });
        disposables.push(m);
        const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
        q.frustumCulled = false;
        disposables.push(q.geometry);
        quadScene.add(q);
        r.render(quadScene, quadCam);
        quadScene.remove(q);
      }

      // 2. the terrain's own ground material, lit by a uniform white sky only
      const cam = new THREE.OrthographicCamera(-half, half, half, -half, -4000, 4000);
      cam.up.set(0, 0, -1);
      cam.position.set(cx, gy + 1.5, cz);
      cam.lookAt(cx, gy - 10, cz);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      const scene = ctx.scene;
      const kids = scene.children.slice();
      const env = scene.environment, envI = scene.environmentIntensity, bg = scene.background, fog = scene.fog;
      const gParent = group.parent;
      scene.children.length = 0;
      scene.children.push(group);
      scene.environment = this.white();
      scene.environmentIntensity = 1;
      scene.background = null;
      scene.fog = null;
      try {
        (group as any).parent = scene;
        r.render(scene, cam);
      } finally {
        scene.children.length = 0;
        for (const k of kids) scene.children.push(k);
        (group as any).parent = gParent;
        scene.environment = env;
        scene.environmentIntensity = envI;
        scene.background = bg;
        scene.fog = fog;
      }

      // 3. remove the specular part: out = AO * (kd * albedo + ks) under unit white light
      const fix = new THREE.ShaderMaterial({
        uniforms: { tIn: { value: rtA.texture } },
        vertexShader: quadVert,
        fragmentShader: /* glsl */ `
          uniform sampler2D tIn; varying vec2 vUv;
          void main() {
            vec4 c = texture2D(tIn, vUv);
            vec3 a = c.a > 0.75 ? (c.rgb - 0.018) / 0.97 : c.rgb;
            gl_FragColor = vec4(clamp(a, vec3(0.0), vec3(0.95)), 1.0);
          }`,
        depthTest: false, depthWrite: false, toneMapped: false,
      });
      disposables.push(fix);
      const q2 = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fix);
      q2.frustumCulled = false;
      disposables.push(q2.geometry);
      quadScene.add(q2);
      r.setRenderTarget(rtB);
      r.render(quadScene, quadCam);
    } catch (e) {
      console.warn('[pathtracer] ground bake failed', e);
      return null;
    } finally {
      r.setRenderTarget(prevTarget);
      r.autoClear = prevAuto;
      r.setClearColor(prevColor, prevAlpha);
      r.toneMapping = prevTone;
      r.shadowMap.enabled = prevShadow;
      for (const d of disposables) d.dispose();
    }
    return { texture: rtB.texture, x0, z0, size };
  }

  /** Mean luminance of the baked albedo on a sparse grid (a failed shader compile gives ~0). */
  meanLuminance(): number {
    const rt = this.rtB;
    if (!rt) return 0;
    try {
      const n = 16, step = Math.max(1, Math.floor(rt.width / n));
      const row = new Uint16Array(rt.width * 4);
      let s = 0, c = 0;
      for (let j = 0; j < n; j++) {
        this.ctx.renderer.readRenderTargetPixels(rt, 0, Math.min(rt.height - 1, Math.floor((j + 0.5) * step)), rt.width, 1, row);
        for (let i = 0; i < n; i++) {
          const k = 4 * Math.min(rt.width - 1, Math.floor((i + 0.5) * step));
          const f = THREE.DataUtils.fromHalfFloat;
          s += 0.2126 * f(row[k]) + 0.7152 * f(row[k + 1]) + 0.0722 * f(row[k + 2]);
          c++;
        }
      }
      return s / Math.max(1, c);
    } catch {
      return -1;
    }
  }

  dispose(): void {
    this.rtA?.dispose(); this.rtB?.dispose(); this.whiteEnv?.dispose();
    this.rtA = this.rtB = this.whiteEnv = null;
  }
}
