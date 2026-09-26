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
  // ------------- combined-cycle unit PGU-410 (2011)
  if (data.pgu) pguUnit(fr, main, det, data.pgu);
  // ------------- chimneys
  for (const s of data.stacks) chimney(fr, main, det, { x: s.x - fr.ox, z: s.z - fr.oz, h: s.h, r0: s.r0, r1: s.r1, style: s.style });
  // ------------- tanks
  for (const t of data.tanks) {
    const oil = t.kind === 'oil';
    tank(fr, main, det, t.x - fr.ox, t.z - fr.oz, t.r, t.h, oil ? col('#5f6260') : col('#a9b0ad'), { bund: oil, seed: Math.floor(t.x * 3) });
  }
}

/** Steel flue-gas stack (PGU heat-recovery boiler): plain tube, top band, platforms, ladder, lamps. */
export function steelStack(fr: Frame, g: Geo, d: Geo, x: number, z: number, y0: number, h: number, r: number): void {
  const seg = 28;
  g.paint(C.concreteDark, P.CONCRETE, 0.9);
  g.cyl(x, y0 - 1, z, r + 1.5, r + 1.5, 2.2, seg);
  // shell in 3 m cans (weld lines read as subtle rings), light grey paint; red/white top bands
  g.paint(col('#9aa0a2'), P.METAL, 0.45, 0.35);
  g.lathe(x, y0 + 1.2, z, [r + 0.25, 0, r + 0.25, 1.6, r, 3.2, r, h * 0.8], seg, true);
  for (let i = 0; i < 4; i++) {
    const a = h * 0.8 + (i * h * 0.2) / 4, b = h * 0.8 + ((i + 1) * h * 0.2) / 4;
    g.paint(i % 2 === 0 ? C.white : C.red, P.METAL, 0.45, 0.3);
    g.lathe(x, y0 + 1.2, z, [r, a, r, b], seg, true);
  }
  g.paint(C.soot, P.METAL, 0.8, 0.4, F.NOGRIME);
  g.lathe(x, y0 + 1.2 + h, z, [r, 0, r + 0.15, 0.1, r + 0.15, 0.5, r - 0.15, 0.55, r - 0.15, -4], seg, false);
  g.disc(x, y0 + h - 3, z, r - 0.15, seg, true);
  for (const f of [0.5, 0.96]) {
    const Y = y0 + 1.2 + h * f;
    g.paint(C.steelDark, P.GRATE, 0.7, 0.4);
    g.disc(x, Y, z, r + 1.2, seg, true, r);
    d.paint(C.yellow, P.METAL, 0.6, 0.3);
    d.ringRailing(x, Y, z, r + 1.15, 1.1, seg, 0.05);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      d.paint(C.lampRed, P.LAMP, 0.4, 0, 0);
      d.boxC(x + Math.cos(a) * (r + 1.0), Y + 1.25, z + Math.sin(a) * (r + 1.0), 0.3, 0.3, 0.3);
      fr.glows.push({ x: fr.ox + x + Math.cos(a) * (r + 1.0), y: fr.oy + Y + 1.4, z: fr.oz + z + Math.sin(a) * (r + 1.0), color: new THREE.Color(4.4, 0.4, 0.2), size: 1.8, day: 0, phase: 0 });
    }
  }
  d.paint(C.steelDark, P.GRATE, 0.7, 0.4);
  d.beam([x + r + 0.35, y0 + 1, z], [x + r + 0.35, y0 + h, z], 0.5, 0.06);
  fr.colliders.push({ kind: 'cylinder', key: `lm:${fr.key}:pgu-stack`, center: [fr.ox + x, fr.oy + y0 + h / 2, fr.oz + z], radius: r + 0.3, halfHeight: h / 2 });
}

/**
 * Combined-cycle unit PGU-410 (block 14, 2011): single-shaft Siemens SGT5-PAC 4000F + SST-900 in a
 * clad turbine hall, electrical / auxiliary bay, gas-turbine air-intake filter house on the roof, exhaust
 * transition into a horizontal CMI heat-recovery steam generator with drums on top, and a steel stack.
 */
export function pguUnit(fr: Frame, g: Geo, d: Geo, U: any): void {
  const cx = U.x - fr.ox, cz = U.z - fr.oz;
  const cs = Math.cos(U.rot), sn = Math.sin(U.rot);
  const y0 = groundMax(fr, U.ring) - fr.oy + 0.3;
  const L = U.len, W = U.wid;
  // stack in the building frame
  const dx = U.stack.x - U.x, dz = U.stack.z - U.z;
  const lxS = THREE.MathUtils.clamp(dx * cs - dz * sn, -L / 2 + 14, L / 2 - 14);
  const lzS = dx * sn + dz * cs;
  const sg = lzS >= 0 ? 1 : -1;
  const rS = U.stack.r0 ?? 3.6;
  g.at(cx, 0, cz, U.rot);
  d.at(cx, 0, cz, U.rot);
  const clad = col('#cdd2d4'), clad2 = col('#9ea6aa'), band = col('#3f5f78'), roof = col('#6d7274'), glz = col('#56666b');
  // turbine hall (44 m deep on the HRSG side) + lower electrical / auxiliary bay
  const zH = sg * (W / 2), zM = sg * (W / 2 - 44);
  const hallB: Band[] = [[-3, 1.0, P.PANEL, clad2, 0], [1.0, 16, P.CORR, clad, 0], [16, 18.5, P.GLAZING, glz, F.WINLIT], [18.5, 26, P.CORR, clad, 0], [26, 27.4, P.CORR, band, 0], [27.4, 30, P.CORR, clad, 0]];
  const auxB: Band[] = [[-3, 1.0, P.PANEL, clad2, 0], [1.0, 4.2, P.CORR, clad, 0], [4.2, 6.2, P.GLAZING, glz, F.WINLIT], [6.2, 10.2, P.CORR, clad, 0], [10.2, 12.2, P.GLAZING, glz, F.WINLIT], [12.2, 15, P.CORR, clad, 0], [15, 16.2, P.CORR, band, 0], [16.2, 17, P.CORR, clad, 0]];
  hall(g, d, -L / 2, L / 2, Math.min(zH, zM), Math.max(zH, zM), y0, 30, hallB, hallB, roof, { gableRise: 1.2 });
  hall(g, d, -L / 2, L / 2, Math.min(-zH, zM), Math.max(-zH, zM), y0, 17, auxB, auxB, roof, { faces: sg > 0 ? 1 | 4 | 8 : 2 | 4 | 8 });
  // steel columns expressed on the long facades every 12 m, roller-shutter doors on the gable ends
  g.paint(clad2, P.METAL, 0.6, 0.3);
  for (const [zz, hh, out] of [[zH, 30.2, sg], [-zH, 17.2, -sg]]) {
    for (let x = -L / 2 + 6; x < L / 2 - 1; x += 12) g.box(x - 0.3, y0 - 1, Math.min(zz, zz + out * 0.35), x + 0.3, y0 + hh, Math.max(zz, zz + out * 0.35), 63 - 4);
  }
  for (const ex of [-1, 1]) {
    g.paint(col('#7b8386'), P.CORR, 0.55, 0.4);
    const zd = sg * (W / 2 - 22);
    g.box(ex * L / 2 - 0.1, y0 - 0.2, zd - 5, ex * L / 2 + 0.1, y0 + 11, zd + 5, ex > 0 ? 2 : 1);
    const za = -sg * (W / 2 - 14);
    g.box(ex * L / 2 - 0.1, y0 - 0.2, za - 2.5, ex * L / 2 + 0.1, y0 + 5, za + 2.5, ex > 0 ? 2 : 1);
    g.paint(clad2, P.METAL, 0.6, 0.3);
    g.box(ex * L / 2 - 0.4, y0 + 11, zd - 5.4, ex * L / 2 + 0.4, y0 + 11.6, zd + 5.4, 63 - 4);
  }
  // air-intake filter house on the roof above the gas turbine, with the intake duct down into the hall
  const fz = sg * (W / 2 - 16);
  g.paint(col('#b9c0c3'), P.CORR, 0.5, 0.35);
  g.box(lxS - 9, y0 + 31, fz - 7, lxS + 9, y0 + 43, fz + 7);
  g.paint(C.steelDark, P.GRATE, 0.8, 0.3);
  g.box(lxS - 9.05, y0 + 33, fz - 7.05, lxS + 9.05, y0 + 41, fz + 7.05, 16 | 32 | 1 | 2);
  g.paint(col('#b9c0c3'), P.METAL, 0.5, 0.35);
  g.box(lxS - 9.5, y0 + 43, fz - 7.5, lxS + 9.5, y0 + 43.6, fz + 7.5);
  d.paint(C.steel, P.METAL, 0.6, 0.35);
  for (const px of [-8, 8]) for (const pz of [-6, 6]) d.beam([lxS + px, y0 + 30, fz + pz], [lxS + px, y0 + 31, fz + pz], 0.5);
  // exhaust transition + horizontal HRSG (gas flows along z towards the stack)
  const h0 = sg * (W / 2), h1 = sg * (W / 2 + 7);
  const e1 = sg * (Math.abs(lzS) - rS - 5);
  g.paint(C.steel, P.METAL, 0.6, 0.35);
  g.box(lxS - 4.5, y0 + 4, Math.min(h0, h1), lxS + 4.5, y0 + 13, Math.max(h0, h1));
  const hrW = 11, hrH = 31;
  g.paint(col('#aab2b5'), P.CORR, 0.5, 0.4);
  g.box(lxS - hrW, y0, Math.min(h1, e1), lxS + hrW, y0 + hrH, Math.max(h1, e1));
  // steel structure lines, roof with steam drums, penthouse
  d.paint(C.steelDark, P.METAL, 0.6, 0.4);
  const zl0 = Math.min(h1, e1), zl1 = Math.max(h1, e1);
  for (let z = zl0; z <= zl1 + 0.01; z += (zl1 - zl0) / 4) for (const px of [-hrW - 0.3, hrW + 0.3]) d.beam([lxS + px, y0, z], [lxS + px, y0 + hrH + 1, z], 0.45);
  g.paint(col('#8d9699'), P.CORR, 0.5, 0.4);
  g.box(lxS - hrW + 1, y0 + hrH, zl0 + 2, lxS + hrW - 1, y0 + hrH + 3.5, zl1 - 2);
  g.paint(C.alu, P.METAL, 0.4, 0.6);
  const drums: Array<[number, number]> = [[0.25, 1.2], [0.5, 0.9], [0.78, 0.7]];
  for (const [t, r] of drums) g.hcyl(lxS - hrW + 2, lxS + hrW - 2, y0 + hrH + 3.5 + r + 0.3, zl0 + (zl1 - zl0) * t, r, 12, true);
  d.paint(C.yellow, P.METAL, 0.6, 0.3);
  d.railing([lxS - hrW + 1, y0 + hrH + 3.5, zl0 + 2, lxS + hrW - 1, y0 + hrH + 3.5, zl0 + 2, lxS + hrW - 1, y0 + hrH + 3.5, zl1 - 2, lxS - hrW + 1, y0 + hrH + 3.5, zl1 - 2, lxS - hrW + 1, y0 + hrH + 3.5, zl0 + 2], 1.1, 1.8, 0.05);
  // stair tower on the side of the HRSG + walkways
  const stx = lxS + hrW + 3;
  d.paint(col('#b79b3b'), P.METAL, 0.6, 0.3);
  const zs = (zl0 + zl1) / 2;
  for (let yy = 0; yy < hrH; yy += 4) {
    d.beam([stx - 1.2, y0 + yy, zs - 2], [stx + 1.2, y0 + yy + 2, zs], 1.0, 0.1);
    d.beam([stx + 1.2, y0 + yy + 2, zs], [stx - 1.2, y0 + yy + 4, zs + 2], 1.0, 0.1);
  }
  d.paint(C.steelDark, P.METAL, 0.6, 0.4);
  for (const [px, pz] of [[-1.6, -2.4], [1.6, -2.4], [-1.6, 2.4], [1.6, 2.4]]) d.beam([stx + px, y0, zs + pz], [stx + px, y0 + hrH + 3, zs + pz], 0.2);
  for (let yy = 8; yy < hrH; yy += 8) {
    d.paint(C.steelDark, P.GRATE, 0.7, 0.4);
    d.box(lxS + hrW + 0.3, y0 + yy - 0.12, zl0, lxS + hrW + 1.5, y0 + yy, zl1);
  }
  // feed-water / steam pipes from the HRSG to the hall
  d.paint(C.alu, P.METAL, 0.4, 0.6);
  for (let i = 0; i < 3; i++) d.pipe([lxS - hrW - 0.8, y0 + 20 + i * 1.6, zl0 + 3], [lxS - hrW - 0.8, y0 + 20 + i * 1.6, sg * (W / 2)], 0.35 + i * 0.05, 10);
  // outlet duct into the stack
  const sx0 = lxS, sz0 = sg * Math.abs(lzS);
  g.paint(C.steel, P.METAL, 0.6, 0.35);
  g.box(lxS - 4, y0 + 20, Math.min(e1, sz0), lxS + 4, y0 + 29, Math.max(e1, sz0));
  // generator step-up transformer on the aux side, and a gas-reduction skid
  transformer(g, d, -L / 4, y0 - 0.3, -sg * (W / 2 + 10), sg > 0 ? Math.PI : 0);
  transformer(g, d, L / 4, y0 - 0.3, -sg * (W / 2 + 10), sg > 0 ? Math.PI : 0);
  g.pop();
  d.pop();
  // stack (frame coordinates) + colliders
  const wx = cx + sx0 * cs + sz0 * sn, wz = cz - sx0 * sn + sz0 * cs;
  steelStack(fr, g, d, wx, wz, fr.ground(fr.ox + wx, fr.oz + wz) - fr.oy, U.stack.h ?? 60, rS);
  addBox(fr, cx, y0 - 2, cz, L, 32, W, U.rot);
  const hx = cx + lxS * cs + ((zl0 + zl1) / 2) * sn, hz = cz - lxS * sn + ((zl0 + zl1) / 2) * cs;
  addBox(fr, hx, y0, hz, hrW * 2, hrH + 4, zl1 - zl0, U.rot);
  // night work lights along the HRSG and the hall
  for (let yy = 8; yy < hrH; yy += 8) {
    for (const t of [0.2, 0.8]) {
      const lz = zl0 + (zl1 - zl0) * t, lx = lxS + hrW + 1.6;
      workLight(fr, d, cx + lx * cs + lz * sn, y0 + yy + 2.4, cz - lx * sn + lz * cs, yy !== 16);
    }
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
  for (const _ of buildAzotSteps(data, fr, main, det, tileOf)) { /* run to completion */ }
}

/**
 * Azot, built incrementally: yields after the tall structures and after every chunk of process cells /
 * pipe racks so the caller can spread the work over several frames.
 */
export function* buildAzotSteps(data: any, fr: Frame, main: Geo, det: Geo, tileOf: (x: number, z: number) => { main: Geo; detail: Geo }, chunk = 150): Generator<void> {
  for (const s of data.stacks) chimney(fr, main, det, { x: s.x - fr.ox, z: s.z - fr.oz, h: s.h, r0: s.r0, r1: s.r1, style: s.style ?? 'concrete_top' });
  for (const p of data.prill) prillingTower(fr, main, det, p.x - fr.ox, p.z - fr.oz, p.r, p.h, Math.floor(p.x * 7));
  for (const c of data.columns) column(fr, main, det, c.x - fr.ox, c.z - fr.oz, c.r, c.h, Math.floor(c.x * 11), C.alu);
  for (const a of data.ammonia) ammoniaTank(fr, main, det, a.x - fr.ox, a.z - fr.oz, a.r, a.h, Math.floor(a.x * 5 + a.z));
  for (const t of data.tanks) tank(fr, main, det, t.x - fr.ox, t.z - fr.oz, t.r, t.h, t.r > 10 ? col('#c9cbc6') : C.alu, { seed: Math.floor(t.x * 13), dome: t.r < 12 });
  yield;
  // process equipment cells (tiles, so that the detail layer can be distance-culled)
  // (cells with a strong DSM signal hold tall columns: the 30 m DSM underestimates slender objects)
  let n = 0;
  for (const c of data.cells) {
    const t = tileOf(c[0], c[1]);
    if (c[3] > 11 && (c[2] & 3) !== 0) {
      column(fr, t.main, t.detail, c[0] - fr.ox, c[1] - fr.oz, 1.3 + (c[2] % 7) * 0.25, Math.min(55, c[3] * 2.4), c[2], (c[2] & 4) ? C.alu : col('#d0cfc8'));
    } else {
      processCell(fr, t.main, t.detail, c[0] - fr.ox, c[1] - fr.oz, c[2], c[3]);
    }
    if (++n % chunk === 0) yield;
  }
  yield;
  // pipe racks (roughly half of the internal roads carry a rack)
  const R = rng(4242);
  n = 0;
  for (const r of data.racks as number[][]) {
    if (R() > 0.45) continue;
    const pts = r.map((v, i) => (i % 2 === 0 ? v - fr.ox : v - fr.oz));
    const t = tileOf(r[0], r[1]);
    pipeRack(fr, t.main, t.detail, pts, Math.floor(r[0] * 3 + r[1]));
    if (++n % 12 === 0) yield;
  }
  void THREE;
}
