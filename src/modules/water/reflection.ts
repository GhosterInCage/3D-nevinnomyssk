// Planar reflections for the water surface.
//
// One mirror plane (y = planeY, chosen each frame at the water nearest to the camera in view) is
// rendered into a half-float target with mirrored cameras: first the backdrop scene (far terrain /
// Caucasus), then the main scene, with an oblique near plane so nothing below the water leaks in
// (technique of three's Reflector). The target's alpha is coverage: where nothing was drawn the
// shader keeps the environment-map (sky) reflection. Shadow maps are not re-rendered for this pass.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';

const _normal = new THREE.Vector3(0, 1, 0);
const _reflPos = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _lookAt = new THREE.Vector3();
const _target = new THREE.Vector3();
const _view = new THREE.Vector3();
const _plane = new THREE.Plane();
const _clip = new THREE.Vector4();
const _q = new THREE.Vector4();
const _clearColor = new THREE.Color();

function obliqueClip(cam: THREE.Camera, projection: THREE.Matrix4, clipBias: number): void {
  _plane.setFromNormalAndCoplanarPoint(_normal, _reflPos);
  _plane.applyMatrix4(cam.matrixWorldInverse);
  _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
  const e = projection.elements;
  _q.x = (Math.sign(_clip.x) + e[8]) / e[0];
  _q.y = (Math.sign(_clip.y) + e[9]) / e[5];
  _q.z = -1.0;
  _q.w = (1.0 + e[10]) / e[14];
  _clip.multiplyScalar(2.0 / _clip.dot(_q));
  e[2] = _clip.x;
  e[6] = _clip.y;
  e[10] = _clip.z + 1.0 - clipBias;
  e[14] = _clip.w;
}

export class PlanarReflection {
  readonly target: THREE.WebGLRenderTarget;
  readonly textureMatrix = new THREE.Matrix4();
  private readonly vcam = new THREE.PerspectiveCamera();
  private readonly vback = new THREE.PerspectiveCamera();
  planeY = 0;
  active = false;
  scale = 0.5;
  maxDistance = 6000;
  renders = 0;

  constructor() {
    this.target = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    });
    this.target.texture.name = 'water-reflection';
    this.target.texture.generateMipmaps = false;
    this.target.texture.minFilter = THREE.LinearFilter;
    this.target.texture.magFilter = THREE.LinearFilter;
    this.vcam.matrixAutoUpdate = true;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    const w = Math.max(16, Math.round(width * pixelRatio * this.scale));
    const h = Math.max(16, Math.round(height * pixelRatio * this.scale));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
  }

  /** Render the mirrored scene. Returns false if the camera is below the plane. */
  render(ctx: AppContext, planeY: number, hide: THREE.Object3D[]): boolean {
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    _camPos.setFromMatrixPosition(cam.matrixWorld);
    _reflPos.set(_camPos.x, planeY, _camPos.z);
    _view.subVectors(_reflPos, _camPos);
    if (_view.dot(_normal) > -0.05) return false;           // camera at/below the water plane
    _view.reflect(_normal).negate().add(_reflPos);
    _rot.extractRotation(cam.matrixWorld);
    _lookAt.set(0, 0, -1).applyMatrix4(_rot).add(_camPos);
    _target.subVectors(_reflPos, _lookAt).reflect(_normal).negate().add(_reflPos);

    const vc = this.vcam;
    vc.position.copy(_view);
    vc.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_normal);
    vc.lookAt(_target);
    vc.near = cam.near;
    vc.far = Math.min(cam.far, this.maxDistance);
    vc.fov = cam.fov;
    vc.aspect = cam.aspect;
    vc.updateProjectionMatrix();
    vc.updateMatrixWorld();
    vc.layers.mask = cam.layers.mask;
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(vc.projectionMatrix);
    this.textureMatrix.multiply(vc.matrixWorldInverse);
    obliqueClip(vc, vc.projectionMatrix, 0.0);

    const vb = this.vback;
    const bc = ctx.backdrop.camera;
    vb.position.copy(vc.position);
    vb.quaternion.copy(vc.quaternion);
    vb.near = bc.near; vb.far = bc.far; vb.fov = cam.fov; vb.aspect = cam.aspect;
    vb.updateProjectionMatrix();
    vb.updateMatrixWorld();
    vb.layers.mask = bc.layers.mask;
    obliqueClip(vb, vb.projectionMatrix, 0.0);

    const r = ctx.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.getClearColor(_clearColor);
    const prevClearAlpha = r.getClearAlpha();
    const prevShadowAuto = r.shadowMap.autoUpdate;
    const prevShadowNeeds = r.shadowMap.needsUpdate;
    const scene = ctx.scene, bscene = ctx.backdrop.scene;
    const sbg = scene.background, bbg = bscene.background;
    const vis = hide.map((o) => o.visible);
    try {
      hide.forEach((o) => { o.visible = false; });
      r.shadowMap.autoUpdate = false;
      r.shadowMap.needsUpdate = false;
      scene.background = null;
      bscene.background = null;
      r.autoClear = false;
      r.setRenderTarget(this.target);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, false);
      r.render(bscene, vb);
      r.clearDepth();
      r.render(scene, vc);
      this.planeY = planeY;
      this.renders++;
    } catch (e) {
      console.error('[water] reflection render failed', e);
      return false;
    } finally {
      hide.forEach((o, i) => { o.visible = vis[i]; });
      scene.background = sbg;
      bscene.background = bbg;
      r.shadowMap.autoUpdate = prevShadowAuto;
      r.shadowMap.needsUpdate = prevShadowNeeds;
      r.setClearColor(_clearColor, prevClearAlpha);
      r.autoClear = prevAutoClear;
      r.setRenderTarget(prevTarget);
    }
    return true;
  }

  dispose(): void {
    this.target.dispose();
  }
}
