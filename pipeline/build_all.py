"""Run the whole data pipeline in dependency order.

  python3 pipeline/build_all.py            # build web assets from already-fetched data
  python3 pipeline/build_all.py --fetch    # also (re)download raw data first

Each step is a script in pipeline/. Missing scripts are skipped, so modules can
register their build step here before implementing it.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

FETCH = [
    ["overture_fetch.py", "divisions", "division_area"],
    ["overture_fetch.py", "buildings", "building"],
    ["overture_fetch.py", "buildings", "building_part"],
    ["overture_fetch.py", "transportation", "segment"],
    ["overture_fetch.py", "base", "water"],
    ["overture_fetch.py", "base", "land"],
    ["overture_fetch.py", "base", "land_use"],
    ["overture_fetch.py", "base", "land_cover"],
    ["overture_fetch.py", "base", "infrastructure"],
    ["overture_fetch.py", "places", "place"],
    ["dem_fetch.py"],
    ["s2_composite.py"],
    ["worldcover_fetch.py"],
]

# order matters: water computes river levels -> terrain carves beds -> everything else drapes on terrain
BUILD = [
    ["build_water.py"],
    ["build_terrain.py", "--if-water-changed"],
    ["build_terrain_base.py"],
    ["build_buildings.py"],
    ["build_roads.py"],
    ["build_vegetation.py"],
    ["build_landmarks.py"],
    ["build_places.py"],
    ["build_sky.py"],
    ["build_traffic.py"],
]


def run(steps):
    for step in steps:
        script = os.path.join(HERE, step[0])
        if not os.path.exists(script):
            print(f"-- skip {step[0]} (not present)")
            continue
        print(f"== {' '.join(step)}", flush=True)
        subprocess.run([sys.executable, script, *step[1:]], cwd=HERE, check=True)


if __name__ == "__main__":
    if "--fetch" in sys.argv:
        run(FETCH)
    run(BUILD)
