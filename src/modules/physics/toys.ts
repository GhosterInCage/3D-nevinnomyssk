// Physics toys: footballs (F) and wooden crates (G) thrown / dropped from the camera. They collide
// with the streamed world and with each other, float and drift in rivers (water service), cast
// shadows, and despawn (oldest first above a cap, after a lifetime, or when far away).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { AppContext } from '../../core/context';
import { G, groups, type PhysicsSystem, type RigidBody, type Interest } from './system';
import { heightToNormal } from './carTextures';

const BALL_R = 0.11;       // size-5 football
const BALL_M = 0.43;
const CRATE_H = 0.3;       // half size -> 0.6 m crate
const CRATE_M = 20;
const LIFETIME = 300;      // s

interface Toy {
  kind: 0 | 1; // 0 ball, 1 crate
  body: RigidBody;
  born: number;
  prevP: THREE.Vector3; curP: THREE.Vector3;
  prevQ: THREE.Quaternion; curQ: THREE.Quaternion;
}

/** Truncated-icosahedron football panels (Voronoi of the 32 face centres) as an equirect texture. */
function footballTexture(): THREE.Texture {
  const W = 512, H = 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  const phi = (1 + Math.sqrt(5)) / 2;
  const ico: number[][] = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) { ico.push([0, a, b * phi], [a, b * phi, 0], [b * phi, 0, a]); }
  const norm = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  const pent = ico.map(norm);
  // icosahedron faces -> their centres are the hexagon centres
  const hex: number[][] = [];
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) for (let k = j + 1; k < 12; k++) {
    const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const e = 2 / Math.sqrt(phi * phi + 1) + 1e-3;
    if (d(pent[i], pent[j]) < e * 1.05 && d(pent[j], pent[k]) < e * 1.05 && d(pent[i], pent[k]) < e * 1.05) {
      hex.push(norm([pent[i][0] + pent[j][0] + pent[k][0], pent[i][1] + pent[j][1] + pent[k][1], pent[i][2] + pent[j][2] + pent[k][2]]));
    }
  }
  const centres = [...pent.map((p) => ({ p, black: true })), ...hex.map((p) => ({ p, black: false }))];
  for (let y = 0; y < H; y++) {
    const th = ((y + 0.5) / H) * Math.PI;
    for (let x = 0; x < W; x++) {
      const ph = ((x + 0.5) / W) * Math.PI * 2;
      const dx = Math.sin(th) * Math.cos(ph), dy = Math.cos(th), dz = Math.sin(th) * Math.sin(ph);
      let b1 = -2, b2 = -2, black = false;
      for (const c0 of centres) {
        const d = c0.p[0] * dx + c0.p[1] * dy + c0.p[2] * dz;
        if (d > b1) { b2 = b1; b1 = d; black = c0.black; } else if (d > b2) b2 = d;
      }
      const seam = b1 - b2 < 0.012;
      let v = black ? 22 : 238;
      if (seam) v = black ? 60 : 150;
      const i = (y * W + x) * 4;
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = black ? v : v - 4; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Wooden crate: frame boards, planks with grain, a diagonal brace, nail heads. */
function crateTextures(): { map: THREE.Texture; normal: THREE.Texture; rough: THREE.Texture } {
  const N = 512;
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = N; return c; };
  const ca = mk(), ch = mk(), cr = mk();
  const a = ca.getContext('2d')!, h = ch.getContext('2d')!, r = cr.getContext('2d')!;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const plank = (x0: number, y0: number, w: number, hh: number, horiz: boolean, tone: number) => {
    const base = [150 + tone, 108 + tone * 0.8, 62 + tone * 0.5];
    a.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
    a.fillRect(x0, y0, w, hh);
    // grain streaks
    for (let k = 0; k < 60; k++) {
      const s = rnd();
      a.strokeStyle = `rgba(${70 + s * 40},${45 + s * 25},${20 + s * 15},${0.12 + rnd() * 0.25})`;
      a.lineWidth = 0.6 + rnd() * 1.6;
      a.beginPath();
      if (horiz) {
        const yy = y0 + rnd() * hh;
        a.moveTo(x0, yy);
        for (let x = x0; x <= x0 + w; x += 16) a.lineTo(x, yy + Math.sin(x * 0.02 + s * 9) * 2.2);
      } else {
        const xx = x0 + rnd() * w;
        a.moveTo(xx, y0);
        for (let y = y0; y <= y0 + hh; y += 16) a.lineTo(xx + Math.sin(y * 0.02 + s * 9) * 2.2, y);
      }
      a.stroke();
    }
    // knots
    if (rnd() < 0.6) {
      const kx = x0 + w * (0.2 + 0.6 * rnd()), ky = y0 + hh * (0.2 + 0.6 * rnd());
      const g = a.createRadialGradient(kx, ky, 1, kx, ky, 9);
      g.addColorStop(0, 'rgba(60,35,15,0.9)'); g.addColorStop(1, 'rgba(60,35,15,0)');
      a.fillStyle = g; a.beginPath(); a.ellipse(kx, ky, horiz ? 12 : 7, horiz ? 7 : 12, 0, 0, Math.PI * 2); a.fill();
    }
    // bevelled height: plank body high, gaps low
    h.fillStyle = '#d0d0d0'; h.fillRect(x0 + 2, y0 + 2, w - 4, hh - 4);
  };
  h.fillStyle = '#000'; h.fillRect(0, 0, N, N);
  a.fillStyle = '#3a2a1a'; a.fillRect(0, 0, N, N);
  // inner planks (horizontal)
  const fb = 64;
  const rows = 4;
  for (let i = 0; i < rows; i++) plank(fb, fb + (i * (N - 2 * fb)) / rows, N - 2 * fb, (N - 2 * fb) / rows, true, (rnd() - 0.5) * 30);
  // diagonal brace
  a.save(); h.save();
  a.translate(N / 2, N / 2); h.translate(N / 2, N / 2);
  a.rotate(-Math.PI / 4); h.rotate(-Math.PI / 4);
  a.translate(-N / 2, -N / 2); h.translate(-N / 2, -N / 2);
  plank(-40, N / 2 - 30, N + 80, 60, true, 10);
  h.fillStyle = '#ffffff'; h.fillRect(-40, N / 2 - 28, N + 80, 56);
  a.restore(); h.restore();
  // frame boards (raised)
  plank(0, 0, N, fb, true, 18); plank(0, N - fb, N, fb, true, 12);
  plank(0, fb, fb, N - 2 * fb, false, 22); plank(N - fb, fb, fb, N - 2 * fb, false, 8);
  h.fillStyle = '#ffffff';
  h.fillRect(3, 3, N - 6, fb - 6); h.fillRect(3, N - fb + 3, N - 6, fb - 6); h.fillRect(3, fb, fb - 6, N - 2 * fb); h.fillRect(N - fb + 3, fb, fb - 6, N - 2 * fb);
  // nails
  for (const [x, y] of [[32, 32], [N - 32, 32], [32, N - 32], [N - 32, N - 32], [N / 2, 32], [N / 2, N - 32], [32, N / 2], [N - 32, N / 2]]) {
    a.fillStyle = '#4a4a4a'; a.beginPath(); a.arc(x, y, 4, 0, Math.PI * 2); a.fill();
    h.fillStyle = '#ffffff'; h.beginPath(); h.arc(x, y, 4, 0, Math.PI * 2); h.fill();
  }
  // stencil marking
  a.fillStyle = 'rgba(25,20,15,0.55)';
  a.font = 'bold 40px sans-serif';
  a.textAlign = 'center';
  a.fillText('НЕ КАНТОВАТЬ', N / 2, N / 2 - 70);
  r.drawImage(ca, 0, 0);
  const rd = r.getImageData(0, 0, N, N);
  for (let i = 0; i < rd.data.length; i += 4) {
    const l = (rd.data[i] + rd.data[i + 1] + rd.data[i + 2]) / 3;
    const v = 255 - l * 0.35; // darker (grain, gaps) -> rougher
    rd.data[i] = rd.data[i + 1] = rd.data[i + 2] = v;
  }
  r.putImageData(rd, 0, 0);
  const map = new THREE.CanvasTexture(ca); map.colorSpace = THREE.SRGBColorSpace;
  const rough = new THREE.CanvasTexture(cr);
  const normal = heightToNormal(ch, 2.2);
  for (const t of [map, rough, normal]) { t.anisotropy = 4; t.needsUpdate = true; }
  return { map, normal, rough };
}

export class Toys {
  private toys: Toy[] = [];
  balls: THREE.InstancedMesh | null = null;
  crates: THREE.InstancedMesh | null = null;
  maxBalls = 40;
  maxCrates = 30;
  private waterSvc: any = null;
  private m4 = new THREE.Matrix4();
  private one = new THREE.Vector3(1, 1, 1);

  constructor(private sys: PhysicsSystem, private ctx: AppContext) {
    sys.onPreStep((dt) => this.preStep(dt));
    sys.onPostStep(() => this.postStep());
    sys.addInterest((out: Interest[]) => this.interest(out));
  }

  /** Meshes + procedural textures are built on the first spawn (keeps module init light). */
  private ensureMeshes(): void {
    if (this.balls && this.crates) return;
    const ctx = this.ctx;
    const ballMat = ctx.registerMaterial(new THREE.MeshPhysicalMaterial({ name: 'physics-ball', map: footballTexture(), roughness: 0.42, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.3 }));
    const ct = crateTextures();
    const crateMat = ctx.registerMaterial(new THREE.MeshStandardMaterial({ name: 'physics-crate', map: ct.map, normalMap: ct.normal, roughnessMap: ct.rough, roughness: 1, metalness: 0 }));
    this.balls = new THREE.InstancedMesh(new THREE.SphereGeometry(BALL_R, 28, 18), ballMat, this.maxBalls);
    this.crates = new THREE.InstancedMesh(new RoundedBoxGeometry(CRATE_H * 2, CRATE_H * 2, CRATE_H * 2, 2, 0.02), crateMat, this.maxCrates);
    for (const m of [this.balls, this.crates]) {
      m.count = 0;
      m.castShadow = m.receiveShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      ctx.scene.add(m);
    }
    this.balls.name = 'physics-balls';
    this.crates.name = 'physics-crates';
  }

  get count(): number { return this.toys.length; }

  /** true while any toy is simulated (keeps physics stepping in fly mode) */
  get anyAwake(): boolean {
    for (const t of this.toys) if (!t.body.isSleeping()) return true;
    return false;
  }

  private interest(out: Interest[]): void {
    const cells = new Map<string, Interest>();
    for (const t of this.toys) {
      const awake = !t.body.isSleeping();
      const p = t.curP;
      let x = p.x, z = p.z, tr = 10, sr = 0;
      if (awake) {
        const v = t.body.linvel();
        const s = Math.hypot(v.x, v.z);
        x += v.x * 0.4; z += v.z * 0.4;
        tr = 26 + s * 0.6; sr = 14 + s * 0.6;
      }
      const k = `${Math.round(x / 24)},${Math.round(z / 24)}`;
      const c = cells.get(k);
      if (!c) cells.set(k, { x, z, terrainR: tr, staticR: sr });
      else { c.terrainR = Math.max(c.terrainR, tr); c.staticR = Math.max(c.staticR, sr); }
    }
    for (const c of cells.values()) out.push(c);
  }

  private add(kind: 0 | 1, pos: THREE.Vector3, vel: THREE.Vector3, spin?: THREE.Vector3): Toy {
    const R = this.sys.R;
    this.ensureMeshes();
    // cap: remove the oldest of this kind
    const same = this.toys.filter((t) => t.kind === kind);
    if (same.length >= (kind === 0 ? this.maxBalls : this.maxCrates)) this.remove(same[0]);
    this.sys.ensureNow(pos.x, pos.z, 30, 20);
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setLinvel(vel.x, vel.y, vel.z)
      .setCcdEnabled(true)
      .setLinearDamping(kind === 0 ? 0.04 : 0.02)
      .setAngularDamping(kind === 0 ? 0.5 : 0.15);
    if (spin) desc.setAngvel({ x: spin.x, y: spin.y, z: spin.z });
    if (kind === 1) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.random() * Math.PI, 0));
      desc.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
    const body = this.sys.world.createRigidBody(desc);
    const cd = kind === 0
      ? R.ColliderDesc.ball(BALL_R).setMass(BALL_M).setRestitution(0.72).setFriction(0.6)
      : R.ColliderDesc.roundCuboid(CRATE_H - 0.02, CRATE_H - 0.02, CRATE_H - 0.02, 0.02).setMass(CRATE_M).setRestitution(0.12).setFriction(0.75);
    cd.setCollisionGroups(groups(G.TOY, G.ALL));
    const col = this.sys.world.createCollider(cd, body);
    this.sys.kinds.set(col.handle, 'toy');
    const t = body.translation(), r = body.rotation();
    const toy: Toy = {
      kind, body, born: this.sys.simTime,
      prevP: new THREE.Vector3(t.x, t.y, t.z), curP: new THREE.Vector3(t.x, t.y, t.z),
      prevQ: new THREE.Quaternion(r.x, r.y, r.z, r.w), curQ: new THREE.Quaternion(r.x, r.y, r.z, r.w),
    };
    this.toys.push(toy);
    return toy;
  }

  spawnBall(pos: THREE.Vector3, vel = new THREE.Vector3()): RigidBody {
    const spin = new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
    return this.add(0, pos, vel, spin).body;
  }

  spawnCrate(pos: THREE.Vector3, vel = new THREE.Vector3()): RigidBody {
    const spin = new THREE.Vector3((Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5);
    return this.add(1, pos, vel, spin).body;
  }

  private remove(t: Toy): void {
    const i = this.toys.indexOf(t);
    if (i >= 0) this.toys.splice(i, 1);
    const n = t.body.numColliders();
    for (let k = 0; k < n; k++) this.sys.kinds.delete(t.body.collider(k).handle);
    this.sys.world.removeRigidBody(t.body);
  }

  clear(): void {
    for (const t of [...this.toys]) this.remove(t);
  }

  private preStep(dt: number): void {
    const w = this.waterSvc ?? (this.waterSvc = this.ctx.get('water') ?? null);
    if (!w) return;
    for (const t of this.toys) {
      const b = t.body;
      if (b.isSleeping()) continue;
      const p = b.translation();
      let lvl: number | null = null;
      try { lvl = w.levelAt(p.x, p.z); } catch { lvl = null; }
      if (lvl === null) continue;
      const r = t.kind === 0 ? BALL_R : CRATE_H;
      const sub = THREE.MathUtils.clamp((lvl - (p.y - r)) / (2 * r), 0, 1);
      if (sub <= 0) continue;
      const vol = t.kind === 0 ? (4 / 3) * Math.PI * BALL_R ** 3 : (2 * CRATE_H) ** 3;
      const m = t.kind === 0 ? BALL_M : CRATE_M;
      const buoy = 1000 * 9.81 * vol * sub * dt;
      b.applyImpulse({ x: 0, y: buoy, z: 0 }, true);
      // drag towards the current
      const v = b.linvel();
      let fx = 0, fz = 0;
      try { const f = w.flowAt(p.x, p.z); if (f) { fx = f.x; fz = f.z; } } catch { /* ignore */ }
      const k = Math.min(1, 2.2 * sub * dt);
      b.applyImpulse({ x: (fx - v.x) * m * k, y: -v.y * m * k * 1.5, z: (fz - v.z) * m * k }, true);
      const av = b.angvel();
      const ka = Math.min(1, 1.5 * sub * dt);
      b.setAngvel({ x: av.x * (1 - ka), y: av.y * (1 - ka), z: av.z * (1 - ka) }, true);
    }
  }

  private postStep(): void {
    const now = this.sys.simTime;
    const cam = this.ctx.camera.position;
    let dead: Toy[] | null = null;
    for (const t of this.toys) {
      t.prevP.copy(t.curP); t.prevQ.copy(t.curQ);
      if (t.body.isSleeping()) continue;
      const p = t.body.translation(), r = t.body.rotation();
      t.curP.set(p.x, p.y, p.z);
      t.curQ.set(r.x, r.y, r.z, r.w);
      const g = this.sys.groundAt(p.x, p.z);
      if (p.y < g - 25 || now - t.born > LIFETIME || Math.hypot(p.x - cam.x, p.z - cam.z) > 1500) (dead ??= []).push(t);
      else if (p.y < g - 0.6 && t.kind === 1) {
        // sunk below the terrain surface (tile streamed late): pop it back up
        t.body.setTranslation({ x: p.x, y: g + CRATE_H + 0.05, z: p.z }, true);
      }
    }
    if (dead) for (const t of dead) this.remove(t);
    // old sleeping toys expire too
    if (this.toys.length && this.sys.steps % 120 === 0) {
      for (const t of [...this.toys]) if (now - t.born > LIFETIME) this.remove(t);
    }
  }

  /** Update instance matrices (interpolated). */
  render(alpha: number): void {
    const balls = this.balls, crates = this.crates;
    if (!balls || !crates) return;
    let nb = 0, nc = 0;
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    for (const t of this.toys) {
      p.copy(t.prevP).lerp(t.curP, alpha);
      q.copy(t.prevQ).slerp(t.curQ, alpha);
      this.m4.compose(p, q, this.one);
      if (t.kind === 0) balls.setMatrixAt(nb++, this.m4);
      else crates.setMatrixAt(nc++, this.m4);
    }
    if (balls.count !== nb || nb) { balls.count = nb; balls.instanceMatrix.needsUpdate = true; }
    if (crates.count !== nc || nc) { crates.count = nc; crates.instanceMatrix.needsUpdate = true; }
  }
}
