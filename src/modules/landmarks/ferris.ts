// Ferris wheel of the Central Park of Culture and Rest (typical Soviet ~25 m park wheel): two A-frame
// supports, rotating double rim with spokes and coloured bulbs, 18 open gondolas that stay upright
// (InstancedMesh), loading platform. It turns once in ~6 minutes; the bulbs light up at night.
import * as THREE from 'three';
import { Geo, P, col, rng } from './builder';
import { C } from './structures';

export class FerrisWheel {
  readonly group = new THREE.Group();
  readonly rotor: THREE.Mesh;
  readonly cabins: THREE.InstancedMesh;
  readonly R: number;
  readonly hubY: number;
  private angle = 0;
  private readonly n: number;
  private m = new THREE.Matrix4();
  private v = new THREE.Vector3();

  /** (x, y, z): ground point (world) of the wheel centre; rot: rotation about Y (wheel plane = local XY). */
  constructor(x: number, y: number, z: number, rot: number, H: number, mat: THREE.Material) {
    this.R = Math.max(8, H / 2 - 2.0);
    this.hubY = this.R + 3.0;
    const R = this.R, hubY = this.hubY;
    this.n = 18;
    // ------------------------------------------------------------- static: supports + platform
    const s = new Geo();
    const white = col('#e9e7e0'), blue = col('#2f64a8'), red = col('#b8322a');
    s.paint(C.concreteDark, P.CONCRETE, 0.9);
    s.box(-8, -1.2, -4.5, 8, 0.25, 4.5);
    s.paint(col('#8e8a82'), P.TILES, 0.8);
    s.box(-4.5, 0.25, -3.8, 4.5, 0.6, 3.8);
    s.paint(white, P.METAL, 0.5, 0.35);
    for (const sz of [-1, 1]) {
      for (const sx of [-1, 1]) s.beam([sx * 6.5, 0.2, sz * 3.2], [sx * 0.35, hubY + 0.4, sz * 1.9], 0.55, 0.55);
      s.beam([-4.4, hubY * 0.34, sz * 2.8], [4.4, hubY * 0.34, sz * 2.8], 0.3, 0.3);
      s.beam([-2.1, hubY * 0.68, sz * 2.3], [2.1, hubY * 0.68, sz * 2.3], 0.25, 0.25);
    }
    // axle + bearing housings
    s.paint(C.steelDark, P.METAL, 0.5, 0.5);
    s.push(new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, hubY, -2.4));
    s.cyl(0, 0, 0, 0.45, 0.45, 4.8, 14, true, true);
    s.pop();
    // ticket booth + fence
    s.paint(blue, P.PLAIN, 0.6, 0.1);
    s.box(6.2, 0.25, -5.8, 8.6, 2.6, -4.2);
    s.paint(red, P.ROOFSEAM, 0.6, 0.2);
    s.box(6.0, 2.6, -6.0, 8.8, 2.8, -4.0);
    s.paint(C.steelDark, P.METAL, 0.6, 0.3);
    s.railing([-8, 0.25, 4.5, 8, 0.25, 4.5, 8, 0.25, -4.5], 1.0, 1.6, 0.04);
    // ------------------------------------------------------------- rotor (origin = hub, wheel plane XY)
    const r = new Geo();
    const nSeg = 54;
    for (const zz of [-1.15, 1.15]) {
      // rim: outer and inner ring connected by a zig-zag truss
      for (let i = 0; i < nSeg; i++) {
        const a0 = (i / nSeg) * Math.PI * 2, a1 = ((i + 1) / nSeg) * Math.PI * 2;
        r.paint(white, P.METAL, 0.45, 0.35);
        r.beam([Math.cos(a0) * R, Math.sin(a0) * R, zz], [Math.cos(a1) * R, Math.sin(a1) * R, zz], 0.22, 0.22);
        r.beam([Math.cos(a0) * (R - 1.0), Math.sin(a0) * (R - 1.0), zz], [Math.cos(a1) * (R - 1.0), Math.sin(a1) * (R - 1.0), zz], 0.14, 0.14);
        r.beam([Math.cos(a0) * (R - 1.0), Math.sin(a0) * (R - 1.0), zz], [Math.cos(a1) * R, Math.sin(a1) * R, zz], 0.08, 0.08);
      }
      // spokes (tension rods) from the hub rings to the inner ring
      r.paint(col('#cfd2d2'), P.METAL, 0.4, 0.6);
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2;
        r.beam([Math.cos(a) * 0.8, Math.sin(a) * 0.8, zz * 0.55], [Math.cos(a) * (R - 1.0), Math.sin(a) * (R - 1.0), zz], 0.06, 0.06);
      }
      // hub ring
      r.paint(C.steelDark, P.METAL, 0.5, 0.5);
      r.push(new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0, zz * 0.55 - 0.2));
      r.cyl(0, 0, 0, 0.9, 0.9, 0.4, 16, true, true);
      r.pop();
    }
    // cross beams carrying the gondola pivots + coloured bulbs along the outer rim
    const bulbs = [col('#ff4030'), col('#ffd040'), col('#40a0ff'), col('#60ff70'), col('#ff60e0')];
    const R2 = rng(1961);
    for (let i = 0; i < this.n; i++) {
      const a = (i / this.n) * Math.PI * 2;
      r.paint(white, P.METAL, 0.45, 0.35);
      r.beam([Math.cos(a) * R, Math.sin(a) * R, -1.3], [Math.cos(a) * R, Math.sin(a) * R, 1.3], 0.18, 0.18);
    }
    for (const zz of [-1.3, 1.3]) {
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        r.paint(bulbs[Math.floor(R2() * bulbs.length)], P.LAMP, 0.4, 0, 0);
        r.boxC(Math.cos(a) * (R + 0.18), Math.sin(a) * (R + 0.18) - 0.06, zz, 0.12, 0.12, 0.12);
      }
    }
    // ------------------------------------------------------------- gondola (hangs below its pivot)
    const c = new Geo();
    c.paint(col('#f2f2f2'), P.METAL, 0.45, 0.25);
    c.box(-0.05, -0.9, -0.05, 0.05, 0, 0.05);                    // hanger
    c.box(-0.9, -2.35, -0.75, 0.9, -2.25, 0.75);                  // floor
    c.box(-0.9, -2.25, -0.75, 0.9, -1.6, -0.7);                   // side walls (open basket)
    c.box(-0.9, -2.25, 0.7, 0.9, -1.6, 0.75);
    c.box(-0.9, -2.25, -0.75, -0.85, -1.6, 0.75);
    c.box(0.85, -2.25, -0.75, 0.9, -1.6, 0.75);
    for (const [px, pz] of [[-0.85, -0.7], [0.85, -0.7], [0.85, 0.7], [-0.85, 0.7]]) c.box(px - 0.03, -1.6, pz - 0.03, px + 0.03, -0.9, pz + 0.03);
    c.lathe(0, -0.95, 0, [1.15, 0, 0.05, 0.4], 8, false);       // umbrella roof
    c.lathe(0, -0.95, 0, [0.05, 0.4, 1.15, 0], 8, false);
    // ------------------------------------------------------------- meshes
    const sm = new THREE.Mesh(s.build(), mat);
    this.rotor = new THREE.Mesh(r.build(), mat);
    this.rotor.position.set(0, hubY, 0);
    this.cabins = new THREE.InstancedMesh(c.build(), mat, this.n);
    const cols = [col('#c8352a'), col('#e0b020'), col('#2c64b0'), col('#3a9a4a')];
    for (let i = 0; i < this.n; i++) {
      const cc = cols[i % cols.length];
      this.cabins.setColorAt(i, new THREE.Color(cc[0] / 0.9, cc[1] / 0.9, cc[2] / 0.9));
    }
    for (const o of [sm, this.rotor, this.cabins]) { o.castShadow = true; o.receiveShadow = true; }
    this.cabins.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(sm, this.rotor, this.cabins);
    this.group.position.set(x, y, z);
    this.group.rotation.y = rot;
    this.group.name = 'ferris-wheel';
    this.update(0);
    this.cabins.computeBoundingSphere();
    if (this.cabins.boundingSphere) this.cabins.boundingSphere.radius += 3;
  }

  update(dt: number): void {
    this.angle += dt * ((Math.PI * 2) / 360);
    this.rotor.rotation.z = this.angle;
    for (let i = 0; i < this.n; i++) {
      const a = this.angle + (i / this.n) * Math.PI * 2;
      this.v.set(Math.cos(a) * this.R, this.hubY + Math.sin(a) * this.R, 0);
      // gentle swing
      this.m.makeRotationZ(Math.sin(this.angle * 7 + i) * 0.03).setPosition(this.v);
      this.cabins.setMatrixAt(i, this.m);
    }
    this.cabins.instanceMatrix.needsUpdate = true;
  }
}
