// Nevinnomysskaya GRES (EL5-Energo) and Nevinnomyssk Azot (EuroChem): hand-modelled
// power-station buildings, open-air boilers, flue ducts, chimneys, tanks, process units
// and pipe racks, placed from build_landmarks.py data.
import * as THREE from 'three';
import { Geo, P, F, col, mix3, rng, type RGB } from './builder';
import { C, chimney, tank, ammoniaTank, column, prillingTower, openBoiler, pipeRack, transformer, processCell, addBox, workLight, type Frame } from './structures';

export interface Part { main: Geo; detail: Geo; frame: Frame }

// ------------------------------------------------------------------------------ banded walls
type Band = [number, number, number, RGB, number]; // y0, y1, pattern, colour, flags

/** A straight wall from a to b (local x,z) split into horizontal bands (panels / glazing). */
function wall(g: Geo, ax: number, az: number, bx: number, bz: number, yb: number, bands: Band[], rough = 0.85): void {
  for (const [y0, y1, pat, c, fl] of bands) {
    g.paint(c, pat, pat === P.GLAZING ? 0.2 : rough, 0, fl);
    g.quad([ax, yb + y0, az], [bx, yb + y0, bz], [bx, yb + y1, bz], [ax, yb + y1, az], 0, y0);
  }
}

/** Rectangular hall volume in the current frame: x0..x1, z0..z1, walls by band lists, flat roof with parapet. */
function hall(g: Geo, d: Geo, x0: number, x1: number, z0: number, z1: number, yb: number, h: number,
  longBands: Band[], endBands: Band[], roof: RGB, opts: { lantern?: boolean; gableRise?: number; faces?: number } = {}): void {
  const faces = opts.faces ?? 15; // 1: -z, 2: +z, 4: -x, 8: +x
  if (faces & 1) wall(g, x1, z0, x0, z0, yb, longBands);
  if (faces & 2) wall(g, x0, z1, x1, z1, yb, longBands);
  if (faces & 4) wall(g, x0, z0, x0, z1, yb, endBands);
  if (faces & 8) wall(g, x1, z1, x1, z0, yb, endBands);
  // roof
  const rise = opts.gableRise ?? 0;
  if (rise > 0) {
    const zm = (z0 + z1) / 2;
    g.paint(roof, P.ROOFSEAM, 0.7, 0.2);
    g.quad([x1, yb + h, z0], [x0, yb + h, z0], [x0, yb + h + rise, zm], [x1, yb + h + rise, zm]);
    g.quad([x0, yb + h, z1], [x1, yb + h, z1], [x1, yb + h + rise, zm], [x0, yb + h + rise, zm]);
    g.paint(longBands[longBands.length - 1][3], P.PANEL, 0.85);
    g.tri3([x0, yb + h, z1], [x0, yb + h + rise, zm], [x0, yb + h, z0]);
    g.tri3([x1, yb + h, z0], [x1, yb + h + rise, zm], [x1, yb + h, z1]);
  } else {
    g.paint(roof, P.ASPHALT, 0.95);
    g.box(x0, yb + h - 0.2, z0, x1, yb + h, z1, 8);
    // parapet
    g.paint(mix3(longBands[longBands.length - 1][3], C.concreteDark, 0.3), P.PANEL, 0.85);
    const pt = 0.3, ph = 1.0;
    g.box(x0, yb + h, z0, x1, yb + h + ph, z0 + pt, 63 - 4);
    g.box(x0, yb + h, z1 - pt, x1, yb + h + ph, z1, 63 - 4);
    g.box(x0, yb + h, z0, x0 + pt, yb + h + ph, z1, 63 - 4);
    g.box(x1 - pt, yb + h, z0, x1, yb + h + ph, z1, 63 - 4);
  }
  if (opts.lantern) {
    const zm = (z0 + z1) / 2, lw = 3.5, lh = 2.6, y = yb + h + rise;
    wall(g, x1 - 6, zm - lw, x0 + 6, zm - lw, y - 0.5, [[0, lh, P.GLAZING, col('#4d5a57'), F.WINLIT]]);
    wall(g, x0 + 6, zm + lw, x1 - 6, zm + lw, y - 0.5, [[0, lh, P.GLAZING, col('#4d5a57'), F.WINLIT]]);
    g.paint(roof, P.ROOFSEAM, 0.7, 0.2);
    g.box(x0 + 6, y + lh - 0.5, zm - lw - 0.4, x1 - 6, y + lh - 0.2, zm + lw + 0.4, 8 | 16 | 32 | 1 | 2);
    g.box(x0 + 6, y - 0.5, zm - lw, x0 + 6.3, y + lh - 0.5, zm + lw, 1);
    g.box(x1 - 6.3, y - 0.5, zm - lw, x1 - 6, y + lh - 0.5, zm + lw, 2);
  }
  // roof vents
  const R = rng(Math.floor(x0 * 7 + z0 * 13));
  d.paint(C.steelDark, P.METAL, 0.6, 0.3);
  const n = Math.floor((x1 - x0) / 18);
  for (let i = 0; i < n; i++) {
    const vx = x0 + 8 + (i + R() * 0.5) * ((x1 - x0 - 16) / Math.max(1, n));
    const vz = z0 + 3 + R() * (z1 - z0 - 6);
    d.cyl(vx, yb + h + rise * (1 - Math.abs(vz - (z0 + z1) / 2) / ((z1 - z0) / 2)) - 0.2, vz, 0.6, 0.6, 2.2, 10);
  }
}

/** Soviet power-station main building: turbine hall, deaerator bay, boiler bay. Local +X = long axis. */
function powerHouse(g: Geo, d: Geo, L: number, W: number, side: number, y0: number, enclosedBoilers: boolean, palette: { wall: RGB; wall2: RGB; frame: RGB; roof: RGB }): void {
  // lateral coordinate s = z * side (s grows towards the boilers / chimney)
  const s0 = -W / 2;
  const zOf = (s: number) => s * side;
  const turbW = Math.min(39, W * 0.56), deaW = Math.min(12, W * 0.18);
  const zones: Array<{ a: number; b: number; h: number; kind: string }> = [
    { a: s0, b: s0 + turbW, h: 29, kind: 'turbine' },
    { a: s0 + turbW, b: s0 + turbW + deaW, h: enclosedBoilers ? 38 : 41, kind: 'dea' },
    { a: s0 + turbW + deaW, b: W / 2, h: enclosedBoilers ? 47 : 33, kind: 'boiler' },
  ];
  const x0 = -L / 2, x1 = L / 2;
  const gl = palette.frame;
  for (const zn of zones) {
    const za = Math.min(zOf(zn.a), zOf(zn.b)), zb = Math.max(zOf(zn.a), zOf(zn.b));
    let longB: Band[];
    let endB: Band[];
    if (zn.kind === 'turbine') {
      longB = [[-3, 1.2, P.PANEL, palette.wall2, 0], [1.2, 5.2, P.GLAZING, gl, F.WINLIT], [5.2, 9.0, P.PANEL, palette.wall, 0],
        [9.0, 22.0, P.GLAZING, gl, F.WINLIT], [22.0, zn.h, P.PANEL, palette.wall, 0]];
      endB = [[-3, 2, P.PANEL, palette.wall2, 0], [2, 24, P.GLAZING, gl, F.WINLIT], [24, zn.h, P.PANEL, palette.wall, 0]];
    } else if (zn.kind === 'dea') {
      longB = [[-3, 1.2, P.PANEL, palette.wall2, 0], [1.2, 4, P.GLAZING, gl, F.WINLIT], [4, 26, P.PANEL, palette.wall, 0],
        [26, 30, P.GLAZING, gl, F.WINLIT], [30, zn.h, P.PANEL, palette.wall, 0]];
      endB = longB;
    } else {
      longB = [[-3, 1.2, P.PANEL, palette.wall2, 0], [1.2, 5, P.GLAZING, gl, F.WINLIT], [5, 14, P.PANEL, palette.wall, 0],
        [14, 18, P.GLAZING, gl, F.WINLIT], [18, zn.h - 6, P.PANEL, palette.wall, 0], [zn.h - 6, zn.h - 3, P.GLAZING, gl, F.WINLIT], [zn.h - 3, zn.h, P.PANEL, palette.wall, 0]];
      endB = longB;
    }
    // long walls: only the outer ones of the whole building (inner walls hidden) + exposed upper parts
    const outerNeg = zn.a === s0, outerPos = zn.b === W / 2;
    let faces = 4 | 8;
    const negFace = side > 0 ? 1 : 2, posFace = side > 0 ? 2 : 1;
    if (outerNeg) faces |= negFace;
    if (outerPos) faces |= posFace;
    hall(g, d, x0, x1, za, zb, y0, zn.h, longB, endB, palette.roof, { lantern: zn.kind === 'turbine', gableRise: zn.kind === 'turbine' ? 1.8 : 0, faces });
    // exposed upper walls of taller zones towards lower neighbours
    const idx = zones.indexOf(zn);
    for (const nb of [zones[idx - 1], zones[idx + 1]]) {
      if (!nb || nb.h >= zn.h) continue;
      const sEdge = nb === zones[idx - 1] ? zn.a : zn.b;
      const zE = zOf(sEdge);
      const facing = (nb === zones[idx - 1] ? -1 : 1) * side; // outward normal sign in z
      const bands: Band[] = [[nb.h, zn.h - 4, P.PANEL, palette.wall, 0], [zn.h - 4, zn.h, P.GLAZING, gl, F.WINLIT]];
      if (facing > 0) wall(g, x0, zE, x1, zE, y0, bands); else wall(g, x1, zE, x0, zE, y0, bands);
    }
  }
  // vertical stair / lift towers on the ends of the turbine hall
  g.paint(palette.wall2, P.PANEL, 0.85);
  for (const x of [x0 - 4, x1 + 4]) g.boxC(x, y0 - 2, zOf(s0 + turbW + deaW / 2), 8, 44, 9);
  // roof railings on the deaerator bay
  d.paint(C.steelDark, P.METAL, 0.6, 0.4);
}

// ------------------------------------------------------------------------------ GRES
export function buildGres(data: any, fr: Frame, main: Geo, det: Geo): void {
  const M = data.main;
  const pal1 = { wall: col('#c2bfb4'), wall2: col('#9c9a92'), frame: col('#5d6b6a'), roof: col('#55595a') };
  const pal2 = { wall: col('#cbc3ae'), wall2: col('#a19a88'), frame: col('#65706a'), roof: col('#5b5d5b') };
  // ------------- main building of the 150 MW blocks + 6 open-air boilers
  {
    const cx = M.x - fr.ox, cz = M.z - fr.oz;
    const y0 = groundMax(fr, M.ring) - fr.oy + 0.3;
    main.at(cx, 0, cz, M.rot);
    det.at(cx, 0, cz, M.rot);
    powerHouse(main, det, M.len, M.wid, M.boilerSide, y0, false, pal1);
    // boilers along +s outside the building, gas ducts to the collector and the chimney
    const side = M.boilerSide;
    const nB = 6, pitch = (M.len - 20) / nB;
    const st = data.stacks[0];
    // chimney position in the building frame
    const dx = st.x - M.x, dz = st.z - M.z;
    const along = dx * Math.cos(M.rot) - dz * Math.sin(M.rot);
    const lat = (dx * Math.sin(M.rot) + dz * Math.cos(M.rot));
    const sB0 = M.wid / 2 + 3, sB1 = sB0 + 22;
    const collS = Math.min(sB1 + 7, Math.abs(lat) - st.r0 - 14);
    for (let i = 0; i < nB; i++) {
      const x = -M.len / 2 + 10 + pitch * (i + 0.5);
      openBoiler(main, det, x, y0, ((sB0 + sB1) / 2) * side, pitch - 8, 20, 50, side > 0 ? 0 : Math.PI, 1000 + i);
      // gas duct from the boiler back to the collector
      main.paint(C.steel, P.METAL, 0.6, 0.35);
      const za = sB1 * side, zb = collS * side;
      main.box(x - 2.2, y0 + 10, Math.min(za, zb), x + 2.2, y0 + 15, Math.max(za, zb));
      // smoke exhauster house
      main.paint(pal1.wall2, P.PANEL, 0.85);
      main.box(x - 5, y0, Math.min(za, zb), x + 5, y0 + 8, Math.max(za, zb) - 1);
    }
    // collector duct along the row and the connection to the chimney
    main.paint(C.steel, P.METAL, 0.6, 0.35);
    const xa = -M.len / 2 + 10 + pitch * 0.5 - 3, xb = -M.len / 2 + 10 + pitch * (nB - 0.5) + 3;
    main.box(Math.min(xa, along - 4), y0 + 9, collS * side - 3.5, Math.max(xb, along + 4), y0 + 17, collS * side + 3.5);
    const s1 = Math.abs(lat) - st.r0 + 0.5;
    main.box(along - 4, y0 + 9, Math.min(collS * side, s1 * side), along + 4, y0 + 17, Math.max(collS * side, s1 * side));
    // supports under the collector
    for (let x = xa; x < xb; x += 12) main.box(x - 0.5, y0 - 1, collS * side - 3, x + 0.5, y0 + 9, collS * side - 2);
    // block transformers along the turbine-hall side
    for (let i = 0; i < nB; i++) {
      const x = -M.len / 2 + 10 + pitch * (i + 0.5);
      transformer(main, det, x, y0 - 0.3, -(M.wid / 2 + 11) * side, side > 0 ? 0 : Math.PI);
    }
    // outdoor feed-water / condensate pipes on the facade
    det.paint(C.alu, P.METAL, 0.4, 0.6);
    for (let i = 0; i < 3; i++) det.pipe([-M.len / 2 + 5, y0 + 6 + i * 1.2, (M.wid / 2 + 1 + i * 0.8) * side], [M.len / 2 - 5, y0 + 6 + i * 1.2, (M.wid / 2 + 1 + i * 0.8) * side], 0.35, 10);
    main.pop();
    det.pop();
    // night work lights: boiler walkways and facade lamps (building frame -> site frame)
    const cs = Math.cos(M.rot), sn = Math.sin(M.rot);
    const toF = (lx: number, lz: number): [number, number] => [cx + lx * cs + lz * sn, cz - lx * sn + lz * cs];
    for (let i = 0; i < nB; i++) {
      const x = -M.len / 2 + 10 + pitch * (i + 0.5);
      for (const yy of [12, 26, 40]) {
        for (const e of [-1, 1]) {
          const [fx, fz] = toF(x + e * ((pitch - 8) / 2 + 0.3), ((sB0 + sB1) / 2 + e * 10.5) * side);
          workLight(fr, det, fx, y0 + yy, fz, yy !== 26);
        }
      }
    }
    for (let x = -M.len / 2 + 8; x < M.len / 2; x += 24) {
      const [fx, fz] = toF(x, -(M.wid / 2 + 0.4) * side);
      workLight(fr, det, fx, y0 + 6, fz, true);
    }
    addBox(fr, cx, y0 - 2, cz, M.len, 41, M.wid, M.rot);
  }
  // ------------- 1960 TEC main building (enclosed boilers)
  {
    const T = data.tec;
    const cx = T.x - fr.ox, cz = T.z - fr.oz;
    const y0 = groundMax(fr, T.ring) - fr.oy + 0.3;
    main.at(cx, 0, cz, T.rot);
    det.at(cx, 0, cz, T.rot);
    powerHouse(main, det, T.len, T.wid, T.boilerSide, y0, true, pal2);
    const st = data.stacks[1];
    const dx = st.x - T.x, dz = st.z - T.z;
    const along = dx * Math.cos(T.rot) - dz * Math.sin(T.rot);
    const lat = dx * Math.sin(T.rot) + dz * Math.cos(T.rot);
    const side = T.boilerSide;
    main.paint(C.steel, P.METAL, 0.6, 0.35);
    const sA = T.wid / 2, sBnd = Math.abs(lat) - st.r0 + 0.5;
    main.box(along - 3.5, y0 + 12, Math.min(sA * side, sBnd * side), along + 3.5, y0 + 19, Math.max(sA * side, sBnd * side));
    // two older duct branches along the building
    main.box(Math.min(along, -T.len / 4) - 3, y0 + 12, (sA + 2) * side - 3, Math.max(along, T.len / 4) + 3, y0 + 18, (sA + 2) * side + 3);
    for (let i = 0; i < 4; i++) transformer(main, det, -T.len / 2 + 20 + i * ((T.len - 40) / 3), y0 - 0.3, -(T.wid / 2 + 10) * side, side > 0 ? 0 : Math.PI);
    main.pop();
    det.pop();
    {
      const cs = Math.cos(T.rot), sn = Math.sin(T.rot);
      for (let x = -T.len / 2 + 8; x < T.len / 2; x += 24) {
        for (const e of [-1, 1]) {
          const lz = e * (T.wid / 2 + 0.4);
          workLight(fr, det, cx + x * cs + lz * sn, y0 + 6, cz - x * sn + lz * cs, e > 0);
        }
      }
    }
    addBox(fr, cx, y0 - 2, cz, T.len, 47, T.wid, T.rot);
  }
  // ------------- chimneys
  for (const s of data.stacks) chimney(fr, main, det, { x: s.x - fr.ox, z: s.z - fr.oz, h: s.h, r0: s.r0, r1: s.r1, style: s.style });
  // ------------- tanks
  for (const t of data.tanks) {
    const oil = t.kind === 'oil';
    tank(fr, main, det, t.x - fr.ox, t.z - fr.oz, t.r, t.h, oil ? col('#5f6260') : col('#a9b0ad'), { bund: oil, seed: Math.floor(t.x * 3) });
  }
}

/** Highest ground (world) along a ring. */
export function groundMax(fr: Frame, ring: number[]): number {
  let m = -Infinity;
  for (let i = 0; i < ring.length; i += 2) m = Math.max(m, fr.ground(ring[i], ring[i + 1]));
  return m;
}

// ------------------------------------------------------------------------------ AZOT
export function buildAzot(data: any, fr: Frame, main: Geo, det: Geo, tileOf: (x: number, z: number) => { main: Geo; detail: Geo }): void {
  for (const s of data.stacks) chimney(fr, main, det, { x: s.x - fr.ox, z: s.z - fr.oz, h: s.h, r0: s.r0, r1: s.r1, style: s.style ?? 'concrete_top' });
  for (const p of data.prill) prillingTower(fr, main, det, p.x - fr.ox, p.z - fr.oz, p.r, p.h, Math.floor(p.x * 7));
  for (const c of data.columns) column(fr, main, det, c.x - fr.ox, c.z - fr.oz, c.r, c.h, Math.floor(c.x * 11), C.alu);
  for (const a of data.ammonia) ammoniaTank(fr, main, det, a.x - fr.ox, a.z - fr.oz, a.r, a.h, Math.floor(a.x * 5 + a.z));
  for (const t of data.tanks) tank(fr, main, det, t.x - fr.ox, t.z - fr.oz, t.r, t.h, t.r > 10 ? col('#c9cbc6') : C.alu, { seed: Math.floor(t.x * 13), dome: t.r < 12 });
  // process equipment cells (tiles, so that the detail layer can be distance-culled)
  // (cells with a strong DSM signal hold tall columns: the 30 m DSM underestimates slender objects)
  for (const c of data.cells) {
    const t = tileOf(c[0], c[1]);
    if (c[3] > 11 && (c[2] & 3) !== 0) {
      column(fr, t.main, t.detail, c[0] - fr.ox, c[1] - fr.oz, 1.3 + (c[2] % 7) * 0.25, Math.min(55, c[3] * 2.4), c[2], (c[2] & 4) ? C.alu : col('#d0cfc8'));
    } else {
      processCell(fr, t.main, t.detail, c[0] - fr.ox, c[1] - fr.oz, c[2], c[3]);
    }
  }
  // pipe racks (roughly half of the internal roads carry a rack)
  const R = rng(4242);
  for (const r of data.racks as number[][]) {
    if (R() > 0.45) continue;
    const pts = r.map((v, i) => (i % 2 === 0 ? v - fr.ox : v - fr.oz));
    const t = tileOf(r[0], r[1]);
    pipeRack(fr, t.main, t.detail, pts, Math.floor(r[0] * 3 + r[1]));
  }
  void THREE;
}
