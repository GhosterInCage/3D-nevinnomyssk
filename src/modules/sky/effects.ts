// pmndrs/postprocessing effects of the sky pipeline:
//  AtmosphereEffect - sky (Bruneton), aerial perspective, 2D cloud layers,
//                     overlay of volumetric clouds, height fog, night sky
//  GradeEffect      - exposure, vignette, AgX tone mapping with a mild "look"
import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import { atmosphereEffectFrag, atmosphereEffectVert } from './shaders';
import { atmosphereDefines, type SkyUniforms } from './uniforms';

export class AtmosphereEffect extends Effect {
  readonly skInvView = new THREE.Uniform(new THREE.Matrix4());
  readonly skInvProj = new THREE.Uniform(new THREE.Matrix4());
  readonly skProj = new THREE.Uniform(new THREE.Matrix4());
  readonly skCloudsOn = new THREE.Uniform(1);
  readonly skApLut = new THREE.Uniform<THREE.Texture | null>(null);
  readonly skCloudBuf = new THREE.Uniform<THREE.Texture | null>(null);
  readonly skCloudDist = new THREE.Uniform<THREE.Texture | null>(null);
  readonly skGroundAlt = new THREE.Uniform(350);
  readonly skCloudTexel = new THREE.Uniform(new THREE.Vector2(1, 1));
  readonly skShafts = new THREE.Uniform<THREE.Texture | null>(null);
  readonly skShaftColor = new THREE.Uniform(new THREE.Vector3());

  constructor(private cam: THREE.PerspectiveCamera, shared: SkyUniforms) {
    const uniforms = new Map<string, THREE.Uniform>();
    for (const [k, v] of Object.entries(shared)) uniforms.set(k, v as THREE.Uniform);
    super('AtmosphereEffect', atmosphereEffectFrag, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      vertexShader: atmosphereEffectVert,
      uniforms,
      defines: new Map(Object.entries(atmosphereDefines())),
    });
    uniforms.set('skInvView', this.skInvView);
    uniforms.set('skInvProj', this.skInvProj);
    uniforms.set('skProj', this.skProj);
    uniforms.set('skCloudsOn', this.skCloudsOn);
    uniforms.set('skApLut', this.skApLut);
    uniforms.set('skCloudBuf', this.skCloudBuf);
    uniforms.set('skCloudDist', this.skCloudDist);
    uniforms.set('skGroundAlt', this.skGroundAlt);
    uniforms.set('skCloudTexel', this.skCloudTexel);
    uniforms.set('skShafts', this.skShafts);
    uniforms.set('skShaftColor', this.skShaftColor);
  }

  override get mainCamera(): THREE.Camera { return this.cam; }
  override set mainCamera(c: THREE.Camera) { this.cam = c as THREE.PerspectiveCamera; }

  override update(): void {
    const c = this.cam;
    this.skInvView.value.copy(c.matrixWorld);
    this.skInvProj.value.copy(c.projectionMatrixInverse);
    this.skProj.value.copy(c.projectionMatrix);
  }
}

const gradeFrag = /* glsl */ `
uniform float gExposure;
uniform float gVignette;
uniform float gSaturation;
uniform float gPower;
uniform vec3 gLift;
uniform float gAgx;

const mat3 G_SRGB_TO_2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164),
  vec3(0.3293, 0.9195, 0.0880),
  vec3(0.0433, 0.0113, 0.8956)
);
const mat3 G_2020_TO_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182),
  vec3(-0.5876, 1.1329, -0.1006),
  vec3(-0.0728, -0.0083, 1.1187)
);
vec3 gAgxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 gAgX(vec3 color) {
  const mat3 inset = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float minEv = -12.47393;
  const float maxEv = 4.026069;
  color = G_SRGB_TO_2020 * color;
  color = inset * color;
  color = max(color, 1e-10);
  color = log2(color);
  color = (color - minEv) / (maxEv - minEv);
  color = clamp(color, 0.0, 1.0);
  color = gAgxContrast(color);
  // look (ASC CDL power + saturation, like Blender's "Punchy" but milder)
  color = pow(max(color, 0.0), vec3(gPower));
  float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = l + gSaturation * (color - l);
  color = outset * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  color = G_2020_TO_SRGB * color;
  return clamp(color, 0.0, 1.0);
}
uniform float gNight;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb * gExposure;
  // scotopic (Purkinje) shift: dim parts of night scenes lose saturation and turn blue;
  // bright artificial lights keep their colour
  if (gNight > 0.0) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float w = gNight * (1.0 - smoothstep(0.03, 0.5, l)) * 0.75;
    c = mix(c, l * vec3(0.62, 0.8, 1.25), w);
  }
  vec2 d = (uv - 0.5) * vec2(1.0, 0.75);
  c *= 1.0 - gVignette * dot(d, d) * 2.0;
  c += gLift;
  c = gAgx > 0.5 ? gAgX(c) : c;
  outputColor = vec4(c, 1.0);
}
`;

export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', gradeFrag, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['gExposure', new THREE.Uniform(1)],
        ['gVignette', new THREE.Uniform(0.28)],
        ['gSaturation', new THREE.Uniform(1.06)],
        ['gPower', new THREE.Uniform(1.08)],
        ['gLift', new THREE.Uniform(new THREE.Vector3())],
        ['gAgx', new THREE.Uniform(1)],
        ['gNight', new THREE.Uniform(0)],
      ]),
    });
  }
  get exposure(): number { return this.uniforms.get('gExposure')!.value; }
  set exposure(v: number) { this.uniforms.get('gExposure')!.value = v; }
  u(name: string): THREE.Uniform { return this.uniforms.get(name)!; }
}
