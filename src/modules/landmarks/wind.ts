// Kochubeevskaya wind farm (NovaWind, 84 x 2.5 MW, 2020-2021; Lagerwey L100 design: direct-drive
// ring generator, 100 m hub height, 100 m rotor). Three InstancedMeshes: towers (static),
// nacelles (yawed into the wind) and rotors (yaw + spin). Blinking red obstruction lights at night.
import * as THREE from 'three';
import { Geo, P, F, col } from './builder';
import type { GlowSpec } from './effects';

export const HUB = 100;
export const ROTOR_R = 50;

export function towerGeo(): THREE.BufferGeometry {
  const g = new Geo();
  const white = col('#e6e8e6');
  g.paint(col('#8e8b84'), P.CONCRETE, 0.9);
  g.cyl(0, -1.5, 0, 9, 9, 1.8, 24);
  g.paint(white, P.PLAIN, 0.45, 0.1);
  // tapered tubular steel tower in sections (flanges read as thin lines)
  const top = HUB - 2.2;
  const secs = 5;
  for (let i = 0; i < secs; i++) {
    const y0 = (top * i) / secs, y1 = (top * (i + 1)) / secs;
    const r0 = 2.15 - 0.9 * (y0 / top), r1 = 2.15 - 0.9 * (y1 / top);
    g.paint(i === 0 ? col('#dfe2df') : white, P.PLAIN, 0.42, 0.1);
    g.lathe(0, 0.3, 0, [r0, y0, r1, y1 - 0.08], 24, true);
    g.paint(col('#c9ccca'), P.METAL, 0.4, 0.3);
    g.lathe(0, 0.3, 0, [r1 + 0.03, y1 - 0.08, r1 + 0.03, y1], 24, false);
  }
  // door + steps
  g.paint(col('#b9bdbb'), P.METAL, 0.4, 0.4);
  g.boxC(2.15, 0.3, 0, 0.12, 2.3, 1.0);
  g.paint(col('#7c7a74'), P.METAL, 0.5, 0.5);
  g.boxC(2.9, 0.3, 0, 1.4, 1.2, 1.6);
  return g.build();
}

/** Nacelle + generator ring + hub, local +Z = upwind (rotor side), origin at the tower top. */
export function nacelleGeo(): THREE.BufferGeometry {
  const g = new Geo();
  const white = col('#e8eae8');
  // yaw bearing
  g.paint(col('#c7cac8'), P.METAL, 0.4, 0.3);
  g.cyl(0, -0.2, 0, 1.3, 1.3, 0.6, 20);
  // rear housing (compact on a direct-drive machine)
  g.paint(white, P.PLAIN, 0.4, 0.1);
  g.box(-1.5, 0.3, -5.2, 1.5, 3.6, 0.8);
  g.paint(col('#d7dad8'), P.PLAIN, 0.4, 0.1);
  g.box(-1.2, 3.6, -4.6, 1.2, 3.9, -1.2);
  // ring generator (large diameter, short) facing +Z
  g.push(new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 2.2, 0.6));
  g.paint(white, P.PLAIN, 0.38, 0.1);
  g.cyl(0, 0, 0, 2.9, 2.9, 2.4, 32, true, true);
  g.paint(col('#c8cbc9'), P.METAL, 0.4, 0.3);
  g.lathe(0, 2.4, 0, [2.9, 0, 3.0, 0.1, 2.2, 0.35], 32, false);
  g.pop();
  // obstruction light housings
  g.paint(col('#ff2a12'), P.LAMP, 0.4, 0, F.BLINK);
  g.boxC(0.6, 3.9, -3.8, 0.35, 0.35, 0.35);
  g.boxC(-0.6, 3.9, -3.8, 0.35, 0.35, 0.35);
  return g.build();
}

/** Rotor: hub + spinner + 3 blades in the local XY plane, rotating about local Z. Origin = hub centre. */
export function rotorGeo(): THREE.BufferGeometry {
  const g = new Geo();
  const white = col('#eceeec');
  // spinner (nose cone) pointing +Z
  g.push(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  g.paint(white, P.PLAIN, 0.35, 0.1);
  g.lathe(0, -0.6, 0, [1.6, 0, 1.75, 0.8, 1.55, 2.0, 1.0, 3.0, 0.35, 3.6, 0.05, 3.75], 20, true);
  g.pop();
  // blades
  const Rb = ROTOR_R - 1.5;
  const n = 14;
  for (let b = 0; b < 3; b++) {
    const ang = (b / 3) * Math.PI * 2;
    const m = new THREE.Matrix4().makeRotationZ(ang);
    g.push(m);
    // loft elliptical sections along +Y from r=1.5 to r=50
    const ring = 8;
    const secs: Array<{ y: number; c: number; t: number; tw: number; sweep: number }> = [];
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      const y = 1.4 + s * Rb;
      const chord = s < 0.18 ? 1.8 + (3.4 - 1.8) * (s / 0.18) : 3.4 * Math.max(0, 1 - (s - 0.18) / 0.82) ** 0.85 + 0.35;
      const thick = s < 0.12 ? 1.8 * (1 - s / 0.12) + chord * 0.3 * (s / 0.12) : chord * (0.3 - 0.18 * s);
      secs.push({ y, c: chord, t: Math.max(0.08, thick), tw: 0.35 * (1 - s) + 0.05, sweep: -0.8 * s * s });
    }
    const base = g.vertexCount;
    for (let i = 0; i <= n; i++) {
      const sc = secs[i];
      const s = i / n;
      const red = s > 0.84 && s < 0.9 || s > 0.95;
      g.paint(red ? col('#c8321f') : white, P.PLAIN, 0.35, 0.05, F.NOGRIME);
      for (let k = 0; k <= ring; k++) {
        const a = (k / ring) * Math.PI * 2;
        // section in local (x = chord direction, z = thickness), twisted by tw
        const lx = Math.cos(a) * sc.c * 0.5 - sc.c * 0.12, lz = Math.sin(a) * sc.t * 0.5;
        const ct = Math.cos(sc.tw), st = Math.sin(sc.tw);
        const x = lx * ct - lz * st + sc.sweep, z = lx * st + lz * ct;
        const nx0 = Math.cos(a) / (sc.c * 0.5), nz0 = Math.sin(a) / (sc.t * 0.5);
        const nl = Math.hypot(nx0, nz0);
        const nx = (nx0 * ct - nz0 * st) / nl, nz = (nx0 * st + nz0 * ct) / nl;
        g.vert(x, sc.y, z, nx, 0, nz, a * sc.c * 0.5, sc.y);
      }
    }
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < ring; k++) {
        const a = base + i * (ring + 1) + k, b2 = a + 1, c = a + ring + 1, d = c + 1;
        g.tri(a, c, b2);
        g.tri(b2, c, d);
      }
    }
    g.pop();
  }
  return g.build();
}

export interface Turbine { x: number; z: number; y: number; phase: number; speed: number }

export class WindFarm {
  readonly group = new THREE.Group();
  towers: THREE.InstancedMesh;
  nacelles: THREE.InstancedMesh;
  rotors: THREE.InstancedMesh;
  private list: Turbine[];
  private yaw = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private angle: number[];
  private qr = new THREE.Quaternion();
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  private static readonly FWD = new THREE.Vector3(0, 0, 1);

  constructor(list: Turbine[], mat: THREE.Material) {
    this.list = list;
    this.angle = list.map((t) => t.phase);
    const n = list.length;
    this.towers = new THREE.InstancedMesh(towerGeo(), mat, n);
    this.nacelles = new THREE.InstancedMesh(nacelleGeo(), mat, n);
    this.rotors = new THREE.InstancedMesh(rotorGeo(), mat, n);
    for (const im of [this.towers, this.nacelles, this.rotors]) {
      im.castShadow = true;
      im.receiveShadow = true;
      this.group.add(im);
    }
    this.nacelles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rotors.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    list.forEach((t, i) => {
      this.m.makeTranslation(t.x, t.y, t.z);
      this.towers.setMatrixAt(i, this.m);
    });
    this.towers.instanceMatrix.needsUpdate = true;
    this.towers.computeBoundingSphere();
    this.update(0, new THREE.Vector2(3, -1), true);
    this.nacelles.computeBoundingSphere();
    this.rotors.computeBoundingSphere();
    if (this.rotors.boundingSphere) this.rotors.boundingSphere.radius += ROTOR_R;
    this.group.name = 'wind-farm';
  }

  glows(): GlowSpec[] {
    return this.list.map((t) => ({ x: t.x, y: t.y + HUB + 2.2, z: t.z, color: new THREE.Color(5, 0.22, 0.06), size: 3, blink: true, day: 0.0, phase: 0 }));
  }

  update(dt: number, wind: THREE.Vector2, force = false): void {
    const ws = wind.length();
    // rotor faces upwind: local +Z -> towards -wind
    const targetYaw = ws > 0.01 ? Math.atan2(-wind.x, -wind.y) : this.yaw;
    const dy = Math.atan2(Math.sin(targetYaw - this.yaw), Math.cos(targetYaw - this.yaw));
    this.yaw += force ? dy : dy * Math.min(1, dt * 0.2);
    // rpm: cut-in 3 m/s, rated ~ 11 m/s at ~15 rpm (hub wind ~1.6x the 10 m wind)
    const hub = ws * 1.6;
    const rpm = hub < 3 ? 0 : Math.min(15, 4 + (hub - 3) * 1.4);
    const w = (rpm / 60) * Math.PI * 2;
    this.q.setFromAxisAngle(WindFarm.UP, this.yaw);
    for (let i = 0; i < this.list.length; i++) {
      const t = this.list[i];
      this.angle[i] += w * dt * t.speed;
      this.v.set(t.x, t.y + HUB - 2.2, t.z);
      this.m.compose(this.v, this.q, this.s);
      this.nacelles.setMatrixAt(i, this.m);
      // hub centre: 3.5 m upwind of the tower axis, 2.2 m above the nacelle base
      const fx = Math.sin(this.yaw) * 4.2, fz = Math.cos(this.yaw) * 4.2;
      this.v.set(t.x + fx, t.y + HUB, t.z + fz);
      this.q2.setFromAxisAngle(WindFarm.FWD, this.angle[i]);
      this.qr.copy(this.q).multiply(this.q2);
      this.m.compose(this.v, this.qr, this.s);
      this.rotors.setMatrixAt(i, this.m);
    }
    this.nacelles.instanceMatrix.needsUpdate = true;
    this.rotors.instanceMatrix.needsUpdate = true;
  }
}
