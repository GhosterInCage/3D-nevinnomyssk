# Terrain module (`terrain`)

This module draws the ground of the 20.48 km region and the far terrain out to about 184 km, which includes the Greater Caucasus with Elbrus and the Stavropol upland. It also provides the `terrain` service.

## Pipeline (`pipeline/build_terrain.py`)

`python3 pipeline/build_terrain.py` runs only the stages whose inputs have changed:

| stage | script | output |
|---|---|---|
| bare earth | `terrain_bare.py` | `data/processed/terrain_bare.npy` |
| water beds | `terrain_water.py` | `data/processed/terrain_final.npy`, `terrain_water_depth.npy` |
| ground maps | `terrain_ground.py` | `public/data/terrain/ground_class.bin.gz`, `ground_shade.jpg`, `ground_albedo.jpg`, `data/processed/terrain_ortho.npy` |
| far terrain | `terrain_far.py` | `public/data/terrain/far.json`, `far_mesh.bin.gz`, `far_color.jpg`, `far_normal.jpg` |
| textures | `terrain_textures.py` | `public/textures/terrain/{albedo,normal}_<k>.webp`, `layers.json` |
| export | `build_terrain_base.py` | `height.bin.gz`, `ortho.jpg`, `landcover.png`, `manifest.json` |

Useful flags:

- `--force bare,ground,far,textures,carve` (or `all`) forces the named stages.
- `--if-water-changed` does nothing unless `data/processed/water_surface.npy` or `water_depth.npy` has changed since the last carve. Run it after the water module rebuilds.

`build_all.py` already calls `build_terrain.py` and then `build_terrain_base.py`. `build_terrain_base.py` can be run on its own at any time. It only re-exports, and it keeps any extra keys other modules have added to `manifest.json`.

### Bare-earth DTM (`terrain_bare.py`)

The Copernicus GLO-30 DSM includes roofs and tree canopy. This stage removes them in four steps:

1. **Prior masks.** Overture building footprints (rasterised with all-touched and dilated 10 m) and ESA WorldCover tree cells are marked as non-ground.
2. **Progressive morphological filter.** Square openings of 30, 50, 90, 150 and 250 m are applied with thresholds that depend on context:
   - aggressive in built-up areas,
   - moderate in trees,
   - gentle in open land, where only openings of 90 m or less are used, so natural knolls survive.

   Railway and major-road embankments and the banks next to water are protected from this filter.
3. **Trend-guided fill.** The 150 m morphological lower envelope follows valleys through the city. The residual of the DSM above that envelope is measured on ground cells and push-pull interpolated across non-ground cells. A plain interpolation would raise the Kuban valley floor inside the city, and this approach avoids that.
4. **Forest correction.** In tree stands the result is limited to the DSM minus a local canopy height. The canopy height is measured on edge bands just inside the stand against just outside it. This keeps forested ravines (balki) intact.

A slope-adaptive denoise follows: flat land gets σ = 20 m and escarpments get σ = 8 m. The result is never raised above the DSM.

### Water beds (`terrain_water.py`)

The stage uses the water module's `water_surface.npy`, which is NaN where there is no water, and its `water_depth.npy` depth hints. A negative hint marks a gravel bar or island that stands above the water line.

- Beds are carved to `surface - depth`.
- Without a hint, depth follows a per-kind profile:
  - Kuban and other rivers: 2.6 m, reached about 28 m from the shore, with pools and riffles.
  - Canals: 3.6 m with steep 7 m banks.
  - Ponds: 2 m.
  - Streams: 0.9 m.
- Dry cells within 25 m of water are raised to at least the water line plus 0.2–0.7 m of freeboard. This makes the waterline follow the polygon outline exactly.
- If the water files are missing, the stage estimates a fallback surface from the Overture water features.

### Ground maps (`terrain_ground.py`)

`ground_class.bin.gz` is a 4096², 5 m, uint8 grid with row 0 at the north edge.

- The **low nibble** holds the class: 0 grass, 1 crop, 2 stubble, 3 ploughed, 4 bare, 5 gravel, 6 forest floor, 7 urban ground, 8 pebbles, 9 mud, 10 sand, 11 rock.
- The **high nibble** holds the orientation of field rows, `k·π/16` measured from world +X towards +Z. The orientation comes from the structure tensor of the Sentinel-2 image. For non-field classes the high nibble is a random variant.

Classes come from these sources:

- **WorldCover** gives the base classes.
- **Median-filtered S2 NDVI and brightness** decide the field state: green crop, golden stubble or ploughed chernozem. A 45 m mode filter then makes the state follow field shapes.
- **Overture land use** overrides the base class: industrial becomes gravel, construction becomes bare, pitches become lawn, allotments become ploughed plots, cemeteries and parks become grass.
- **Linear features** are rasterised on top:
  - road shoulders become urban,
  - tracks become bare dirt,
  - rail becomes ballast gravel.
- **Water bodies** (from the water module's body types) set the beds and shores: river shores become pebbles and sand, pond and settling-pond edges become mud, and canal linings become gravel.

`ground_shade.jpg` is 2048² at 10 m:

- **R** is sky visibility (ambient occlusion) from horizon scanning over 16 directions out to 500 m.
- **G** is wetness near water, based on distance to the water and height above the water line.
- **B** is lushness from the summer NDVI.

The ortho is graded to `terrain_ortho.npy`, which is exported as `ortho.jpg`. The grading applies a mild dark-object subtraction and a saturation of 1.08, and the result is still linear reflectance. `ground_albedo.jpg` is the same albedo with building footprints, bright unmapped roofs and tank farms, and tree crowns removed. These areas are in-painted from the surrounding ground, and tree cells are turned into forest floor. It is used near the camera whenever the buildings or vegetation module draws those objects on top.

### Far terrain (`terrain_far.py`)

- **Heights** come from AWS Terrain Tiles (terrarium, zoom 10, about 110 m) resampled to a 2049² grid at 180 m. Inside the region, our own bare-earth heights are used, lowered by 4 m. A 4 km band outside the region blends from our DEM edge to the terrarium heights. Bathymetry is clamped to 0 m, which matters for the Black Sea in the south-west corner.
- **Colour** is a median of the Sentinel-2 L2A 120 m cloudless mosaic for July 2020 (Sinergise, CC-BY 4.0). It is colour-matched to our ortho by a linear fit inside the region, with a soft knee so snow and glaciers keep their true reflectance.
- **Mesh** is a right-triangulated irregular network (Martini, bottom-up errors computed with numba). The error tolerance is 1.3 mrad of the distance from the detailed region plus 2.5 km, and is tighter above 3000 m, so Elbrus keeps its double summit. The mesh is split into 8×8 tiles with uint16 local indices. It has about 67k vertices and 131k triangles, and the file is 0.76 MB gzipped.
- **Mesh data format** (`far.json` describes the tiles):
  - `far_mesh.bin.gz` holds all tile vertices first, each vertex as 3×uint16 (x, z, h). The x and z values are tile-local, 0..65535 across the tile, and h = `hMin + v*hScale`. After the vertices come all tile indices as uint16.
  - `far_normal.jpg` stores the world normal x/z in RG.

### Detail textures (`terrain_textures.py`)

The textures are 14 layers at 1024², stored as webp (8.5 MB total):

- `albedo_k.webp` is sRGB.
- `normal_k.webp` has RG = tangent-space normal, with +u = world +X and +v = world +Z, and B = height, which is used for height-based blending.

| layer | name | source | tile (m) |
|---|---|---|---|
| 0 | grass_lush | ambientCG Grass004 (CC0) | 2.2 |
| 1 | grass_dry | Grass004 re-coloured to straw, plus soil gaps | 2.2 |
| 2 | ground_mix | ambientCG Ground037 (CC0) | 3 |
| 3 | crop_rows | procedural | 4 |
| 4 | stubble | procedural | 3 |
| 5 | ploughed | procedural | 4 |
| 6 | bare_soil | procedural | 3 |
| 7 | gravel | procedural | 2 |
| 8 | forest_floor | procedural | 3 |
| 9 | urban_ground | procedural | 4 |
| 10 | pebbles | procedural | 2.5 |
| 11 | mud | procedural | 3 |
| 12 | sand | procedural | 3 |
| 13 | clay_rock | ambientCG Rock023 (CC0), re-coloured to loess | 6 |

- **ambientCG textures** are CC0 1.0. They were fetched from public GitHub mirrors: RichardEllicott/SimpleInfiniteGodotTerrain and TokisanGames/Terrain3D demo assets.
- **Procedural layers** are generated with numpy using periodic FFT noise, periodic Voronoi and stamped leaves, straw and stones. They are CC0.

## Runtime (`src/modules/terrain`)

- **`cdlod.ts`: CDLOD quadtree.** The quadtree has 9 levels with 80 m leaves. Every patch is a 32×32 grid (16 at low quality, 64 at ultra). Two instanced draw calls are made: full patches and N/2 "partial parent" patches. Vertices morph to the next coarser grid in the outer 35 % of each LOD band, which avoids cracks and popping.
  - Ranges are 160 m, 400 m, 1.5 km, 3.2 km and so on, and the two finest bands are ×1.35 at high and ×1.8 at ultra. At high that gives 2.5 m vertex spacing within about 215 m, 5 m within 540 m, and 10 m (the source resolution) within 1.5 km.
  - Measured load at high is 127k–355k triangles across the standard presets, against a budget of 400k or less. That count includes patches kept within 700 m behind the camera as shadow casters. Medium is about 70k–180k.
  - Node bounds come from a min/max pyramid, which is rebuilt if `HeightField.markDirty()` is called.
- **Vertex stage** (`shaders.ts`, `VERT_*`). Heights (stored at 4 cm steps in height.bin.gz) use Catmull-Rom bicubic interpolation over `ctx.heightfield.texture`, with 16 `texelFetch` calls. The surface passes exactly through the samples. Micro relief of ±6 cm is added within 140 m of the camera on natural ground only; it is never applied on urban, gravel, pebble or mud classes. The shadow depth material uses the same displacement, and morphing uses the main camera for every pass.
- **Ground material.** This is a `MeshStandardMaterial` with `onBeforeCompile`, registered through `ctx.registerMaterial`, so CSM, cloud shadows, IBL, fog and tone mapping all work. The hook is locked with a property accessor so later assignments, such as `CSM.setupMaterial`, are chained instead of replacing ours. Per pixel it does the following:
  - The normal comes from a precomputed normal map of the height field.
  - The two dominant classes are taken from a jittered 4-tap lookup of the 5 m class map, which gives organic borders.
  - Each class has three layers: A and B are blended by lushness (NDVI plus noise) or by noise, and C appears in noise-driven patches such as worn dirt in lawns, weedy stubble or dirt in yards. The layers are combined with height-based blending.
  - Anti-tiling uses two differently mirrored, shifted and scaled lookups of each layer, blended by noise and height. Row layers keep their exact row period in both lookups.
  - Field rows are oriented per field. Swaths (7.2 m) and tramlines (24 m) are analytically anti-aliased so fields read as fields from the air.
  - Slopes steeper than about 30° get triplanar clay/rock.
  - The detail albedo is tinted toward the macro albedo, which is the colour truth: `ground_albedo` near the camera and the full `ortho` beyond 0.35–0.75 × drawDistance. The detail fades into the macro colour at `detailFar`, which is 1.1 km at medium and 1.8 km at high.
  - Wetness darkens the ground and lowers roughness near the water line. Sky visibility plus detail cavities act as ambient occlusion.
  - Rain (`env.rain`) wets the ground with some inertia: it wets within about 20 s and dries over about 4 min. Wet ground is darker and glossier, and puddles form in flat low spots of ploughed, bare, gravel, urban and stubble ground. The puddles reflect the sky through the environment map.
  - Mid-distance structure: between 15 m and 1.4 km the dominant layer, sampled at about 7× its tile size, modulates luminance, so the ground keeps material-like variation after the fine detail has averaged out.
- **Far terrain** (`far.ts`). The far mesh sits in `ctx.backdrop.scene` and uses a patched `MeshStandardMaterial`, so the sky module's backdrop sun and environment map light it.
  - Earth curvature with refraction (d²/2R', R' = R/(1−0.13)) is applied relative to the camera. The drop starts at the boundary of the detailed region, so the far surface meets the flat detailed terrain edge.
  - With the sky module present, its post-processing pipeline applies aerial perspective to the combined depth. Without it, the far shader integrates its own Rayleigh and Mie extinction with exponential height profiles, where Mie is derived from `visibilityKm` (default 170 km) and `env.fog`.
- **`?only=terrain`.** When the sky module isn't loaded, the terrain adds a simple sun and hemisphere light, a background and a fog, so it can be tested alone.
- **Software renderers** (SwiftShader, llvmpipe) get anisotropy 1 and a `TERRAIN_LITE` ground shader, and the detail arrays are loaded at 256². The lite shader uses one anti-tiling lookup with an explicit LOD from the pixel's world footprint, no patch layer, no mid-distance modulation and no triplanar mapping. Low quality also uses the lite shader.
  - Large texture arrays thrash the CPU caches of software renderers. At 1280×720 street level they made a frame take over 9 s under load.
  - For the full look in `tools/shot.mjs`, add `--extra "&terrainFull=1&terrainAniso=8"`, which is slow.
- **Detail texture arrays** are 512² at low, 768² at medium and 1024² at high and ultra. At 1024² that is about 150 MB of GPU memory.

## Service `terrain`

```ts
heightAt(x, z): number                  // bicubic surface as rendered (== HeightField.sample at samples)
normalAt(x, z, out?): Vector3
groundTypeAt(x, z): 'grass'|'crop'|'stubble'|'ploughed'|'bare'|'gravel'|'forest'|'urban'|'pebbles'|'mud'|'sand'|'rock'|'water'|'outside'
classAt(x, z): number                    // index into classes
classes: readonly string[]
mesh: Object3D                           // the CDLOD group (not suitable for raycasting: GPU displaced)
material: MeshStandardMaterial
setOrthoBlend(start, end)                // distance band where the near albedo (roofs/crowns removed) turns into the full ortho
pathTraceProxy(center, radius, spacing?) // regular Mesh of the rendered surface + MeshPhysicalMaterial (path tracer / physics)
stats(): { patches, triangles, far }
setDebug(mode)                           // 1 = class colours
glsl.heightfield                         // GLSL: tHeightBicubic(xz, out grad) etc. (bind uHeight, uHf = (n, half, res))
far: FarTerrain | null                   // setAtmosphere({ hazeColor, visibilityKm }) for the stand-alone haze
```

The patch meshes carry `userData.noPathTrace = true`, and `userData.ptProxy(center, radius, spacing)` returns a path-tracer proxy.
