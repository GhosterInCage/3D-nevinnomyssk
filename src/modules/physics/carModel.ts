// Procedural PBR model of the player's car (Lada Priora-like sedan): lofted body + greenhouse with a
// painted atlas (panel gaps, glass, grilles, badges), conforming lamp lenses projected onto the
// body with a BVH, wheels (tyre with tread/sidewall normal map, 5-spoke alloy, disc + caliper),
// mirrors, plates, exhaust and a soft contact shadow. Headlights are real SpotLights at night.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import type { AppContext } from '../../core/context';
import { DIM, GH, bodySection, bodyStations, cabinSection, cabinStations, curve, greenhouseBase } from './carShape';
import {
  paintBodyAtlas, uvSide, uvTop, uvFront, uvRear, REGION, HOLE_UV, tyreTextures, headlampTexture, taillampTexture, plateTexture,
  type BodyTextures,
} from './carTextures';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export const CAR_COLORS: Record<string, string> = {
  cherry: '#5e1420', silver: '#b9bdc2', white: '#e6e6e2', black: '#121315', blue: '#1d3552', green: '#2f4a3a', beige: '#b8a27c',
};

// ------------------------------------------------------------------ lofting
function loft(stations: number[], section: (z: number) => Array<[number, number]>, closedRing: boolean): THREE.BufferGeometry {
  const rings: number[][] = [];
  let rn = -1;
  for (const z of stations) {
    const half = section(z);
    const ring: number[] = [];
    // +x side (half as given), then the mirrored -x side back down
    for (const [x, y] of half) ring.push(x, y, z);
    for (let k = half.length - 2; k >= (closedRing ? 0 : 0); k--) ring.push(-half[k][0], half[k][1], z);
    if (rn < 0) rn = ring.length / 3;
    rings.push(ring);
  }
  const pos: number[] = [];
  for (const r of rings) pos.push(...r);
  const idx: number[] = [];
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < rn - 1; j++) {
      const a = i * rn + j, b = a + 1, c = a + rn, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Make faces point outwards (probe: a triangle on the +x flank must face +x). */
function orientOutwards(g: THREE.BufferGeometry): void {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const idx = g.getIndex()!;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  let score = 0;
  for (let t = 0; t < idx.count; t += 3) {
    a.fromBufferAttribute(p, idx.getX(t)); b.fromBufferAttribute(p, idx.getX(t + 1)); c.fromBufferAttribute(p, idx.getX(t + 2));
    n.subVectors(b, a).cross(c.sub(a));
    const cx = (a.x + b.x) / 2;
    if (Math.abs(cx) > 0.5) score += Math.sign(cx) * n.x;
  }
  if (score < 0) {
    const arr = idx.array as Uint32Array | Uint16Array;
    for (let t = 0; t < arr.length; t += 3) { const s = arr[t + 1]; arr[t + 1] = arr[t + 2]; arr[t + 2] = s; }
    idx.needsUpdate = true;
    g.computeVertexNormals();
  }
}

/**
 * De-index and give every triangle an atlas UV by its dominant facing. With `cabinHole`, the
 * upward faces of the lower body inside the greenhouse footprint (the lid of the lofted tube at
 * belt height) map to the always-transparent HOLE_UV texel, opening the cabin to the interior.
 */
function projectUVs(gIn: THREE.BufferGeometry, cabinHole = false): THREE.BufferGeometry {
  const g = gIn.toNonIndexed();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = new Float32Array(p.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < p.count; t += 3) {
    a.fromBufferAttribute(p, t); b.fromBufferAttribute(p, t + 1); c.fromBufferAttribute(p, t + 2);
    n.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const ax = Math.abs(n.x), ay = n.y, az = Math.abs(n.z);
    let hole = false;
    if (cabinHole && n.y > 0.3) {
      const zc = (a.z + b.z + c.z) / 3;
      if (zc > GH.zRB + 0.01 && zc < GH.zWS - 0.01) {
        const lim = greenhouseBase(zc) + 0.005;
        hole = Math.max(Math.abs(a.x), Math.abs(b.x), Math.abs(c.x)) < lim;
      }
    }
    for (let k = 0; k < 3; k++) {
      const v = k === 0 ? a : k === 1 ? b : c;
      let u: [number, number];
      if (hole) u = HOLE_UV;
      else if (n.y < -0.55) u = [0.5, REGION.under.v0 + 0.01];
      else if (ax >= ay && ax >= az) u = uvSide(v.z, v.y);
      else if (ay >= az) u = uvTop(v.z, v.x);
      else if (n.z > 0) u = uvFront(v.x, v.y);
      else u = uvRear(v.x, v.y);
      uv[(t + k) * 2] = u[0];
      uv[(t + k) * 2 + 1] = u[1];
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// ------------------------------------------------------------------ conforming patches
type Plane = 'front' | 'rear' | 'top';

class Projector {
  private bvh: MeshBVH;
  private ray = new THREE.Ray();
  constructor(geo: THREE.BufferGeometry) {
    this.bvh = new MeshBVH(geo);
  }
  /** Surface point + normal hit by a ray cast along the plane's axis at 2D coords (a, b). */
  hit(plane: Plane, a: number, b: number): { p: THREE.Vector3; n: THREE.Vector3 } | null {
    const r = this.ray;
    if (plane === 'front') r.set(new THREE.Vector3(a, b, 4), new THREE.Vector3(0, 0, -1));
    else if (plane === 'rear') r.set(new THREE.Vector3(a, b, -4), new THREE.Vector3(0, 0, 1));
    else r.set(new THREE.Vector3(a, 4, b), new THREE.Vector3(0, -1, 0));
    const h = this.bvh.raycastFirst(r, THREE.DoubleSide);
    if (!h || !h.face) return null;
    return { p: h.point.clone(), n: h.face.normal.clone() };
  }

  /**
   * A lens-like patch that hugs the body: grid between lower(u) and upper(u) curves over [u0, u1],
   * lifted by `lift` plus a convex bulge. UVs: u along, v across (0..1).
   */
  patch(plane: Plane, u0: number, u1: number, lower: (u: number) => number, upper: (u: number) => number, nu: number, nv: number, lift: number, bulge: number, mirror = false): THREE.BufferGeometry | null {
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    let last: { p: THREE.Vector3; n: THREE.Vector3 } | null = null;
    for (let i = 0; i <= nu; i++) {
      const s = i / nu;
      const u = u0 + (u1 - u0) * s;
      const lo = lower(u), hi = upper(u);
      for (let j = 0; j <= nv; j++) {
        const t = j / nv;
        const w = lo + (hi - lo) * t;
        const h = this.hit(plane, mirror ? -u : u, w) ?? last;
        if (!h) return null;
        last = h;
        const off = lift + bulge * Math.sin(Math.PI * s) * Math.sin(Math.PI * t);
        pos.push(h.p.x + h.n.x * off, h.p.y + h.n.y * off, h.p.z + h.n.z * off);
        uv.push(s, t);
      }
    }
    const row = nv + 1;
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // orientation: normals should point along the ray's reverse
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    const want = plane === 'front' ? new THREE.Vector3(0, 0, 1) : plane === 'rear' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    let dot = 0;
    for (let k = 0; k < nrm.count; k++) dot += nrm.getX(k) * want.x + nrm.getY(k) * want.y + nrm.getZ(k) * want.z;
    if (dot < 0) {
      for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
      g.setIndex(idx);
      g.computeVertexNormals();
    }
    return g;
  }
}

// ------------------------------------------------------------------ wheels
interface WheelGeos {
  tyre: THREE.BufferGeometry; barrel: THREE.BufferGeometry; face: THREE.BufferGeometry; hub: THREE.BufferGeometry;
  nut: THREE.BufferGeometry; disc: THREE.BufferGeometry; caliper: THREE.BufferGeometry;
}

function wheelGeometries(): WheelGeos {
  const R = DIM.tyreR, Rr = DIM.rimR, hw = DIM.tyreW / 2;
  // tyre profile: (radius, axial) from the inner bead around the tread to the outer bead
  const prof: Array<[number, number]> = [
    [Rr + 0.004, -hw * 0.86], [Rr + 0.02, -hw * 0.95], [Rr + 0.06, -hw * 1.0], [0.25, -hw * 1.02], [0.274, -hw * 0.98],
    [0.288, -hw * 0.9], [0.295, -hw * 0.78], [R, -hw * 0.6], [R, 0], [R, hw * 0.6], [0.295, hw * 0.78],
    [0.288, hw * 0.9], [0.274, hw * 0.98], [0.25, hw * 1.02], [Rr + 0.06, hw * 1.0], [Rr + 0.02, hw * 0.95], [Rr + 0.004, hw * 0.86],
  ];
  // lathe spins around +y; our wheel axle is +x (outer face at +x)
  const tyre = new THREE.LatheGeometry(prof.map(([r, a]) => new THREE.Vector2(r, a)), 56);
  // LatheGeometry's v runs along the profile; remap so the tread (middle) sits at v 0.3..0.7
  const uvA = tyre.getAttribute('uv') as THREE.BufferAttribute;
  const nP = prof.length;
  const vMap = [0.0, 0.05, 0.1, 0.16, 0.22, 0.26, 0.29, 0.31, 0.5, 0.69, 0.71, 0.74, 0.78, 0.84, 0.9, 0.95, 1.0];
  for (let k = 0; k < uvA.count; k++) {
    const pi = k % nP;
    uvA.setY(k, vMap[pi]);
    uvA.setX(k, uvA.getX(k) * 1.0);
  }
  tyre.rotateZ(-Math.PI / 2);
  // rim barrel (visible through the spokes)
  const barrelProf = [new THREE.Vector2(Rr - 0.004, -hw * 0.85), new THREE.Vector2(Rr - 0.018, -hw * 0.7), new THREE.Vector2(Rr - 0.022, hw * 0.55), new THREE.Vector2(Rr - 0.006, hw * 0.78), new THREE.Vector2(Rr + 0.004, hw * 0.86)];
  const barrel = new THREE.LatheGeometry(barrelProf, 40);
  barrel.rotateZ(-Math.PI / 2);
  // 5-spoke face: disc with 5 rounded windows, extruded
  const faceShape = new THREE.Shape();
  faceShape.absarc(0, 0, Rr - 0.006, 0, Math.PI * 2, false);
  const spokes = 5;
  for (let k = 0; k < spokes; k++) {
    const a0 = (k / spokes) * Math.PI * 2 + 0.2, a1 = ((k + 1) / spokes) * Math.PI * 2 - 0.2;
    const ri = 0.07, ro = Rr - 0.03;
    const hole = new THREE.Path();
    const n = 10;
    for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; const pt = [Math.cos(a) * ro, Math.sin(a) * ro]; if (i === 0) hole.moveTo(pt[0], pt[1]); else hole.lineTo(pt[0], pt[1]); }
    const am = (a0 + a1) / 2;
    for (let i = 0; i <= 6; i++) {
      const a = a1 - ((a1 - a0) * 0.7 * i) / 6 - (a1 - a0) * 0.15;
      const rr = ri + (ro - ri) * 0.08 * Math.sin((Math.PI * i) / 6);
      hole.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    void am;
    hole.closePath();
    faceShape.holes.push(hole);
  }
  const face = new THREE.ExtrudeGeometry(faceShape, { depth: 0.016, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, bevelSegments: 2, curveSegments: 40 });
  face.rotateY(Math.PI / 2);   // extrusion (+z) -> +x
  face.translate(hw * 0.35, 0, 0);
  const hub = new THREE.CylinderGeometry(0.052, 0.058, 0.03, 24);
  hub.rotateZ(-Math.PI / 2);
  hub.translate(hw * 0.52, 0, 0);
  const nut = new THREE.CylinderGeometry(0.009, 0.009, 0.02, 6);
  nut.rotateZ(-Math.PI / 2);
  const disc = new THREE.CylinderGeometry(0.13, 0.13, 0.018, 32);
  disc.rotateZ(-Math.PI / 2);
  disc.translate(-0.01, 0, 0);
  const caliper = new THREE.BoxGeometry(0.05, 0.1, 0.07);
  caliper.translate(0.01, 0.08, -0.07);
  return { tyre, barrel, face, hub, nut, disc, caliper };
}

export interface WheelVisual {
  /** positioned at the hub, yawed by steering */
  root: THREE.Group;
  /** spins about the axle */
  spin: THREE.Group;
  /** +1 for wheels on the +x side */
  side: number;
}

// ------------------------------------------------------------------ interior
/** Seats, dashboard, steering wheel, console, parcel shelf: what is seen through the glass. */
function buildInterior(parent: THREE.Object3D, reg: <T extends THREE.Material>(m: T) => T): THREE.Object3D {
  const fabric = reg(new THREE.MeshStandardMaterial({ name: 'car-seat', color: 0x2c2d31, roughness: 0.96, metalness: 0 }));
  const dash = reg(new THREE.MeshStandardMaterial({ name: 'car-dash', color: 0x19191b, roughness: 0.7, metalness: 0 }));
  const carpet = reg(new THREE.MeshStandardMaterial({ name: 'car-carpet', color: 0x121213, roughness: 1, metalness: 0 }));
  const trimSilver = reg(new THREE.MeshStandardMaterial({ name: 'car-trim-silver', color: 0x8d9094, roughness: 0.35, metalness: 0.9 }));
  const g = new THREE.Group();
  g.name = 'car-interior';
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rx = 0, cast = true) => {
    const me = new THREE.Mesh(geo, m);
    me.position.set(x, y, z);
    me.rotation.x = rx;
    me.castShadow = cast; me.receiveShadow = true;
    g.add(me);
    return me;
  };
  add(new THREE.BoxGeometry(1.44, 0.04, 2.3), carpet, 0, 0.3, -0.33, 0, false);
  // front seats (driver on the +x / left side)
  const cushion = new RoundedBoxGeometry(0.5, 0.14, 0.52, 2, 0.05);
  const back = new RoundedBoxGeometry(0.5, 0.66, 0.13, 2, 0.05);
  const headrest = new RoundedBoxGeometry(0.26, 0.19, 0.1, 2, 0.04);
  for (const x of [0.36, -0.36]) {
    add(cushion, fabric, x, 0.45, 0.02, 0.08);
    add(back, fabric, x, 0.8, -0.3, -0.28);
    add(headrest, fabric, x, 1.2, -0.43, -0.2);
    add(new THREE.CylinderGeometry(0.008, 0.008, 0.1, 6), trimSilver, x + 0.07, 1.09, -0.41, -0.2, false);
    add(new THREE.CylinderGeometry(0.008, 0.008, 0.1, 6), trimSilver, x - 0.07, 1.09, -0.41, -0.2, false);
  }
  // rear bench + parcel shelf
  add(new RoundedBoxGeometry(1.28, 0.14, 0.5, 2, 0.05), fabric, 0, 0.47, -0.88, 0.06);
  add(new RoundedBoxGeometry(1.3, 0.56, 0.13, 2, 0.05), fabric, 0, 0.78, -1.16, -0.32);
  add(new THREE.BoxGeometry(1.4, 0.025, 0.3), dash, 0, 0.995, -1.41, 0, false);
  // dashboard, instrument binnacle, centre stack + console, gear lever
  add(new RoundedBoxGeometry(1.46, 0.42, 0.36, 2, 0.06), dash, 0, 0.76, 0.58, 0.1);
  add(new RoundedBoxGeometry(0.36, 0.07, 0.17, 2, 0.03), dash, 0.36, 0.985, 0.47, 0.25);
  add(new RoundedBoxGeometry(0.24, 0.3, 0.12, 2, 0.03), dash, 0, 0.72, 0.42, 0.25);
  add(new THREE.BoxGeometry(0.2, 0.2, 0.52), dash, 0, 0.42, 0.14);
  add(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 8), dash, 0, 0.6, 0.28, -0.25, false);
  add(new THREE.SphereGeometry(0.03, 12, 8), trimSilver, 0, 0.68, 0.26, 0, false);
  // steering wheel (rim, hub, three spokes) on a column
  const wheel = new THREE.Group();
  wheel.position.set(0.36, 0.9, 0.36);
  wheel.rotation.x = 0.43;
  const spin = new THREE.Group();
  wheel.add(spin);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.017, 8, 36), dash);
  rim.castShadow = true;
  spin.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.06, 18).rotateX(Math.PI / 2), dash);
  spin.add(hub);
  const badge = new THREE.Mesh(new THREE.CircleGeometry(0.014, 16), dash);
  badge.position.z = -0.031;
  badge.rotation.y = Math.PI;
  spin.add(badge);
  for (const a of [0, Math.PI * 0.62, -Math.PI * 0.62]) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.14, 0.018), dash);
    sp.position.set(Math.sin(a) * 0.1, -Math.cos(a) * 0.1, 0);
    sp.rotation.z = a;
    spin.add(sp);
  }
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.26, 10).rotateX(Math.PI / 2), dash);
  col.position.z = 0.14;
  wheel.add(col);
  g.add(wheel);
  // instrument faces (speedometer + tachometer) under the binnacle
  const gauge = reg(new THREE.MeshStandardMaterial({ name: 'car-gauges', color: 0x0b0c0e, roughness: 0.3, metalness: 0, emissive: new THREE.Color(0.55, 0.75, 1.0), emissiveIntensity: 0 }));
  for (const gx of [0.29, 0.43]) {
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.052, 24), gauge);
    face.position.set(gx, 0.945, 0.43);
    face.rotation.set(-0.25, Math.PI, 0);
    g.add(face);
  }
  g.userData.gauge = gauge;
  // rear-view mirror
  add(new RoundedBoxGeometry(0.24, 0.065, 0.03, 2, 0.012), dash, 0, 1.3, 0.1, 0.1, false);
  parent.add(g);
  return spin;
}

// ------------------------------------------------------------------ the car
export interface CarModel {
  root: THREE.Group;
  body: THREE.Group;
  wheels: WheelVisual[];
  /** spins about its local z with the steering input */
  steeringWheel: THREE.Object3D;
  headSpots: THREE.SpotLight[];
  shadow: THREE.Mesh;
  setLights(night: number, brake: number, reverse: boolean, lowBeamOn: boolean): void;
  setColor(hex: string): void;
  dispose(): void;
}

export function buildCarModel(ctx: AppContext, color = CAR_COLORS.cherry): CarModel {
  const t0 = performance.now();
  const reg = <T extends THREE.Material>(m: T) => ctx.registerMaterial(m);
  const root = new THREE.Group();
  root.name = 'physics-car';
  const body = new THREE.Group();
  root.add(body);

  // body + greenhouse geometry
  const lower = loft(bodyStations(), bodySection, true);
  orientOutwards(lower);
  const cabin = loft(cabinStations(), cabinSection, false);
  orientOutwards(cabin);
  const lowerUV = projectUVs(lower, true);
  const cabinUV = projectUVs(cabin);
  const bodyGeo = mergeGeometries([lowerUV, cabinUV])!;
  bodyGeo.computeBoundingSphere();
  let tex: BodyTextures = paintBodyAtlas(color);
  // painted shell; glass areas of the atlas are cut out (alphaTest) and drawn by the glass shell
  const paint = reg(new THREE.MeshPhysicalMaterial({
    name: 'car-paint',
    map: tex.map, roughnessMap: tex.orm, metalnessMap: tex.orm, clearcoatMap: tex.orm, normalMap: tex.normal,
    alphaMap: tex.cut, alphaTest: 0.5,
    normalScale: new THREE.Vector2(0.8, 0.8),
    roughness: 1, metalness: 1, clearcoat: 1, clearcoatRoughness: 0.035, envMapIntensity: 1.1,
  }));
  const bodyMesh = new THREE.Mesh(bodyGeo, paint);
  bodyMesh.name = 'car-body';
  bodyMesh.castShadow = bodyMesh.receiveShadow = true;
  body.add(bodyMesh);
  // inside of the shell (door cards, footwells, headliner), seen through the windows
  const innerLower = reg(new THREE.MeshStandardMaterial({ name: 'car-trim-inner', color: 0x1d1e21, roughness: 0.85, metalness: 0, side: THREE.BackSide, alphaMap: tex.cut, alphaTest: 0.5 }));
  const headliner = reg(new THREE.MeshStandardMaterial({ name: 'car-headliner', color: 0x68645e, roughness: 0.95, metalness: 0, side: THREE.BackSide, alphaMap: tex.cut, alphaTest: 0.5 }));
  for (const [g, m, nm] of [[lowerUV, innerLower, 'car-inner-lower'], [cabinUV, headliner, 'car-headliner']] as Array<[THREE.BufferGeometry, THREE.Material, string]>) {
    const me = new THREE.Mesh(g, m);
    me.name = nm;
    me.receiveShadow = true;
    body.add(me);
  }
  // glass: the greenhouse again, only where the atlas says glass; tinted, reflective, see-through
  const glassMat = reg(new THREE.MeshPhysicalMaterial({
    name: 'car-glass', color: 0x0d1417, roughness: 0.02, metalness: 0, ior: 1.52, specularIntensity: 1,
    transparent: true, opacity: 0.45, alphaMap: tex.glass, alphaTest: 0.02, depthWrite: false, envMapIntensity: 1.3,
  }));
  // Physically blended glass: transmitted = background x (1 - a), reflected = the full (Fresnel
  // weighted) specular, i.e. the reflection is not scaled down by the blending alpha.
  glassMat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
      {
        float nvG = clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0);
        float frG = 0.04 + 0.96 * pow(1.0 - nvG, 5.0);
        float aG = clamp(diffuseColor.a + (1.0 - diffuseColor.a) * frG, 0.05, 0.98);
        gl_FragColor = vec4(totalDiffuse * diffuseColor.a / aG + totalEmissiveRadiance + totalSpecular / aG, aG);
      }`);
  };
  glassMat.customProgramCacheKey = () => 'car-glass-fresnel';
  const glassMesh = new THREE.Mesh(cabinUV, glassMat);
  glassMesh.name = 'car-glass';
  glassMesh.renderOrder = 2;
  glassMesh.userData.ptMaterial = new THREE.MeshPhysicalMaterial({ name: 'car-glass-pt', color: 0xd9e3e0, roughness: 0, metalness: 0, transmission: 1, thickness: 0.004, ior: 1.52, alphaMap: tex.glass, alphaTest: 0.5 });
  body.add(glassMesh);
  const steeringWheel = buildInterior(body, reg);
  const gaugeMat = (body.getObjectByName('car-interior')?.userData.gauge ?? null) as THREE.MeshStandardMaterial | null;

  const proj = new Projector(bodyGeo);

  // ---------------------------------------------------------------- lamps
  const head = headlampTexture();
  const headMat = reg(new THREE.MeshPhysicalMaterial({
    name: 'car-headlamp', map: head.map, emissiveMap: head.emissive, emissive: new THREE.Color(1, 0.96, 0.88), emissiveIntensity: 0,
    metalness: 0.85, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.02,
  }));
  const tail = taillampTexture();
  const tailMat = reg(new THREE.MeshPhysicalMaterial({
    name: 'car-taillamp', map: tail.map, emissiveMap: tail.emissive, emissive: new THREE.Color(1, 0.08, 0.05), emissiveIntensity: 0,
    metalness: 0.1, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02,
  }));
  const revMat = reg(new THREE.MeshPhysicalMaterial({
    name: 'car-reverse', color: 0xdddddd, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0,
    metalness: 0.2, roughness: 0.15, clearcoat: 1, transparent: true, opacity: 0.0, depthWrite: false,
  }));
  const hlLower = curve([[0.30, 0.65], [0.5, 0.636], [0.7, 0.646], [0.8, 0.672]]);
  const hlUpper = curve([[0.30, 0.741], [0.5, 0.765], [0.7, 0.77], [0.8, 0.752]]);
  const tlLower = curve([[0.385, 0.806], [0.6, 0.787], [0.8, 0.80]]);
  const tlUpper = curve([[0.385, 0.94], [0.6, 0.962], [0.8, 0.952]]);
  const headGeos: THREE.BufferGeometry[] = [], tailGeos: THREE.BufferGeometry[] = [], revGeos: THREE.BufferGeometry[] = [];
  for (const mirror of [false, true]) {
    const h = proj.patch('front', 0.30, 0.80, hlLower, hlUpper, 28, 8, 0.004, 0.012, mirror);
    if (h) headGeos.push(h);
    const t = proj.patch('rear', 0.385, 0.80, tlLower, tlUpper, 24, 8, 0.004, 0.01, mirror);
    if (t) tailGeos.push(t);
    const r = proj.patch('rear', 0.385, 0.385 + 0.2 * (0.8 - 0.385), tlLower, tlUpper, 6, 6, 0.0065, 0.01, mirror);
    if (r) revGeos.push(r);
  }
  const addMerged = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, shadow = true) => {
    if (!geos.length) return null;
    const m = new THREE.Mesh(mergeGeometries(geos)!, mat);
    m.name = name;
    m.castShadow = shadow; m.receiveShadow = true;
    body.add(m);
    return m;
  };
  addMerged(headGeos, headMat, 'car-headlamps');
  addMerged(tailGeos, tailMat, 'car-taillamps');
  const revMesh = addMerged(revGeos, revMat, 'car-reverse', false);
  if (revMesh) revMesh.renderOrder = 1;

  // ---------------------------------------------------------------- plates
  const plateGeo = new THREE.BoxGeometry(0.52, 0.112, 0.008);
  const plateMat = reg(new THREE.MeshStandardMaterial({ name: 'car-plate', map: plateTexture(), roughness: 0.45, metalness: 0.3 }));
  const plateEdge = reg(new THREE.MeshStandardMaterial({ name: 'car-plate-edge', color: 0x999999, roughness: 0.4, metalness: 0.8 }));
  const plateMats = [plateEdge, plateEdge, plateEdge, plateEdge, plateMat, plateEdge];
  for (const [plane, y] of [['front', 0.53], ['rear', 0.59]] as Array<[Plane, number]>) {
    const h = proj.hit(plane, 0, y);
    if (!h) continue;
    const m = new THREE.Mesh(plateGeo, plateMats);
    m.position.copy(h.p).addScaledVector(h.n, 0.012);
    m.lookAt(m.position.clone().add(h.n));
    m.castShadow = true;
    m.name = `car-plate-${plane}`;
    body.add(m);
  }

  // ---------------------------------------------------------------- mirrors, exhaust
  const plastic = reg(new THREE.MeshStandardMaterial({ name: 'car-plastic', color: 0x151618, roughness: 0.55, metalness: 0.05 }));
  const mirrorGlass = reg(new THREE.MeshStandardMaterial({ name: 'car-mirror', color: 0x6d747b, roughness: 0.04, metalness: 1.0 }));
  const housingGeo = new THREE.SphereGeometry(1, 20, 12);
  housingGeo.scale(0.1, 0.066, 0.075);
  const glassGeo = new THREE.CircleGeometry(1, 24);
  glassGeo.scale(0.086, 0.055, 1);
  for (const s of [-1, 1]) {
    const hsg = new THREE.Mesh(housingGeo, paint);
    // paint the housing with the body colour: a tiny UV patch of plain paint on the atlas side region
    hsg.position.set(s * 0.93, 1.005, 0.6);
    hsg.rotation.y = s * -0.12;
    hsg.castShadow = true;
    body.add(hsg);
    const gl = new THREE.Mesh(glassGeo, mirrorGlass);
    gl.position.set(s * 0.935, 1.005, 0.6 - 0.074);
    gl.rotation.y = Math.PI + s * -0.12;
    body.add(gl);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.06), plastic);
    arm.position.set(s * 0.86, 0.985, 0.63);
    body.add(arm);
  }
  // mirror housings use atlas UVs from the sphere: point them all at a plain-paint texel
  {
    const uv = housingGeo.getAttribute('uv') as THREE.BufferAttribute;
    const [pu, pv] = uvSide(-1.7, 0.55);
    for (let k = 0; k < uv.count; k++) uv.setXY(k, pu, pv);
  }
  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.028, 0.22, 14, 1, true), reg(new THREE.MeshStandardMaterial({ name: 'car-exhaust', color: 0x3a3632, roughness: 0.5, metalness: 0.9, side: THREE.DoubleSide })));
  exhaust.rotation.x = Math.PI / 2;
  exhaust.position.set(-0.42, 0.25, -2.07);
  body.add(exhaust);
  // dark cabin floor/underbody plate so the car never looks hollow from low angles
  const under = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.04, 3.9), reg(new THREE.MeshStandardMaterial({ name: 'car-under', color: 0x0c0c0c, roughness: 0.95 })));
  under.position.set(0, 0.23, 0.0);
  body.add(under);

  // ---------------------------------------------------------------- wheels
  const wg = wheelGeometries();
  const tt = tyreTextures();
  const tyreMat = reg(new THREE.MeshStandardMaterial({ name: 'car-tyre', map: tt.map, normalMap: tt.normal, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.88, metalness: 0 }));
  tt.map.repeat.set(1, 1); tt.normal.repeat.set(1, 1);
  const rimMat = reg(new THREE.MeshPhysicalMaterial({ name: 'car-rim', color: 0xc9ccd0, roughness: 0.28, metalness: 1, clearcoat: 0.6, clearcoatRoughness: 0.1 }));
  const rimInner = reg(new THREE.MeshStandardMaterial({ name: 'car-rim-inner', color: 0x8c8f93, roughness: 0.45, metalness: 1, side: THREE.DoubleSide }));
  const discMat = reg(new THREE.MeshStandardMaterial({ name: 'car-disc', color: 0x5d5a57, roughness: 0.35, metalness: 0.95 }));
  const caliperMat = reg(new THREE.MeshStandardMaterial({ name: 'car-caliper', color: 0x2c2d2f, roughness: 0.6, metalness: 0.5 }));
  const hubMat = reg(new THREE.MeshStandardMaterial({ name: 'car-hub', color: 0x2a2c30, roughness: 0.35, metalness: 0.7 }));
  const wheels: WheelVisual[] = [];
  const wheelPos: Array<[number, number]> = [[DIM.trackF / 2, DIM.frontAxle], [-DIM.trackF / 2, DIM.frontAxle], [DIM.trackR / 2, DIM.rearAxle], [-DIM.trackR / 2, DIM.rearAxle]];
  for (const [x, z] of wheelPos) {
    const side = x > 0 ? 1 : -1;
    const w = new THREE.Group();
    w.position.set(x, DIM.tyreR, z);
    const mount = new THREE.Group();
    if (side < 0) mount.rotation.y = Math.PI;
    w.add(mount);
    const spin = new THREE.Group();
    mount.add(spin);
    const add = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, cast = true) => {
      const me = new THREE.Mesh(g, m);
      me.castShadow = cast; me.receiveShadow = true;
      parent.add(me);
      return me;
    };
    add(wg.tyre, tyreMat, spin);
    add(wg.barrel, rimInner, spin, false);
    add(wg.face, rimMat, spin);
    add(wg.hub, hubMat, spin, false);
    add(wg.disc, discMat, spin, false);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const n = add(wg.nut, hubMat, spin, false);
      n.position.set(DIM.tyreW / 2 * 0.5, Math.cos(a) * 0.049, Math.sin(a) * 0.049);
    }
    add(wg.caliper, caliperMat, mount, false).position.x = 0.0;
    root.add(w);
    wheels.push({ root: w, spin, side });
  }

  // ---------------------------------------------------------------- contact shadow
  const sc = document.createElement('canvas');
  sc.width = 64; sc.height = 128;
  const sg = sc.getContext('2d')!;
  const img = sg.createImageData(64, 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 64; x++) {
    const u = (x + 0.5) / 64 * 2 - 1, v = (y + 0.5) / 128 * 2 - 1;
    const d = Math.pow(Math.pow(Math.abs(u), 4) + Math.pow(Math.abs(v), 4), 0.25);
    const a = Math.max(0, 1 - d) ** 1.4;
    img.data[(y * 64 + x) * 4 + 3] = Math.round(a * 255);
  }
  sg.putImageData(img, 0, 0);
  const st = new THREE.CanvasTexture(sc);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.1, 4.9).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x000000, map: st, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
  );
  shadow.name = 'car-contact-shadow';
  shadow.userData.noPathTrace = true;
  shadow.renderOrder = 1;

  // ---------------------------------------------------------------- headlight spots
  const headSpots: THREE.SpotLight[] = [];
  for (const s of [-1, 1]) {
    const sl = new THREE.SpotLight(0xfff1dc, 0, 70, 0.52, 0.55, 1.6);
    sl.position.set(s * 0.55, 0.7, 2.05);
    sl.target.position.set(s * 0.35, -0.6, 22);
    sl.castShadow = ctx.settings.quality === 'ultra';
    if (sl.castShadow) { sl.shadow.mapSize.set(512, 512); sl.shadow.bias = -0.0005; sl.shadow.camera.near = 0.5; }
    sl.userData.noPathTrace = true;
    root.add(sl, sl.target);
    headSpots.push(sl);
  }

  const model: CarModel = {
    root, body, wheels, headSpots, shadow, steeringWheel,
    setLights(night: number, brake: number, reverse: boolean, lowBeamOn: boolean) {
      const on = lowBeamOn ? 1 : 0;
      if (gaugeMat) gaugeMat.emissiveIntensity = on ? 0.02 + 0.05 * night : 0;
      headMat.emissiveIntensity = on * (1.5 + 12 * night);
      for (const s of headSpots) s.intensity = on * night * 260;
      tailMat.emissiveIntensity = (on * (0.25 + 0.55 * night)) + brake * (2.2 + 2.5 * night);
      revMat.emissiveIntensity = reverse ? 3 + 10 * night : 0;
      revMat.opacity = reverse ? 0.95 : 0.0;
    },
    setColor(hex: string) {
      const old = tex;
      tex = paintBodyAtlas(hex);
      paint.map = tex.map; paint.roughnessMap = tex.orm; paint.metalnessMap = tex.orm; paint.clearcoatMap = tex.orm; paint.normalMap = tex.normal;
      paint.alphaMap = tex.cut; innerLower.alphaMap = tex.cut; headliner.alphaMap = tex.cut;
      glassMat.alphaMap = tex.glass;
      (glassMesh.userData.ptMaterial as THREE.MeshPhysicalMaterial).alphaMap = tex.glass;
      paint.needsUpdate = true;
      old.map.dispose(); old.orm.dispose(); old.normal.dispose(); old.cut.dispose(); old.glass.dispose();
    },
    dispose() {
      root.traverse((o: any) => { if (o.isMesh) o.geometry?.dispose?.(); });
      shadow.geometry.dispose();
    },
  };
  console.info(`[physics] car model built in ${Math.round(performance.now() - t0)} ms (${(bodyGeo.getAttribute('position').count / 3) | 0} body tris)`);
  return model;
}
