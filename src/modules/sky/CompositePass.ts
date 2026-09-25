// First pass of the sky pipeline: renders the backdrop scene and the main scene
// into their own HDR targets (each with its own camera depth range), merges
// them into the composer buffer and writes a single combined depth expressed in
// the "atmosphere camera" (same pose/fov as the main camera, near 1 m, far
// 1000 km). Every later effect (AO, aerial perspective, clouds, fog) then sees
// one consistent depth buffer that also covers the far Caucasus backdrop.
// Stars are drawn last, only where the combined depth is the far plane.
import * as THREE from 'three';
import { Pass } from 'postprocessing';
import { StarsGeometry } from '@takram/three-atmosphere';
import type { AppContext } from '../../core/context';

export const AP_NEAR = 1.0;
export const AP_FAR = 1.0e6;

const compositeVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }
`;

const compositeFrag = /* glsl */ `
#include <packing>
uniform sampler2D tMain;
uniform sampler2D tMainDepth;
uniform sampler2D tBack;
uniform sampler2D tBackDepth;
uniform vec4 nearFar;   // main near/far, backdrop near/far
uniform vec2 apNearFar;
varying vec2 vUv;
void main() {
  vec4 m = texture2D(tMain, vUv);
  vec4 b = texture2D(tBack, vUv);
  float dm = texture2D(tMainDepth, vUv).r;
  float db = texture2D(tBackDepth, vUv).r;
  vec3 rgb = m.rgb + (1.0 - m.a) * b.rgb;
  float a;
  float depth;
  if (dm < 1.0) {
    float z = perspectiveDepthToViewZ(dm, nearFar.x, nearFar.y);
    depth = viewZToPerspectiveDepth(min(z, -apNearFar.x), apNearFar.x, apNearFar.y);
    a = 1.0;
  } else if (db < 1.0) {
    float z = perspectiveDepthToViewZ(db, nearFar.z, nearFar.w);
    depth = min(viewZToPerspectiveDepth(min(z, -apNearFar.x), apNearFar.x, apNearFar.y), 0.99999994);
    a = 1.0;
  } else {
    depth = 1.0;
    a = clamp(m.a + (1.0 - m.a) * b.a, 0.0, 1.0);
  }
  gl_FragColor = vec4(rgb, a);
  gl_FragDepth = depth;
}
`;

const starsVert = /* glsl */ `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat3 starRot;
uniform vec3 camPos;
uniform float pointSize;
uniform vec2 magnitudeRange;
uniform float intensity;
in vec3 position;
in float magnitude;
in vec3 color;
out vec3 vColor;
void main() {
  float mg = mix(magnitudeRange.x, magnitudeRange.y, magnitude);
  vec3 v = pow(vec3(10.0), -vec3(magnitudeRange, mg) / 2.5);
  vColor = intensity * color * clamp((v.z - v.y) / (v.x - v.y), 0.0, 1.0);
  vec3 dir = normalize(starRot * position);
  // fade out below the horizon (rendered only where nothing else is anyway)
  vColor *= smoothstep(-0.02, 0.05, dir.y);
  vec4 p = projectionMatrix * viewMatrix * vec4(camPos + dir * 1000.0, 1.0);
  p.z = p.w;
  gl_Position = p;
  gl_PointSize = pointSize;
}
`;

const starsFrag = /* glsl */ `
precision highp float;
in vec3 vColor;
out vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float f = exp(-dot(c, c) * 2.5);
  fragColor = vec4(vColor * f, 0.0);
}
`;

function makeTarget(): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  rt.depthTexture.format = THREE.DepthFormat;
  rt.texture.name = 'sky.composite.color';
  return rt;
}

export class CompositePass extends Pass {
  readonly rtMain = makeTarget();
  readonly rtBack = makeTarget();
  private readonly mat: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly starScene = new THREE.Scene();
  stars: THREE.Points | null = null;
  starMaterial: THREE.RawShaderMaterial | null = null;
  readonly starRot = new THREE.Matrix3();
  starIntensity = 0;
  private readonly clearColor = new THREE.Color();

  constructor(private ctx: AppContext, private apCamera: THREE.PerspectiveCamera) {
    super('SkyCompositePass');
    this.needsSwap = false;
    this.needsDepthBlit = true;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: compositeVert,
      fragmentShader: compositeFrag,
      uniforms: {
        tMain: { value: this.rtMain.texture },
        tMainDepth: { value: this.rtMain.depthTexture },
        tBack: { value: this.rtBack.texture },
        tBackDepth: { value: this.rtBack.depthTexture },
        nearFar: { value: new THREE.Vector4() },
        apNearFar: { value: new THREE.Vector2(AP_NEAR, AP_FAR) },
      },
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.AlwaysDepth,
      toneMapped: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  setStars(data: ArrayBuffer): void {
    const geo = new StarsGeometry(data);
    this.starMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: starsVert,
      fragmentShader: starsFrag,
      uniforms: {
        starRot: { value: this.starRot },
        camPos: { value: new THREE.Vector3() },
        pointSize: { value: 2.0 },
        magnitudeRange: { value: new THREE.Vector2(-2, 8) },
        intensity: { value: 0 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      toneMapped: false,
    });
    this.stars = new THREE.Points(geo, this.starMaterial);
    this.stars.frustumCulled = false;
    this.starScene.add(this.stars);
  }

  override setSize(width: number, height: number): void {
    this.rtMain.setSize(width, height);
    this.rtBack.setSize(width, height);
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget): void {
    const ctx = this.ctx;
    const prevClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColor);
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);

    const scene = ctx.scene;
    const bg = scene.background;
    const fog = scene.fog;
    scene.background = null;

    // ---- backdrop (sky dome replaced by the atmosphere effect, far terrain etc.)
    const bscene = ctx.backdrop.scene;
    const bbg = bscene.background;
    bscene.background = null;
    renderer.setRenderTarget(this.rtBack);
    renderer.clear(true, true, false);
    try { renderer.render(bscene, ctx.backdrop.camera); } catch (e) { console.error('[sky] backdrop render', e); }
    bscene.background = bbg;

    // ---- main scene
    renderer.setRenderTarget(this.rtMain);
    renderer.clear(true, true, false);
    try { renderer.render(scene, ctx.camera); } catch (e) { console.error('[sky] scene render', e); }
    scene.background = bg;
    scene.fog = fog;

    // ---- composite into the composer buffer (+ combined depth)
    const u = this.mat.uniforms;
    u.nearFar.value.set(ctx.camera.near, ctx.camera.far, ctx.backdrop.camera.near, ctx.backdrop.camera.far);
    renderer.setRenderTarget(inputBuffer);
    renderer.clear(true, true, false);
    renderer.render(this.quadScene, this.quadCam);

    // ---- stars (only on far-plane pixels)
    if (this.stars && this.starMaterial && this.starIntensity > 0) {
      const su = this.starMaterial.uniforms;
      su.intensity.value = this.starIntensity;
      su.camPos.value.copy(this.apCamera.position);
      renderer.render(this.starScene, this.apCamera);
    }

    renderer.setClearColor(this.clearColor, prevClearAlpha);
    renderer.autoClear = prevAutoClear;
  }

  dispose(): void {
    this.rtMain.dispose();
    this.rtBack.dispose();
    this.mat.dispose();
    this.stars?.geometry.dispose();
    this.starMaterial?.dispose();
  }
}
