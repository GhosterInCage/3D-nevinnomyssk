// Rain: GPU-animated motion-blurred streaks in a box that wraps around the
// camera (world anchored, so walking through the rain looks right). Lit by the
// sky ambient; fades with distance. The wet-look signal is ctx.env.rain.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import type { SkyLighting } from './lighting';

const vert = /* glsl */ `
uniform vec3 uCam;
uniform float uTime;
uniform vec3 uBox;
uniform vec2 uWind;
uniform float uSpeed;
uniform float uLen;
uniform float uWidth;
uniform float uAmount;
attribute vec3 seed;
varying float vAlpha;
varying float vU;
void main() {
  float fall = uSpeed * (0.8 + seed.z * 0.4);
  vec3 vel = vec3(uWind.x, -fall, uWind.y);
  vec3 local = vec3(seed.x * uBox.x, seed.z * 7.13 * uBox.y, seed.y * uBox.z) + vel * uTime;
  vec3 origin = uCam - uBox * vec3(0.5, 0.6, 0.5);
  vec3 wp = origin + mod(local - origin, uBox);
  vec3 vdir = normalize(vel);
  vec3 toCam = uCam - wp;
  float dist = length(toCam);
  vec3 side = normalize(cross(vdir, toCam));
  float len = uLen * (0.7 + seed.x * 0.6);
  vec3 p = wp + side * position.x * uWidth * (1.0 + dist * 0.015) - vdir * position.y * len;
  vU = position.x * 2.0;
  // hide drops that are too close (huge) or far; only a fraction active for light rain
  float active = step(seed.y * 0.999, uAmount * 1.1);
  vAlpha = active * smoothstep(0.6, 2.5, dist) * (1.0 - smoothstep(uBox.x * 0.32, uBox.x * 0.5, dist));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const frag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
varying float vU;
void main() {
  float a = vAlpha * uOpacity * (1.0 - vU * vU);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

export class Rain {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.InstancedBufferGeometry;
  private time = 0;

  constructor(private ctx: AppContext) {
    const count = this.countFor();
    this.geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    this.geo.setAttribute('seed', new THREE.InstancedBufferAttribute(seeds, 3));
    this.geo.instanceCount = count;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uCam: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uBox: { value: new THREE.Vector3(40, 26, 40) },
        uWind: { value: new THREE.Vector2() },
        uSpeed: { value: 8.5 },
        uLen: { value: 0.55 },
        uWidth: { value: 0.012 },
        uAmount: { value: 0 },
        uColor: { value: new THREE.Color(0.2, 0.2, 0.22) },
        uOpacity: { value: 0.35 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'sky:rain';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    this.mesh.userData.noPathTrace = true;
    this.mesh.userData.noSkyPatch = true;
    ctx.scene.add(this.mesh);
  }

  private countFor(): number {
    const q = this.ctx.settings.quality;
    return q === 'low' ? 2500 : q === 'medium' ? 7000 : 14000;
  }

  applyQuality(): void {
    this.geo.instanceCount = Math.min(this.countFor(), (this.geo.getAttribute('seed') as THREE.InstancedBufferAttribute).count);
  }

  update(dt: number, amount: number, lighting: SkyLighting): void {
    this.time += dt;
    const vis = amount > 0.01;
    this.mesh.visible = vis;
    if (!vis) return;
    const u = this.mat.uniforms;
    const cam = this.ctx.camera.position;
    u.uCam.value.copy(cam);
    u.uTime.value = this.time;
    u.uWind.value.copy(this.ctx.env.wind).multiplyScalar(1.4);
    u.uAmount.value = amount;
    // streak radiance ~ sky ambient (drops refract/reflect the overcast sky)
    const s = lighting.skyIrr;
    const k = 2 * 0.55 / Math.PI;
    u.uColor.value.setRGB(s.r * k + 0.004, s.g * k + 0.004, s.b * k + 0.005);
    u.uOpacity.value = 0.25 + 0.2 * amount;
  }
}
