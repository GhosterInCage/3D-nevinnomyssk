"""Terrain pipeline (module "terrain"). Stages, each cached on input modification times:

  bare     terrain_bare.py     Copernicus DSM -> bare-earth DTM (buildings / canopy removed)
  carve    terrain_water.py    water beds carved below data/processed/water_surface.npy
                               (written by the water module; a fallback estimate is used when
                               it does not exist yet) -> data/processed/terrain_final.npy
  ground   terrain_ground.py   5 m ground-class map, shading/wetness map, graded ortho and
                               de-roofed ground albedo  -> public/data/terrain/ground_*.{png,jpg}
  far      terrain_far.py      far terrain (+-184 km: Caucasus / Elbrus, Stavropol upland)
                               -> public/data/terrain/far.json, far_mesh.bin.gz, far_{color,normal}.jpg
                               (downloads are cached in data/processed/far_tiles, far_s2.npy, far_built.npy)
  textures terrain_textures.py tiling ground detail textures -> public/textures/terrain/
  export   build_terrain_base.py  height.bin.gz / ortho.jpg / landcover.png / manifest.json

Usage:
  python3 pipeline/build_terrain.py                 # run stale stages
  python3 pipeline/build_terrain.py --force bare,ground   # force some stages
  python3 pipeline/build_terrain.py --if-water-changed    # only if water_surface.npy changed

Outputs are documented in docs/modules/terrain.md.
"""
import json
import os
import runpy
import sys
import time

import numpy as np

from config import *

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = f"{PROC}/terrain_state.json"
WATER_SURFACE = f"{PROC}/water_surface.npy"
WATER_DEPTH = f"{PROC}/water_depth.npy"
WATER_SDF = f"{PROC}/water_sdf.npy"
WATER_LEVEL_EXT = f"{PROC}/water_level_ext.npy"
TER = os.path.join(WEB_DATA, "terrain")
TEX = os.path.join(ROOT, "public", "textures", "terrain")


def mtime(p):
    return os.path.getmtime(p) if os.path.exists(p) else 0.0


def stale(outputs, inputs, name, force):
    if name in force or "all" in force:
        return True
    if not all(os.path.exists(o) for o in outputs):
        return True
    newest_in = max([mtime(i) for i in inputs] + [0])
    oldest_out = min(mtime(o) for o in outputs)
    return newest_in > oldest_out


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {}


def main():
    force = set()
    if "--force" in sys.argv:
        force = set(sys.argv[sys.argv.index("--force") + 1].split(","))
    state = load_state()
    wmt = max(mtime(WATER_SURFACE), mtime(WATER_DEPTH), mtime(WATER_SDF), mtime(WATER_LEVEL_EXT))
    if "--if-water-changed" in sys.argv and state.get("water_surface_mtime") == wmt:
        print("terrain: water_surface.npy unchanged -> nothing to do")
        return
    t0 = time.time()
    raw = [f"{RAW}/buildings_building.parquet", f"{RAW}/transportation_segment.parquet", f"{RAW}/base_water.parquet"]
    code = lambda n: os.path.join(HERE, n)

    # ---- bare earth
    if stale([f"{PROC}/terrain_bare.npy"], [f"{PROC}/dem_raw.npy", f"{PROC}/worldcover.npy", code("terrain_bare.py")] + raw, "bare", force):
        print("== terrain: bare earth", flush=True)
        runpy.run_path(code("terrain_bare.py"), run_name="__main__")

    # ---- carve water beds
    carve_inputs = [f"{PROC}/terrain_bare.npy", code("terrain_water.py"), WATER_SURFACE, WATER_DEPTH, WATER_SDF, WATER_LEVEL_EXT]
    if stale([f"{PROC}/terrain_final.npy"], carve_inputs, "carve", force) or state.get("water_surface_mtime") != wmt:
        print("== terrain: carve water beds", "(water module surface)" if wmt else "(fallback surface estimate)", flush=True)
        from terrain_water import water_kinds, estimate_surface, carve
        h = np.load(f"{PROC}/terrain_bare.npy")
        kinds = water_kinds()
        if wmt:
            surf = np.load(WATER_SURFACE).astype(np.float32)
            if surf.shape != h.shape:
                raise SystemExit(f"water_surface.npy has shape {surf.shape}, expected {h.shape}")
        else:
            surf = estimate_surface(h, kinds)
            np.save(f"{PROC}/terrain_water_estimate.npy", surf)
        hint = np.load(WATER_DEPTH).astype(np.float32) if (wmt and os.path.exists(WATER_DEPTH)) else None
        if hint is not None and hint.shape != h.shape:
            hint = None
        sdf = lvx = None
        if wmt and os.path.exists(WATER_SDF) and os.path.exists(WATER_LEVEL_EXT):
            sdf = np.load(WATER_SDF).astype(np.float32)
            lvx = np.load(WATER_LEVEL_EXT).astype(np.float32)
            if sdf.shape != h.shape or lvx.shape != h.shape:
                sdf = lvx = None
        hc, depth = carve(h, surf, kinds, hint, sdf, lvx)
        np.save(f"{PROC}/terrain_final.npy", hc.astype(np.float32))
        np.save(f"{PROC}/terrain_water_depth.npy", depth.astype(np.float32))
        state["water_surface_mtime"] = wmt
        state["water_source"] = "water_surface.npy" if wmt else "fallback"

    # ---- ground classes / shading / ortho
    if os.path.exists(code("terrain_ground.py")) and stale(
            [f"{TER}/ground_class.bin.gz", f"{TER}/ground_shade.jpg", f"{TER}/ground_albedo.jpg", f"{PROC}/terrain_ortho.npy"],
            [f"{PROC}/terrain_final.npy", code("terrain_ground.py"), f"{PROC}/s2_rgb.npy"] + raw, "ground", force):
        print("== terrain: ground maps", flush=True)
        runpy.run_path(code("terrain_ground.py"), run_name="__main__")

    # ---- far terrain (network; cached)
    if os.path.exists(code("terrain_far.py")) and stale(
            [f"{TER}/far.json", f"{TER}/far_mesh.bin.gz", f"{TER}/far_color.jpg", f"{TER}/far_normal.jpg"],
            [code("terrain_far.py"), f"{PROC}/terrain_final.npy"], "far", force):
        print("== terrain: far terrain", flush=True)
        runpy.run_path(code("terrain_far.py"), run_name="__main__")

    # ---- detail textures
    if os.path.exists(code("terrain_textures.py")) and stale(
            [f"{TEX}/albedo_0.webp"], [code("terrain_textures.py")], "textures", force):
        print("== terrain: detail textures", flush=True)
        runpy.run_path(code("terrain_textures.py"), run_name="__main__")

    # ---- export height / ortho / manifest
    print("== terrain: export", flush=True)
    import build_terrain_base
    build_terrain_base.main()
    state["built"] = time.strftime("%Y-%m-%d %H:%M:%S")
    json.dump(state, open(STATE, "w"), indent=2)
    print(f"terrain pipeline done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
