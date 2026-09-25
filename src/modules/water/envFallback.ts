// Fallback reflection environment used only while the scene has no `scene.environment` (e.g. with
// ?only=water or before the sky module installs its own). A cheap analytic clear-sky gradient with
// a forward-scattering glow around the sun (no sun disc: the sun glint comes from the directional
// light's specular) is rendered through PMREMGenerator. Regenerated when the sun moves noticeably.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const frag = /* glsl */ `
uniform vec3 sunDir;
uniform float night;
uniform float cloud;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float sunH = sunDir.y;
  float day = clamp(sunH * 4.0 + 0.3, 0.0, 1.0);
  vec3 zenith = mix(vec3(0.004, 0.006, 0.012), vec3(0.12, 0.24, 0.58), day);
  vec3 horizon = mix(vec3(0.010, 0.012, 0.020), vec3(0.42, 0.52, 0.66), day);
  // warm horizon at low sun
  float low = smoothstep(0.35, 0.02, sunH) * day;
  horizon = mix(horizon, vec3(0.95, 0.62, 0.38), low * 0.55 * pow(max(dot(normalize(d.xz + 1e-4), normalize(sunDir.xz + 1e-4)), 0.0), 2.0));
  vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.45));
  float mu = max(dot(d, sunDir), 0.0);
  col += vec3(1.0, 0.86, 0.66) * day * (0.35 * pow(mu, 12.0) + 0.10 * pow(mu, 3.0));
  col = mix(col, vec3(0.62, 0.64, 0.68) * (0.15 + 0.85 * day), cloud * 0.6);
  // below the horizon: dim ground bounce
  vec3 groundCol = mix(horizon * 0.45, vec3(0.13, 0.13, 0.11) * (0.05 + 0.95 * day), smoothstep(0.0, -0.25, h));
  col = h < 0.0 ? groundCol : col;
  gl_FragColor = vec4(col * 0.6, 1.0);
}`;

export class FallbackEnvironment {
  texture: THREE.Texture | null = null;
  private pmrem: THREE.PMREMGenerator;
  private scene = new THREE.Scene();
  private mat: THREE.ShaderMaterial;
  private rt: THREE.WebGLRenderTarget | null = null;
  private lastSun = new THREE.Vector3(0, -2, 0);
  private lastCloud = -1;

  constructor(private ctx: AppContext) {
    this.pmrem = new THREE.PMREMGenerator(ctx.renderer);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, side: THREE.BackSide, depthWrite: false,
      uniforms: { sunDir: { value: new THREE.Vector3(0, 1, 0) }, night: { value: 0 }, cloud: { value: 0 } },
    });
    const box = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100), this.mat);
    this.scene.add(box);
  }

  /** Update if the sun moved; returns the current texture. */
  update(): THREE.Texture | null {
    const env = this.ctx.env;
    if (this.texture && this.lastSun.angleTo(env.sunDirection) < 0.02 && Math.abs(this.lastCloud - env.cloudCover) < 0.05) return this.texture;
    this.lastSun.copy(env.sunDirection);
    this.lastCloud = env.cloudCover;
    this.mat.uniforms.sunDir.value.copy(env.sunDirection);
    this.mat.uniforms.night.value = env.night;
    this.mat.uniforms.cloud.value = env.cloudCover;
    const prev = this.ctx.renderer.getRenderTarget();
    const rt = this.pmrem.fromScene(this.scene, 0, 0.1, 1000);
    this.ctx.renderer.setRenderTarget(prev);
    if (this.rt) this.rt.dispose();
    this.rt = rt;
    this.texture = rt.texture;
    return this.texture;
  }

  dispose(): void {
    this.rt?.dispose();
    this.pmrem.dispose();
  }
}
