// Trees for the path tracer. The vegetation module draws near trees as
// InstancedMesh LODs rebuilt around the camera and everything else as
// impostors (not path-traceable). Here we read its instance data directly
// (feature-detected, optional) and choose our own LODs for the frozen view:
//   LOD0 meshes (full branches + leaf cards) near the camera,
//   LOD1 meshes further out,
//   a lumpy low-poly crown + trunk proxy for distant trees,
// nearest first within a triangle budget.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import type { PTSrcGeo } from '../../workers/pathtracer-build.worker';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { canonGeometry, nextFrame, type Candidate, type Gatherer } from './gather';

export interface TreeParams {
  radius: number;
  lod0: number;
  lod1: number;
  budget: number;
  sliceMs: number;
}

interface Pick { k: number; d: number; sp: any; lod: 0 | 1 | 2 }

function hash(i: number): number {
  let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Lumpy unit crown (radius 1 around the origin) + a trunk, as two geometries. */
function crownGeometry(seed: number): THREE.BufferGeometry {
  const src = new THREE.IcosahedronGeometry(1, 1);
  src.deleteAttribute('uv');
  src.deleteAttribute('normal');
  const g = mergeVertices(src);
  src.dispose();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // lumpy clumps, flatter underside
    const n = 0.8 + 0.32 * hash(Math.round((x * 7 + y * 13 + z * 17 + seed * 31) * 100));
    p.setXYZ(i, x * n, y * n * (y < 0 ? 0.8 : 1), z * n);
  }
  g.computeVertexNormals();
  return g;
}

export class TreeCollector {
  readonly excluded: THREE.Object3D | null;
  private crowns: THREE.BufferGeometry[] = [];
  private trunk = new THREE.CylinderGeometry(0.5, 0.6, 1, 6, 1, true).translate(0, 0.5, 0);
  private leafMats = new Map<number, THREE.MeshPhysicalMaterial>();
  private barkMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(0.09, 0.075, 0.06), roughness: 0.95 });

  constructor(private ctx: AppContext) {
    const veg = ctx.get<any>('vegetation');
    this.excluded = veg?.forest?.group ?? null;
    for (let i = 0; i < 3; i++) this.crowns.push(crownGeometry(i));
  }

  static available(ctx: AppContext): boolean {
    const veg = ctx.get<any>('vegetation');
    const d = veg?.data, f = veg?.forest;
    return !!(d && f && typeof d.forCells === 'function' && d.x && d.cellStart && typeof f.pick === 'function' && f.ground);
  }

  private leafMaterial(def: any): THREE.MeshPhysicalMaterial {
    let m = this.leafMats.get(def.id);
    if (!m) {
      const tint = Array.isArray(def.leafTint) ? new THREE.Color(...def.leafTint) : new THREE.Color(1, 1, 1);
      // average leaf-card albedo (texture mean ~ dark green) x species tint; slightly darker for canopy self-shadowing
      const base = def.kind === 'tree' && /pine|spruce|thuja|juniper/i.test(def.name) ? new THREE.Color(0.05, 0.075, 0.04) : new THREE.Color(0.075, 0.11, 0.04);
      m = new THREE.MeshPhysicalMaterial({ color: base.multiply(tint), roughness: 0.8, side: THREE.DoubleSide, sheen: 0.3, sheenColor: new THREE.Color(0.1, 0.15, 0.05) });
      m.name = `pt:crown:${def.name}`;
      this.leafMats.set(def.id, m);
    }
    return m;
  }

  async collect(g: Gatherer, p: TreeParams, cam: THREE.Vector3, onProgress?: (f: number) => void): Promise<{ cands: Candidate[]; stats: Record<string, number> }> {
    const veg = this.ctx.get<any>('vegetation');
    const d = veg.data, forest = veg.forest;
    const R = p.radius;
    const picks: Pick[] = [];
    const center = new THREE.Vector3();
    let t0 = performance.now();
    let cellsDone = 0;
    const cells: number[] = [];
    d.forCells(cam.x - R, cam.z - R, cam.x + R, cam.z + R, (c: number) => { if (d.cellStart[c] !== d.cellStart[c + 1]) cells.push(c); });
    for (const c of cells) {
      const col = c % d.C, row = (c / d.C) | 0;
      const cx = d.origin + (col + 0.5) * d.cell, cz = d.origin + (row + 0.5) * d.cell;
      if (Math.hypot(cx - cam.x, cz - cam.z) > R + d.cell) continue;
      d.ensureHeights(c, forest.ground);
      for (let k = d.cellStart[c]; k < d.cellStart[c + 1]; k++) {
        if (d.removed[k]) continue;
        const sp = forest.pick(k);
        if (!sp || !sp.model) continue;
        const h = d.h[k];
        if (sp.def?.name && /hedge/i.test(sp.def.name)) continue; // hedges: 2 m modules, skipped (low impact)
        center.set(d.x[k], d.y[k] + h * 0.5, d.z[k]);
        const r = Math.max(h, d.w[k]) * 0.6 + 0.5;
        const dist = g.test(center, r, R);
        if (dist < 0) continue;
        const lod: 0 | 1 | 2 = dist < p.lod0 && sp.lod0 ? 0 : dist < p.lod1 ? 1 : 2;
        picks.push({ k, d: dist, sp, lod });
      }
      if (++cellsDone % 16 === 0 && performance.now() - t0 > p.sliceMs) { onProgress?.(cellsDone / cells.length); await nextFrame(); t0 = performance.now(); }
    }
    picks.sort((a, b) => a.d - b.d);

    // per-LOD triangle costs
    const partTris = (set: any): number => {
      let t = 0;
      for (const m of set?.meshes ?? []) { const ix = m.geometry.getIndex(); t += ix ? ix.count / 3 : m.geometry.getAttribute('position').count / 3; }
      return t;
    };
    const cg = this.crowns[0];
    const crownTris = (cg.getIndex() ? cg.getIndex()!.count : cg.getAttribute('position').count) / 3 + 12;
    type Group = { key: string; mesh: THREE.Mesh | null; geo: THREE.BufferGeometry; mat: THREE.MeshPhysicalMaterial; m: number[]; tris: number; d: number };
    const groups = new Map<string, Group>();
    let used = 0, n0 = 0, n1 = 0, n2 = 0;
    const tmp = new THREE.Matrix4();
    const addInst = (key: string, mesh: THREE.Mesh | null, geo: THREE.BufferGeometry, mat: THREE.MeshPhysicalMaterial | null, e: ArrayLike<number>, tris: number, dist: number) => {
      if (!mat) return;
      let gr = groups.get(key);
      if (!gr) { gr = { key, mesh, geo, mat, m: [], tris, d: dist }; groups.set(key, gr); }
      for (let i = 0; i < 16; i++) gr.m.push(e[i]);
    };
    for (const pk of picks) {
      const k = pk.k, sp = pk.sp;
      let lod = pk.lod;
      const set = lod === 0 ? sp.lod0 : sp.lod1;
      let cost = lod === 2 ? crownTris : partTris(set);
      if (used + cost > p.budget) {
        if (lod < 2 && used + crownTris <= p.budget) { lod = 2; cost = crownTris; } else break;
      }
      used += cost;
      const x = d.x[k], y = d.y[k], z = d.z[k], h = d.h[k];
      if (lod === 2) {
        // crown ellipsoid from the species model proportions
        const mdl = sp.model;
        const sY = h / mdl.height;
        const cw = Math.min(Math.max(d.w[k], h * 0.3), h * 1.2);
        const crownH = Math.max(1, (mdl.height - (mdl.centerY - (mdl.height - mdl.centerY))) * sY);
        const cy = y + Math.min(h - crownH * 0.5, Math.max(h * 0.55, mdl.centerY * sY));
        const ry = Math.max(0.8, Math.min(crownH * 0.5, h * 0.45));
        tmp.makeRotationY(d.rot[k]);
        tmp.scale(new THREE.Vector3(cw * 0.5, ry, cw * 0.5));
        tmp.setPosition(x, cy, z);
        const ci = k % this.crowns.length;
        addInst(`crown${ci}:${sp.def.id}`, null, this.crowns[ci], this.leafMaterial(sp.def), tmp.elements, crownTris - 12, pk.d);
        const trunkH = Math.max(0.5, cy - ry * 0.6 - y);
        const tr = Math.max(0.08, h * 0.018);
        tmp.makeScale(tr, trunkH, tr);
        tmp.setPosition(x, y, z);
        addInst('trunk', null, this.trunk, this.barkMat, tmp.elements, 12, pk.d);
        n2++;
      } else {
        const sY = h / sp.model.height;
        let sXZ = d.w[k] / sp.model.crown;
        sXZ = Math.min(Math.max(sXZ, sY * 0.65), sY * 1.5);
        const c = Math.cos(d.rot[k]), s = Math.sin(d.rot[k]);
        const e = [c * sXZ, 0, -s * sXZ, 0, 0, sY, 0, 0, s * sXZ, 0, c * sXZ, 0, x, y, z, 1];
        for (const mesh of set.meshes as THREE.InstancedMesh[]) {
          const mat = g.resolver.resolve(mesh, mesh.material as THREE.Material, 0, false);
          const ix = mesh.geometry.getIndex();
          addInst(`${mesh.uuid}`, mesh, mesh.geometry, mat, e, ix ? ix.count / 3 : mesh.geometry.getAttribute('position').count / 3, pk.d);
        }
        if (lod === 0) n0++; else n1++;
      }
    }
    const cands: Candidate[] = [];
    for (const gr of groups.values()) {
      const geo = gr.geo;
      const useColor = !!gr.mat.vertexColors && !!geo.getAttribute('color');
      const wantTan = !!gr.mat.normalMap;
      cands.push({
        obj: (gr.mesh ?? new THREE.Mesh(geo)) as THREE.Mesh,
        mat: gr.mat,
        geoKey: `${geo.uuid}|tree|${useColor ? 1 : 0}|${wantTan ? 1 : 0}`,
        getGeo: (): PTSrcGeo => canonGeometry(geo, null, useColor, wantTan),
        mats: Float32Array.from(gr.m), cols: null, tris: gr.tris, dist: gr.d, planarUV: false,
      });
    }
    return { cands, stats: { trees: picks.length, treeLod0: n0, treeLod1: n1, treeCrowns: n2, treeTris: used } };
  }

  dispose(): void {
    for (const c of this.crowns) c.dispose();
    this.trunk.dispose();
    for (const m of this.leafMats.values()) m.dispose();
    this.barkMat.dispose();
  }
}
