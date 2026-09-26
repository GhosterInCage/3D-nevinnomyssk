// Material conversion for the path tracer.
//
// three-gpu-pathtracer reads a fixed set of MeshStandard/MeshPhysical
// parameters and uploads *every* texture-valued property of a material into
// one 2D texture array. Scene materials are therefore never passed through:
// each one is mapped to a clean MeshPhysicalMaterial proxy that only carries
// supported parameters and plain 2D textures. Custom shaders are honoured
// through `object.userData.ptMaterial` / `material.userData.ptMaterial`.
import * as THREE from 'three';

const TEX_KEYS = [
  'map', 'alphaMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
  'transmissionMap', 'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap',
  'sheenColorMap', 'sheenRoughnessMap', 'specularColorMap', 'specularIntensityMap',
  'iridescenceMap', 'iridescenceThicknessMap',
] as const;

/** A plain 2D texture the path tracer can render into its texture array. */
export function usableTexture(t: any): t is THREE.Texture {
  if (!t || !t.isTexture) return false;
  if (t.isCubeTexture || t.isDataArrayTexture || t.isData3DTexture || t.isCompressedArrayTexture || t.isDepthTexture) return false;
  if (t.mapping === THREE.CubeUVReflectionMapping || t.mapping === THREE.CubeReflectionMapping || t.mapping === THREE.CubeRefractionMapping) return false;
  const img = t.image;
  if (t.isRenderTargetTexture) return true;
  if (!img) return false;
  const w = img.width ?? img.videoWidth ?? 0, h = img.height ?? img.videoHeight ?? 0;
  return w > 0 && h > 0;
}

function lum(c: THREE.Color): number { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }

export interface ResolveInfo {
  /** geometry vertex colours are used by the proxy */
  vertexColors: boolean;
}

export class MaterialResolver {
  /** source material (+variant) -> proxy (null = skip) */
  private cache = new Map<string, THREE.MeshPhysicalMaterial | null>();
  private byUuid = new Map<string, THREE.Material>();
  readonly skipped = new Map<string, number>();
  /** Force two-sided opaque surfaces (closed city meshes are often single-sided). */
  doubleSide = true;

  /** Resolve the path-tracing material for one object/material pair. */
  resolve(obj: THREE.Object3D, src: THREE.Material, groupIndex: number, forceVertexColors = false): THREE.MeshPhysicalMaterial | null {
    const ud = obj.userData || {};
    let pt: any = ud.ptMaterial ?? (src as any).userData?.ptMaterial;
    if (Array.isArray(pt)) pt = pt[groupIndex] ?? pt[0];
    const base: THREE.Material = pt && pt.isMaterial ? pt : src;
    const key = `${base.uuid}|${forceVertexColors ? 1 : 0}|${pt ? 'p' : 's'}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    let out: THREE.MeshPhysicalMaterial | null = null;
    try {
      out = this.convert(base, !!pt);
    } catch (e) {
      console.warn('[pathtracer] material conversion failed', base.type, base.name, e);
      out = null;
    }
    if (out && forceVertexColors) out.vertexColors = true;
    if (!out) this.skipped.set(`${base.type}:${base.name || '?'}`, (this.skipped.get(`${base.type}:${base.name || '?'}`) ?? 0) + 1);
    this.cache.set(key, out);
    if (out) this.byUuid.set(out.uuid, out);
    return out;
  }

  private convert(m: THREE.Material, isProxy: boolean): THREE.MeshPhysicalMaterial | null {
    const a = m as any;
    if (!m.visible || a.colorWrite === false) return null;
    if (a.isMeshDepthMaterial || a.isMeshDistanceMaterial || a.isShadowMaterial || a.isMeshNormalMaterial
      || a.isPointsMaterial || a.isLineBasicMaterial || a.isSpriteMaterial) return null;
    // additive / non-depth-writing transparent effects are glows, not surfaces
    if (!isProxy && (m.blending === THREE.AdditiveBlending || (m.transparent && !m.depthWrite && !(a.transmission > 0)))) return null;

    const p = new THREE.MeshPhysicalMaterial();
    p.name = `pt:${m.name || m.type}`;
    const copyTex = (key: string) => {
      const t = a[key];
      if (usableTexture(t)) (p as any)[key] = t;
    };

    if (a.isMeshStandardMaterial || a.isMeshPhysicalMaterial) {
      p.color.copy(a.color);
      p.roughness = a.roughness;
      p.metalness = a.metalness;
      p.emissive.copy(a.emissive);
      p.emissiveIntensity = a.emissiveIntensity;
      if (a.normalScale) p.normalScale.copy(a.normalScale);
      for (const k of ['map', 'alphaMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) copyTex(k);
      if (a.isMeshPhysicalMaterial) {
        p.ior = a.ior;
        p.transmission = a.transmission;
        p.thickness = a.thickness;
        p.attenuationColor.copy(a.attenuationColor);
        p.attenuationDistance = a.attenuationDistance;
        p.clearcoat = a.clearcoat;
        p.clearcoatRoughness = a.clearcoatRoughness;
        p.sheen = a.sheen;
        p.sheenColor.copy(a.sheenColor);
        p.sheenRoughness = a.sheenRoughness;
        p.specularIntensity = a.specularIntensity;
        p.specularColor.copy(a.specularColor);
        p.iridescence = a.iridescence;
        p.iridescenceIOR = a.iridescenceIOR;
        p.iridescenceThicknessRange = [...a.iridescenceThicknessRange] as [number, number];
        for (const k of TEX_KEYS) if (!(p as any)[k]) copyTex(k);
      }
    } else if (a.isMeshLambertMaterial || a.isMeshPhongMaterial || a.isMeshToonMaterial || a.isMeshMatcapMaterial) {
      p.color.copy(a.color);
      p.roughness = a.isMeshPhongMaterial ? Math.min(1, Math.sqrt(2 / (Math.max(0, a.shininess) + 2)) * 1.2) : 0.9;
      p.metalness = 0;
      if (a.emissive) { p.emissive.copy(a.emissive); p.emissiveIntensity = a.emissiveIntensity ?? 1; }
      for (const k of ['map', 'alphaMap', 'normalMap', 'emissiveMap']) copyTex(k);
      if (a.normalScale) p.normalScale.copy(a.normalScale);
    } else if (a.isMeshBasicMaterial) {
      // unlit: a light source when it is obviously one, otherwise a matte surface
      const glow = a.toneMapped === false || /glow|lamp|light|emiss|bulb|lens|window/i.test(m.name || '');
      if (glow) {
        p.color.setRGB(0, 0, 0);
        p.emissive.copy(a.color);
        p.emissiveIntensity = 1;
        if (usableTexture(a.map)) p.emissiveMap = a.map;
      } else {
        p.color.copy(a.color);
        copyTex('map');
      }
      p.roughness = 1;
      p.metalness = 0;
      copyTex('alphaMap');
    } else if (a.isShaderMaterial || a.isRawShaderMaterial) {
      const u = a.uniforms || {};
      const c = u.diffuse?.value ?? u.color?.value ?? u.uColor?.value;
      if (!(c && c.isColor)) return null;
      p.color.copy(c);
      p.roughness = 0.85;
      if (usableTexture(u.map?.value)) p.map = u.map.value;
    } else {
      return null;
    }

    p.vertexColors = !!a.vertexColors;
    p.flatShading = !!a.flatShading;
    p.opacity = a.opacity ?? 1;
    p.transparent = !!a.transparent && p.opacity < 0.999;
    p.alphaTest = a.alphaTest ?? 0;
    if (p.alphaTest > 0) p.transparent = false;
    // a colour-less cutout map (alpha in map) needs alphaTest to punch holes
    if (!p.alphaTest && a.transparent && p.map && !p.transmission) { p.alphaTest = 0.5; p.transparent = false; }
    p.side = a.side ?? THREE.FrontSide;
    if (this.doubleSide && !(p.transmission > 0)) p.side = THREE.DoubleSide;
    // path tracer extras
    (p as any).castShadow = a.castShadow ?? true;
    (p as any).matte = false;
    // very bright diffuse albedo does not exist in reality and makes GI glow
    const L = lum(p.color);
    if (!p.map && !p.vertexColors && L > 0.9) p.color.multiplyScalar(0.9 / L);
    return p;
  }

  /** All textures used by the given materials (unique sources). */
  static textures(materials: THREE.Material[]): THREE.Texture[] {
    const set = new Map<string, THREE.Texture>();
    for (const m of materials) for (const k of TEX_KEYS) {
      const t = (m as any)[k];
      if (t && t.isTexture) set.set(`${t.source.uuid}:${t.colorSpace}`, t);
    }
    return [...set.values()];
  }

  /**
   * Drop textures beyond `max` unique sources (least used first) so the path
   * tracer's texture array stays within memory limits. Returns the number dropped.
   */
  static limitTextures(materials: THREE.MeshPhysicalMaterial[], weights: number[], max: number): number {
    const use = new Map<string, number>();
    const hash = (t: THREE.Texture) => `${t.source.uuid}:${t.colorSpace}`;
    materials.forEach((m, i) => {
      for (const k of TEX_KEYS) {
        const t = (m as any)[k];
        if (t && t.isTexture) use.set(hash(t), (use.get(hash(t)) ?? 0) + (weights[i] ?? 1));
      }
    });
    if (use.size <= max) return 0;
    const keep = new Set([...use.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map((e) => e[0]));
    let dropped = 0;
    for (const m of materials) for (const k of TEX_KEYS) {
      const t = (m as any)[k];
      if (t && t.isTexture && !keep.has(hash(t))) { (m as any)[k] = null; dropped++; }
    }
    return dropped;
  }

  dispose(): void {
    for (const m of this.cache.values()) m?.dispose();
    this.cache.clear();
    this.byUuid.clear();
  }
}
