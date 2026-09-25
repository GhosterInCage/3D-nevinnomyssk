// Cascaded shadow maps for three's SunLight (three/addons/lights/SunLight.js).
//
// three r186 ships a SunLight whose shadow is a cascaded atlas handled natively
// by WebGLRenderer (every built-in lit material supports it, no material
// patching). The stock SunLightShadow is fixed to 2 cascades and a split scheme
// that starts at the camera near plane. CityShadow generalises it:
//  * N cascades (1..4) in a 2x2 / Nx1 atlas; the shader chunk's
//    SUN_LIGHT_CASCADES define is patched to match (see patchShadowChunk)
//  * split scheme adapted to altitude: cascades start near the closest visible
//    ground and extend further when flying high
//  * bounding-sphere fitting + texel snapping (no shimmering), caster ceiling
//    raised so tall casters outside the frustum (GRES chimney) still cast
//  * per-cascade depth range proportional to texel size so one normalised
//    depth bias gives a bias of ~constant texel count in every cascade
import * as THREE from 'three';

const _lightOrientationMatrix = new THREE.Matrix4();
const _viewToLightMatrix = new THREE.Matrix4();
const _lightDirection = new THREE.Vector3();
const _up = new THREE.Vector3();
const _center = new THREE.Vector3();
const _near = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _far = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());

export const MAX_CASCADES = 4;
const CASCADE_FADE = 0.12;

export class CityShadow extends THREE.LightShadow<THREE.OrthographicCamera> {
  readonly isSunLightShadow = true;
  readonly cascades: number;
  /** Where the first cascade starts (m, view depth). Set every frame by the sky module. */
  startDistance = 0.2;
  /** Where the last cascade ends (m, view depth). */
  endDistance = 1500;
  /** 0 = uniform, 1 = logarithmic splits. */
  splitLambda = 0.9;
  /** Bias in texels (normalised depth bias is derived from it). */
  biasTexels = 1.2;
  /** Height above the frustum (m) up to which casters are included. */
  casterCeiling = 600;

  private _cameras: THREE.OrthographicCamera[] = [];
  private _matrices: THREE.Matrix4[] = [];
  private _frustums: THREE.Frustum[] = [];
  private _cascadeSplits: number[];
  /** per cascade (begin, end, fadeStart, 0) view depths — read by WebGLLights */
  _cascadeData: THREE.Vector4[] = [];
  readonly texelSizes: number[] = [];

  constructor(cascades: number, mapSize: number) {
    super(new THREE.OrthographicCamera(-5, 5, 5, -5, 0.5, 500));
    this.cascades = Math.max(1, Math.min(MAX_CASCADES, cascades | 0));
    this.mapSize.set(mapSize, mapSize);
    this._cascadeSplits = new Array(this.cascades + 1).fill(0);
    const self = this as any;
    self._viewportCount = this.cascades;
    const cols = this.cascades <= 2 ? this.cascades : 2;
    const rows = this.cascades <= 2 ? 1 : 2;
    self._frameExtents.set(cols, rows);
    for (let i = 0; i < this.cascades; i++) {
      this._cameras.push(new THREE.OrthographicCamera());
      this._matrices.push(new THREE.Matrix4());
      this._frustums.push(new THREE.Frustum());
      this._cascadeData.push(new THREE.Vector4());
      this.texelSizes.push(1);
    }
    while (self._viewports.length < this.cascades) self._viewports.push(new THREE.Vector4());
  }

  getCamera(i = 0): THREE.OrthographicCamera { return this._cameras[i]; }
  getMatrix(i = 0): THREE.Matrix4 { return this._matrices[i]; }
  getFrustum(i = 0): THREE.Frustum { return this._frustums[i]; }
  get splits(): readonly number[] { return this._cascadeSplits; }

  updateMatrices(light: THREE.Light, viewCamera?: THREE.Camera): void {
    const vc = viewCamera as THREE.PerspectiveCamera | undefined;
    if (!vc || !vc.isPerspectiveCamera) return;
    const self = this as any;
    const n = this.cascades;
    const cols = self._frameExtents.x as number;
    const inset = Math.min(0.25, (Math.ceil(this.radius) + 2) / this.mapSize.x);
    for (let i = 0; i < n; i++) {
      const cx = i % cols, cy = Math.floor(i / cols);
      self._viewports[i].set(cx + inset, cy + inset, 1 - 2 * inset, 1 - 2 * inset);
    }
    const resolution = this.mapSize.x * (1 - 2 * inset);

    const camNear = vc.near;
    const start = Math.max(camNear, this.startDistance);
    const end = Math.max(start + 1, Math.min(this.endDistance, vc.far));
    const splits = this._cascadeSplits;
    splits[0] = start;
    for (let i = 1; i < n; i++) {
      const f = i / n;
      const uni = start + (end - start) * f;
      const log = start * Math.pow(end / start, f);
      splits[i] = THREE.MathUtils.lerp(uni, log, this.splitLambda);
    }
    splits[n] = end;

    _lightDirection.setFromMatrixPosition(light.matrixWorld).negate().normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_lightDirection)) > 0.99) _up.set(0, 0, 1);
    _lightOrientationMatrix.lookAt(_center.set(0, 0, 0), _lightDirection, _up);
    _viewToLightMatrix.copy(_lightOrientationMatrix).transpose().multiply(vc.matrixWorld);

    // frustum corners at unit view depth (view space), scaled per slice
    const inv = vc.projectionMatrixInverse;
    for (let i = 0; i < 4; i++) {
      const x = i === 0 || i === 1 ? 1 : -1;
      const y = i === 0 || i === 3 ? 1 : -1;
      const c = _near[i].set(x, y, -1).applyMatrix4(inv);
      c.multiplyScalar(1 / -c.z); // view-space point at depth 1
    }

    let globalMaxZ = -Infinity;
    for (let i = 0; i < 4; i++) {
      for (const d of [start, end]) {
        const p = _far[i].copy(_near[i]).multiplyScalar(d).applyMatrix4(_viewToLightMatrix);
        globalMaxZ = Math.max(globalMaxZ, p.z);
      }
    }
    // raise the caster ceiling towards the light
    const up = this.casterCeiling / Math.max(0.05, Math.abs(_lightDirection.y));
    globalMaxZ += Math.min(up, 20000);

    const shadowNear = 1.0;
    let biasK = 0;
    const ranges: number[] = [];
    for (let i = 0; i < n; i++) {
      const cNear = i === 0 ? splits[0] : this._cascadeData[i - 1].z;
      const cFar = splits[i + 1];
      const fadeStart = cFar - CASCADE_FADE * (cFar - splits[i]);
      this._cascadeData[i].set(i === 0 ? -1e10 : cNear, cFar, fadeStart, 0);

      _center.set(0, 0, 0);
      for (let j = 0; j < 4; j++) {
        _corners[j * 2].copy(_near[j]).multiplyScalar(cNear).applyMatrix4(_viewToLightMatrix);
        _corners[j * 2 + 1].copy(_near[j]).multiplyScalar(cFar).applyMatrix4(_viewToLightMatrix);
        _center.add(_corners[j * 2]).add(_corners[j * 2 + 1]);
      }
      _center.multiplyScalar(1 / 8);
      let r2 = 0, minZ = Infinity;
      for (let j = 0; j < 8; j++) {
        r2 = Math.max(r2, _corners[j].distanceToSquared(_center));
        minZ = Math.min(minZ, _corners[j].z);
      }
      let radius = Math.sqrt(r2);
      radius /= 1 - 1 / resolution;
      // quantise the radius so it only changes in steps (stable texel size)
      radius = Math.pow(2, Math.ceil(Math.log2(radius) * 8) / 8);
      const texel = (2 * radius) / resolution;
      this.texelSizes[i] = texel;
      _center.x = Math.round(_center.x / texel) * texel;
      _center.y = Math.round(_center.y / texel) * texel;
      const required = globalMaxZ - minZ + 2 * shadowNear;
      ranges.push(required);
      biasK = Math.max(biasK, required / texel);
      (this._cameras[i] as any)._radius = radius;
      (this._cameras[i] as any)._cz = _center.z;
      this._cameras[i].userData.center = _center.clone();
    }
    // per-cascade depth range proportional to the texel size
    for (let i = 0; i < n; i++) {
      const cam = this._cameras[i];
      const radius = (cam as any)._radius as number;
      const texel = this.texelSizes[i];
      const range = Math.max(ranges[i], biasK * texel);
      const c = cam.userData.center as THREE.Vector3;
      c.z = globalMaxZ + shadowNear;
      c.applyMatrix4(_lightOrientationMatrix);
      cam.position.copy(c);
      cam.quaternion.setFromRotationMatrix(_lightOrientationMatrix);
      cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
      cam.near = shadowNear;
      cam.far = shadowNear + range;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      self._updateMatrix(cam, this._matrices[i], this._frustums[i], self._viewports[i]);
    }
    // normalised depth bias ~ biasTexels texels in every cascade
    this.bias = -this.biasTexels / biasK;
  }
}

/**
 * Patch three's shadow chunk for N sun cascades and a normal bias that grows
 * with view depth (texels get bigger in far cascades). Returns false if the
 * chunk text did not match (three version drift) - shadows then still work
 * with the stock behaviour only if cascades === 2.
 */
export function patchShadowChunk(cascades: number): boolean {
  const SC = THREE.ShaderChunk as any;
  const orig: string = SC.__skyOrigShadowParsFragment ?? SC.shadowmap_pars_fragment;
  SC.__skyOrigShadowParsFragment = orig;
  let src = orig;
  const a = src.replace(/#define SUN_LIGHT_CASCADES \d+/, `#define SUN_LIGHT_CASCADES ${cascades}`);
  const okA = a !== src || cascades === 2;
  src = a;
  const re = /vec4 shadowWorldPosition = vec4\( vSunShadowWorldPosition\.xyz \+ vSunShadowWorldNormal \* sunLightShadow\.shadowNormalBias, 1\.0 \);\s*float viewDepth = vSunShadowWorldPosition\.w;/;
  const b = src.replace(re,
    'float viewDepth = vSunShadowWorldPosition.w;\n\t\t\tvec4 shadowWorldPosition = vec4( vSunShadowWorldPosition.xyz + vSunShadowWorldNormal * sunLightShadow.shadowNormalBias * clamp( viewDepth * 0.02, 1.0, 80.0 ), 1.0 );');
  src = b;
  SC.shadowmap_pars_fragment = src;
  return okA;
}
