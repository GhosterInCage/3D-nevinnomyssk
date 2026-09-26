// Procedural textures for the player's car: body atlas (albedo, clearcoat/roughness/metalness,
// normal from a height canvas), tyre tread, light lenses and Russian number plates.
import * as THREE from 'three';
import { DIM, GH, belt, roofRail, railHalfWidth, halfWidth } from './carShape';

export const ATLAS = 1024;

/** UV regions of the body atlas (v up). */
export const REGION = {
  side: { v0: 0.60, v1: 1.0, y0: 0.1, y1: 1.5 },          // u <- z in [-2.2, 2.2]
  top: { v0: 0.30, v1: 0.60, x0: -0.92, x1: 0.92 },       // u <- z
  front: { u0: 0.0, u1: 0.5, v0: 0.02, v1: 0.30, y0: 0.15, y1: 1.15, x0: -0.92, x1: 0.92 },
  rear: { u0: 0.5, u1: 1.0, v0: 0.02, v1: 0.30, y0: 0.15, y1: 1.15, x0: -0.92, x1: 0.92 },
  under: { v0: 0.0, v1: 0.02 },
  zMin: -2.2, zMax: 2.2,
};

export function uvSide(z: number, y: number): [number, number] {
  const r = REGION.side;
  return [(z - REGION.zMin) / (REGION.zMax - REGION.zMin), r.v0 + (r.v1 - r.v0) * (y - r.y0) / (r.y1 - r.y0)];
}
export function uvTop(z: number, x: number): [number, number] {
  const r = REGION.top;
  return [(z - REGION.zMin) / (REGION.zMax - REGION.zMin), r.v0 + (r.v1 - r.v0) * (x - r.x0) / (r.x1 - r.x0)];
}
export function uvFront(x: number, y: number): [number, number] {
  const r = REGION.front;
  return [r.u0 + (r.u1 - r.u0) * (x - r.x0) / (r.x1 - r.x0), r.v0 + (r.v1 - r.v0) * (y - r.y0) / (r.y1 - r.y0)];
}
export function uvRear(x: number, y: number): [number, number] {
  const r = REGION.rear;
  // mirrored so that the car's right side (x < 0) is on the right of the image seen from behind
  return [r.u0 + (r.u1 - r.u0) * (x - r.x0) / (r.x1 - r.x0), r.v0 + (r.v1 - r.v0) * (y - r.y0) / (r.y1 - r.y0)];
}

interface Mat { albedo: string; cc: number; rough: number; metal: number; h: number }

function hexToRgb(h: string): [number, number, number] {
  const c = new THREE.Color(h);
  return [c.r, c.g, c.b];
}
function rgbStr(c: [number, number, number]): string {
  return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
}

/** Draws into albedo / material / height canvases at once, in car-space coordinates. */
class Painter {
  readonly a: CanvasRenderingContext2D;
  readonly m: CanvasRenderingContext2D;
  readonly h: CanvasRenderingContext2D;
  readonly ca: HTMLCanvasElement;
  readonly cm: HTMLCanvasElement;
  readonly ch: HTMLCanvasElement;

  constructor(readonly N: number) {
    const mk = () => { const c = document.createElement('canvas'); c.width = c.height = N; return c; };
    this.ca = mk(); this.cm = mk(); this.ch = mk();
    this.a = this.ca.getContext('2d')!;
    this.m = this.cm.getContext('2d')!;
    this.h = this.ch.getContext('2d')!;
  }

  px(uv: [number, number]): [number, number] { return [uv[0] * this.N, (1 - uv[1]) * this.N]; }

  private style(m: Mat): void {
    this.a.fillStyle = this.a.strokeStyle = m.albedo;
    this.m.fillStyle = this.m.strokeStyle = `rgb(${Math.round(m.cc * 255)},${Math.round(m.rough * 255)},${Math.round(m.metal * 255)})`;
    const hv = Math.round(m.h * 255);
    this.h.fillStyle = this.h.strokeStyle = `rgb(${hv},${hv},${hv})`;
  }

  private each(fn: (g: CanvasRenderingContext2D) => void): void { fn(this.a); fn(this.m); fn(this.h); }

  rect(x0: number, y0: number, x1: number, y1: number, m: Mat): void {
    this.style(m);
    this.each((g) => g.fillRect(x0, y0, x1 - x0, y1 - y0));
  }

  poly(pts: Array<[number, number]>, m: Mat, close = true): void {
    this.style(m);
    this.each((g) => {
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
      if (close) { g.closePath(); g.fill(); }
    });
  }

  line(pts: Array<[number, number]>, width: number, m: Mat): void {
    this.style(m);
    this.each((g) => {
      g.lineWidth = width;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
      g.stroke();
    });
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, m: Mat): void {
    this.style(m);
    this.each((g) => { g.beginPath(); g.ellipse(cx, cy, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2); g.fill(); });
  }

  roundRect(x0: number, y0: number, x1: number, y1: number, r: number, m: Mat): void {
    this.style(m);
    this.each((g) => { g.beginPath(); g.roundRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0), r); g.fill(); });
  }
}

export interface BodyTextures { map: THREE.Texture; orm: THREE.Texture; normal: THREE.Texture }

/** Paint the body atlas for a given paint colour (sRGB hex). */
export function paintBodyAtlas(paint: string): BodyTextures {
  const N = ATLAS;
  const P = new Painter(N);
  const pc = hexToRgb(paint);
  const PAINT: Mat = { albedo: paint, cc: 1, rough: 0.34, metal: 0.55, h: 1 };
  const GLASS: Mat = { albedo: '#07090b', cc: 1, rough: 0.03, metal: 0.0, h: 1 };
  const PLASTIC: Mat = { albedo: '#141517', cc: 0.05, rough: 0.6, metal: 0, h: 0.85 };
  const CHROME: Mat = { albedo: '#d9dcdf', cc: 0, rough: 0.12, metal: 1, h: 1 };
  const GAP: Mat = { albedo: rgbStr([pc[0] * 0.18, pc[1] * 0.18, pc[2] * 0.18]), cc: 0.2, rough: 0.6, metal: 0.1, h: 0 };
  const UNDER: Mat = { albedo: '#0c0c0d', cc: 0, rough: 0.95, metal: 0, h: 1 };
  const RUBBER: Mat = { albedo: '#0e0e0f', cc: 0, rough: 0.75, metal: 0, h: 0.9 };
  const DARK_GREY: Mat = { albedo: '#2a2d30', cc: 0.1, rough: 0.5, metal: 0.3, h: 0.9 };
  const AMBER: Mat = { albedo: '#c86a10', cc: 1, rough: 0.1, metal: 0, h: 1 };
  const RED_REFLEX: Mat = { albedo: '#7a0c0c', cc: 1, rough: 0.15, metal: 0, h: 1 };

  P.rect(0, 0, N, N, PAINT);
  // underside strip
  P.rect(0, (1 - REGION.under.v1) * N, N, N, UNDER);

  const S = (z: number, y: number) => P.px(uvSide(z, y));
  const T = (z: number, x: number) => P.px(uvTop(z, x));
  const F = (x: number, y: number) => P.px(uvFront(x, y));
  const Rr = (x: number, y: number) => P.px(uvRear(x, y));
  const pxPerM = N / (REGION.zMax - REGION.zMin); // ~233 px/m along the length
  const gapW = Math.max(2, 0.008 * pxPerM);

  // ------------------------------------------------------------------ side view
  {
    // daylight opening (side windows incl. black B-pillar trim)
    const dlo: Array<[number, number]> = [];
    const zF = 0.735, zT0 = 0.06, zT1 = -1.0, zB = -1.235;
    dlo.push(S(zF, belt(zF) + 0.012));
    for (let k = 1; k <= 10; k++) {
      const t = k / 10;
      const z = zF + (zT0 - zF) * t;
      const yTop = roofRail(zT0) - 0.035;
      const y = belt(z) + 0.012 + (yTop - belt(z) - 0.012) * Math.pow(t, 0.92);
      dlo.push(S(z, y));
    }
    for (let z = zT0; z >= zT1; z -= 0.05) dlo.push(S(z, roofRail(z) - 0.035));
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      const z = zT1 + (zB - zT1) * t;
      const yTop = roofRail(zT1) - 0.035;
      const y = yTop + (belt(zB) + 0.012 - yTop) * Math.pow(t, 1.2);
      dlo.push(S(z, y));
    }
    for (let z = zB; z <= zF; z += 0.05) dlo.push(S(z, belt(z) + 0.012));
    P.poly(dlo, GLASS);
    // rubber window seal along the belt
    const seal: Array<[number, number]> = [];
    for (let z = zB; z <= zF + 0.001; z += 0.05) seal.push(S(z, belt(z) + 0.006));
    P.line(seal, Math.max(2, 0.012 * pxPerM), RUBBER);
    // mirror sail (black triangle at the front of the window)
    P.poly([S(0.735, belt(0.735) + 0.01), S(0.60, belt(0.6) + 0.01), S(0.66, belt(0.66) + 0.10)], PLASTIC);
    // door gaps
    const doorLine = (pts: Array<[number, number]>) => P.line(pts.map((p) => S(p[0], p[1])), gapW, GAP);
    doorLine([[0.80, belt(0.80) - 0.005], [0.81, 0.70], [0.83, 0.45], [0.84, 0.29]]);
    doorLine([[-0.235, roofRail(-0.235) - 0.03], [-0.24, belt(-0.24)], [-0.245, 0.6], [-0.245, 0.29]]);
    const rz = DIM.rearAxle, ar = DIM.archR + 0.03;
    const back: Array<[number, number]> = [[-1.13, belt(-1.13) - 0.005], [-1.125, 0.75]];
    for (let a = 80; a >= 8; a -= 6) back.push([rz + ar * Math.cos((a * Math.PI) / 180), DIM.tyreR + ar * Math.sin((a * Math.PI) / 180)]);
    doorLine(back);
    doorLine([[0.84, 0.29], [0.3, 0.285], [-0.245, 0.285], [rz + ar * Math.cos(0.14), 0.29]]);
    // front bumper / fender seam and rear bumper / quarter panel seam
    const fz = DIM.frontAxle;
    const fseam: Array<[number, number]> = [[1.92, 0.745]];
    for (let a = 70; a >= 10; a -= 10) fseam.push([fz + ar * Math.cos((a * Math.PI) / 180) * 1.02, DIM.tyreR + ar * Math.sin((a * Math.PI) / 180)]);
    doorLine(fseam);
    const rseam: Array<[number, number]> = [[-1.93, 0.74]];
    for (let a = 110; a <= 170; a += 10) rseam.push([rz + ar * Math.cos((a * Math.PI) / 180) * 1.02, DIM.tyreR + ar * Math.sin((a * Math.PI) / 180)]);
    doorLine(rseam);
    // door handles: dark recess + body-colour pull handle
    for (const zc of [-0.1, -1.03]) {
      const [cx, cy] = S(zc, 0.868);
      P.ellipse(cx, cy, 0.075 * pxPerM, 0.022 * pxPerM, GAP);
      P.roundRect(cx - 0.085 * pxPerM, cy - 0.012 * pxPerM, cx + 0.085 * pxPerM, cy + 0.004 * pxPerM, 3, PAINT);
    }
    // key lock on the driver door
    { const [cx, cy] = S(-0.2, 0.868); P.ellipse(cx, cy, 0.012 * pxPerM, 0.012 * pxPerM, CHROME); }
    // subtle character line along the doors (drawn as a shallow groove)
    const ch: Array<[number, number]> = [];
    for (let z = -1.55; z <= 1.2; z += 0.1) ch.push(S(z, 0.62 + 0.03 * (z + 1.55) / 2.75));
    P.line(ch, 1.5, { ...PAINT, albedo: rgbStr([pc[0] * 0.8, pc[1] * 0.8, pc[2] * 0.8]), h: 0.55 });
    // side repeater on the front fender
    { const [cx, cy] = S(1.02, 0.745); P.ellipse(cx, cy, 0.03 * pxPerM, 0.012 * pxPerM, AMBER); }
    // arch liners: anything inside the arch circle is dark
    for (const za of [DIM.frontAxle, DIM.rearAxle]) {
      const [cx, cy] = S(za, DIM.tyreR);
      P.ellipse(cx, cy, (DIM.archR - 0.004) * pxPerM, (DIM.archR - 0.004) * (N * (REGION.side.v1 - REGION.side.v0) / (REGION.side.y1 - REGION.side.y0)), UNDER);
    }
  }

  // ------------------------------------------------------------------ top view
  {
    // windshield
    const ws: Array<[number, number]> = [];
    const z0 = GH.zWS - 0.03, z1 = GH.zWT + 0.035;
    for (let z = z1; z <= z0 + 1e-6; z += 0.04) ws.push(T(z, railHalfWidth(z) - 0.075));
    for (let z = z0; z >= z1 - 1e-6; z -= 0.04) ws.push(T(z, -(railHalfWidth(z) - 0.075)));
    P.poly(ws, GLASS);
    // cowl panel (black plastic under the windshield base)
    const cowl: Array<[number, number]> = [];
    for (let x = -0.78; x <= 0.78; x += 0.06) cowl.push(T(GH.zWS - 0.005, x));
    for (let x = 0.78; x >= -0.78; x -= 0.06) cowl.push(T(GH.zWS + 0.06, x * 0.97));
    P.poly(cowl, PLASTIC);
    // wipers (parked)
    P.line([T(0.77, 0.58), T(0.655, 0.02)], 3, RUBBER);
    P.line([T(0.77, -0.06), T(0.66, -0.63)], 3, RUBBER);
    // rear window with defroster lines
    const rw: Array<[number, number]> = [];
    const r0 = GH.zRB + 0.04, r1 = GH.zRT - 0.035;
    for (let z = r0; z <= r1 + 1e-6; z += 0.04) rw.push(T(z, railHalfWidth(z) - 0.085));
    for (let z = r1; z >= r0 - 1e-6; z -= 0.04) rw.push(T(z, -(railHalfWidth(z) - 0.085)));
    P.poly(rw, GLASS);
    for (let z = r0 + 0.06; z < r1 - 0.03; z += 0.035) P.line([T(z, 0.5), T(z, -0.5)], 1, { ...GLASS, albedo: '#1a1d20', rough: 0.2 });
    // hood outline
    const hood: Array<[number, number]> = [];
    for (let z = GH.zWS + 0.07; z <= 2.02; z += 0.05) hood.push(T(z, halfWidth(z) * 0.845));
    const nose = 2.04;
    for (let x = halfWidth(nose) * 0.84; x >= -halfWidth(nose) * 0.84; x -= 0.05) hood.push(T(nose + 0.03 * (1 - (x / 0.8) ** 2), x));
    for (let z = 2.02; z >= GH.zWS + 0.07; z -= 0.05) hood.push(T(z, -halfWidth(z) * 0.845));
    P.line(hood, gapW, GAP);
    // trunk lid outline
    const lid: Array<[number, number]> = [];
    for (let z = GH.zRB - 0.02; z >= -2.13; z -= 0.05) lid.push(T(z, halfWidth(z) * 0.78));
    for (let z = -2.13; z <= GH.zRB - 0.02; z += 0.05) lid.push(T(z, -halfWidth(z) * 0.78));
    P.line(lid, gapW, GAP);
    P.line([T(GH.zRB - 0.02, halfWidth(GH.zRB) * 0.78), T(GH.zRB - 0.02, -halfWidth(GH.zRB) * 0.78)], gapW, GAP);
    // rear bumper top / trunk lip
    // roof antenna base
    { const [cx, cy] = T(-0.85, 0); P.ellipse(cx, cy, 5, 3, PLASTIC); }
  }

  // ------------------------------------------------------------------ front
  {
    const fxp = N * (REGION.front.u1 - REGION.front.u0) / (REGION.front.x1 - REGION.front.x0);
    // lower intake with horizontal slats
    const [ax, ay] = F(-0.5, 0.47), [bx, by] = F(0.5, 0.30);
    P.roundRect(ax, ay, bx, by, 0.05 * fxp, PLASTIC);
    for (let y = 0.33; y < 0.46; y += 0.035) P.line([F(-0.47, y), F(0.47, y)], 2, DARK_GREY);
    // fog lights
    for (const s of [-1, 1]) {
      const [cx, cy] = F(s * 0.62, 0.40);
      P.ellipse(cx, cy, 0.075 * fxp, 0.06 * fxp, PLASTIC);
      P.ellipse(cx, cy, 0.045 * fxp, 0.045 * fxp, CHROME);
    }
    // upper grille between the headlights with chrome surround and bar
    const g: Array<[number, number]> = [F(-0.29, 0.645), F(0.29, 0.645), F(0.33, 0.735), F(-0.33, 0.735)];
    P.poly(g, PLASTIC);
    P.line([F(-0.33, 0.737), F(0.33, 0.737)], 4, CHROME);
    P.line([F(-0.31, 0.69), F(0.31, 0.69)], 3, CHROME);
    { const [cx, cy] = F(0, 0.69); P.ellipse(cx, cy, 0.06 * fxp, 0.035 * fxp, CHROME); P.ellipse(cx, cy, 0.045 * fxp, 0.024 * fxp, { ...CHROME, albedo: '#1b2a4a', metal: 0.3 }); }
    // headlight housings (under the lens patches)
    for (const s of [-1, 1]) {
      const pts: Array<[number, number]> = [[0.29, 0.645], [0.29, 0.745], [0.5, 0.77], [0.72, 0.775], [0.84, 0.745], [0.84, 0.68], [0.7, 0.64], [0.5, 0.63]];
      P.poly(pts.map((p) => F(s * p[0], p[1])), DARK_GREY);
    }
    // bumper seam under the headlights, plate recess
    P.line([F(-0.8, 0.615), F(-0.3, 0.60), F(0.3, 0.60), F(0.8, 0.615)], gapW, GAP);
    P.roundRect(...F(-0.28, 0.585), ...F(0.28, 0.475), 4, { ...PAINT, albedo: rgbStr([pc[0] * 0.7, pc[1] * 0.7, pc[2] * 0.7]), h: 0.7 });
  }

  // ------------------------------------------------------------------ rear
  {
    const rxp = N * (REGION.rear.u1 - REGION.rear.u0) / (REGION.rear.x1 - REGION.rear.x0);
    // trunk lid lower edge & sides
    P.line([Rr(-0.66, 1.0), Rr(-0.66, 0.74), Rr(0.66, 0.74), Rr(0.66, 1.0)], gapW, GAP);
    // bumper seam
    P.line([Rr(-0.84, 0.70), Rr(0.84, 0.70)], gapW, GAP);
    // plate recess
    P.roundRect(...Rr(-0.29, 0.655), ...Rr(0.29, 0.525), 4, { ...PAINT, albedo: rgbStr([pc[0] * 0.7, pc[1] * 0.7, pc[2] * 0.7]), h: 0.7 });
    // lower black insert + reflectors
    P.roundRect(...Rr(-0.72, 0.44), ...Rr(0.72, 0.36), 6, PLASTIC);
    for (const s of [-1, 1]) P.roundRect(...Rr(s * 0.64 - 0.06, 0.47), ...Rr(s * 0.64 + 0.06, 0.445), 2, RED_REFLEX);
    // taillight housings
    for (const s of [-1, 1]) {
      const pts: Array<[number, number]> = [[0.38, 0.80], [0.38, 0.945], [0.6, 0.97], [0.82, 0.96], [0.86, 0.90], [0.85, 0.80], [0.7, 0.775]];
      P.poly(pts.map((p) => Rr(s * p[0], p[1])), DARK_GREY);
    }
    // badge
    { const [cx, cy] = Rr(0, 0.86); P.ellipse(cx, cy, 0.055 * rxp, 0.032 * rxp, CHROME); P.ellipse(cx, cy, 0.04 * rxp, 0.022 * rxp, { ...CHROME, albedo: '#1b2a4a', metal: 0.3 }); }
    P.roundRect(...Rr(0.3, 0.80), ...Rr(0.52, 0.782), 2, CHROME); // model badge
  }

  // ------------------------------------------------------------------ build textures
  const map = new THREE.CanvasTexture(P.ca);
  map.colorSpace = THREE.SRGBColorSpace;
  const orm = new THREE.CanvasTexture(P.cm);
  orm.colorSpace = THREE.NoColorSpace;
  const normal = heightToNormal(P.ch, 2.5);
  for (const t of [map, orm, normal]) {
    t.anisotropy = 4;
    t.flipY = true;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
  }
  return { map, orm, normal };
}

/** Tangent-space normal map (OpenGL convention) from a greyscale height canvas. */
export function heightToNormal(src: HTMLCanvasElement, strength = 2): THREE.Texture {
  const w = src.width, h = src.height;
  const g = src.getContext('2d')!;
  const d = g.getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const og = out.getContext('2d')!;
  const img = og.createImageData(w, h);
  const o = img.data;
  const H = (x: number, y: number) => {
    x = x < 0 ? 0 : x >= w ? w - 1 : x;
    y = y < 0 ? 0 : y >= h ? h - 1 : y;
    return d[(y * w + x) * 4] / 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      // canvas y is down; texture v is up (flipY) -> invert dy
      let nx = -dx, ny = dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * w + x) * 4;
      o[i] = (nx * 0.5 + 0.5) * 255;
      o[i + 1] = (ny * 0.5 + 0.5) * 255;
      o[i + 2] = (nz * 0.5 + 0.5) * 255;
      o[i + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(out);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// ------------------------------------------------------------------ tyre
export function tyreTextures(): { map: THREE.Texture; normal: THREE.Texture; rough: THREE.Texture } {
  const W = 1024, H = 256;
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const ca = mk(), ch = mk();
  const a = ca.getContext('2d')!, hh = ch.getContext('2d')!;
  // v (canvas y) runs across the profile: 0..0.3 inner sidewall, 0.3..0.7 tread, 0.7..1 outer sidewall
  a.fillStyle = '#1a1a1b'; a.fillRect(0, 0, W, H);
  hh.fillStyle = '#b0b0b0'; hh.fillRect(0, 0, W, H);
  const t0 = H * 0.3, t1 = H * 0.7;
  a.fillStyle = '#141415'; a.fillRect(0, t0, W, t1 - t0);
  hh.fillStyle = '#ffffff'; hh.fillRect(0, t0, W, t1 - t0);
  hh.fillStyle = '#000000';
  // circumferential grooves
  for (const f of [0.38, 0.5, 0.62]) hh.fillRect(0, H * f - 2, W, 4);
  // lateral grooves / blocks (directional V pattern)
  const blocks = 64;
  for (let k = 0; k < blocks; k++) {
    const x = (k / blocks) * W;
    hh.lineWidth = 3;
    hh.beginPath(); hh.moveTo(x, t0); hh.lineTo(x + 8, H * 0.5); hh.lineTo(x, t1); hh.stroke();
    hh.lineWidth = 1;
    hh.beginPath(); hh.moveTo(x + 8, t0 + 4); hh.lineTo(x + 12, H * 0.44); hh.stroke();
    hh.beginPath(); hh.moveTo(x + 8, t1 - 4); hh.lineTo(x + 12, H * 0.56); hh.stroke();
  }
  // sidewall lettering (raised)
  const text = 'RADIAL  TUBELESS   185/65 R14 86H   ';
  for (const [y, flip] of [[H * 0.84, false], [H * 0.16, true]] as Array<[number, boolean]>) {
    hh.save();
    hh.font = 'bold 22px sans-serif';
    hh.fillStyle = '#ffffff';
    hh.textBaseline = 'middle';
    for (let x = 0; x < W; x += 340) {
      hh.save();
      hh.translate(x, y);
      if (flip) hh.scale(1, -1);
      hh.fillText(text, 0, 0);
      hh.restore();
    }
    hh.restore();
  }
  const map = new THREE.CanvasTexture(ca);
  map.colorSpace = THREE.SRGBColorSpace;
  const normal = heightToNormal(ch, 3);
  const rough = new THREE.CanvasTexture(ca);
  for (const t of [map, normal, rough]) { t.wrapS = THREE.RepeatWrapping; t.anisotropy = 4; t.needsUpdate = true; }
  return { map, normal, rough };
}

// ------------------------------------------------------------------ lenses
/** Headlamp insert: chrome reflector with two round projector bowls + amber indicator. */
export function headlampTexture(): { map: THREE.Texture; emissive: THREE.Texture } {
  const W = 256, H = 64;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const e = document.createElement('canvas'); e.width = W; e.height = H;
  const g = c.getContext('2d')!, ge = e.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#b9c0c6'); grd.addColorStop(0.5, '#e6eaee'); grd.addColorStop(1, '#8e959b');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  ge.fillStyle = '#000'; ge.fillRect(0, 0, W, H);
  // u runs from the inner (grille) end to the outer (fender) end
  for (const [cx, r] of [[W * 0.2, H * 0.36], [W * 0.46, H * 0.4]] as Array<[number, number]>) {
    const rg = g.createRadialGradient(cx, H * 0.52, 1, cx, H * 0.52, r);
    rg.addColorStop(0, '#ffffff'); rg.addColorStop(0.35, '#9aa2a8'); rg.addColorStop(0.8, '#e2e6ea'); rg.addColorStop(1, '#5d6368');
    g.fillStyle = rg; g.beginPath(); g.arc(cx, H * 0.52, r, 0, Math.PI * 2); g.fill();
    const re = ge.createRadialGradient(cx, H * 0.52, 1, cx, H * 0.52, r);
    re.addColorStop(0, '#ffffff'); re.addColorStop(0.7, '#d8dde8'); re.addColorStop(1, '#202020');
    ge.fillStyle = re; ge.beginPath(); ge.arc(cx, H * 0.52, r, 0, Math.PI * 2); ge.fill();
  }
  // amber indicator at the outer end
  g.fillStyle = '#d98a1c'; g.fillRect(W * 0.72, H * 0.25, W * 0.26, H * 0.5);
  g.fillStyle = 'rgba(255,255,255,0.35)';
  for (let x = W * 0.72; x < W * 0.98; x += 6) g.fillRect(x, H * 0.25, 2, H * 0.5);
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace;
  const emissive = new THREE.CanvasTexture(e); emissive.colorSpace = THREE.SRGBColorSpace;
  return { map, emissive };
}

/** Tail lamp: red with reflex facets, the inner end white (reverse) and an amber indicator band. */
export function taillampTexture(): { map: THREE.Texture; emissive: THREE.Texture; reverse: THREE.Texture } {
  const W = 256, H = 64;
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const c = mk(), e = mk(), r = mk();
  const g = c.getContext('2d')!, ge = e.getContext('2d')!, gr = r.getContext('2d')!;
  // u: inner (lid) -> outer (fender)
  g.fillStyle = '#6e0a0e'; g.fillRect(0, 0, W, H);
  for (let x = 0; x < W; x += 8) for (let y = 0; y < H; y += 8) {
    g.fillStyle = (x + y) % 16 === 0 ? '#8c1016' : '#5a070b';
    g.fillRect(x, y, 7, 7);
  }
  g.fillStyle = '#d9d9d9'; g.fillRect(0, 0, W * 0.2, H);           // reverse (white)
  g.fillStyle = '#c57a18'; g.fillRect(W * 0.2, H * 0.55, W * 0.3, H * 0.45); // indicator
  ge.fillStyle = '#000'; ge.fillRect(0, 0, W, H);
  ge.fillStyle = '#ff1a14'; ge.fillRect(W * 0.2, 0, W * 0.8, H * 0.55); ge.fillRect(W * 0.5, H * 0.55, W * 0.5, H * 0.45);
  gr.fillStyle = '#000'; gr.fillRect(0, 0, W, H);
  gr.fillStyle = '#fff'; gr.fillRect(0, 0, W * 0.2, H);
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace;
  const emissive = new THREE.CanvasTexture(e); emissive.colorSpace = THREE.SRGBColorSpace;
  const reverse = new THREE.CanvasTexture(r); reverse.colorSpace = THREE.SRGBColorSpace;
  return { map, emissive, reverse };
}

/** Russian number plate (GOST R 50577 type 1): "X 000 XX | 26 RUS" on white, black border. */
export function plateTexture(text = 'В170НК', region = '26'): THREE.Texture {
  const W = 520, H = 112;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#111'; g.lineWidth = 6; g.strokeRect(4, 4, W - 8, H - 8);
  g.lineWidth = 3; g.beginPath(); g.moveTo(W * 0.745, 6); g.lineTo(W * 0.745, H - 6); g.stroke();
  g.fillStyle = '#111';
  g.textBaseline = 'alphabetic';
  // series letters are smaller than digits
  const L1 = text[0], D = text.slice(1, 4), L2 = text.slice(4);
  g.font = 'bold 66px "DejaVu Sans Mono", "Courier New", monospace';
  g.fillText(L1, 22, 90);
  g.font = 'bold 86px "DejaVu Sans Mono", "Courier New", monospace';
  g.fillText(D, 72, 94);
  g.font = 'bold 66px "DejaVu Sans Mono", "Courier New", monospace';
  g.fillText(L2, 238, 90);
  g.font = 'bold 60px "DejaVu Sans", Arial, sans-serif';
  g.textAlign = 'center';
  g.fillText(region, W * 0.872, 64);
  g.font = 'bold 18px "DejaVu Sans", Arial, sans-serif';
  g.fillText('RUS', W * 0.84, 96);
  // flag
  const fx = W * 0.915, fy = 82, fw = 26, fh = 16;
  g.fillStyle = '#fff'; g.fillRect(fx, fy, fw, fh / 3);
  g.fillStyle = '#1c3f9c'; g.fillRect(fx, fy + fh / 3, fw, fh / 3);
  g.fillStyle = '#d0202a'; g.fillRect(fx, fy + (2 * fh) / 3, fw, fh / 3);
  g.strokeStyle = '#111'; g.lineWidth = 1; g.strokeRect(fx, fy, fw, fh);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
