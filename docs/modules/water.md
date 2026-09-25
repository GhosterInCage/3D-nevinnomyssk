# Water module (`src/modules/water`, `pipeline/build_water.py`)

Rivers, the Nevinnomyssk canal, streams, ponds, reservoirs and the Azot settling ponds, as tiled
triangle meshes with per-vertex hydrology attributes, shaded by a patched `MeshPhysicalMaterial`
with planar reflections.

## Pipeline

`python3 pipeline/build_water.py` (about 90 s; `... raster` stops after the rasters).
`python3 pipeline/water_textures.py` regenerates the procedural textures (about 1 s).

1. **Sources.** Overture `base_water` (192 features), plus the weir from `base_infrastructure`.
   * **Kuban** (`river_fast`). OSM riverbank polygons cover the city reach. South of about
     z = +4000 (upstream), Overture has only a centreline, and it is up to 80 m off the real channel.
     There the channel is traced from Sentinel-2 NDWI instead: upsampled ×2, thresholded at −0.05 and
     vectorised, inside a 260 m corridor around the centreline. The OSM polygons include wooded
     islands, which are cut out. A pixel counts as vegetation when NIR > 0.22 and NDVI > 0.45, and a
     blob is removed only if it is at least 24 m thick, so canopy over narrow channels stays water.
     Gaps under bridges and canopy are joined along a minimum spanning tree so the network is
     continuous.
   * **Bolshoy Zelenchuk** (`river`) is handled the same way. It joins the Kuban at world (−576, 1320).
   * **Nevinnomyssk canal** (`canal`). The line is buffered to 30 m, which matches the published
     32 m water surface width and 3.9 m depth. It starts at the headworks weir on the Kuban, world
     (−2264, −1118).
   * **Other canals, drains and streams.** Widths are measured from Sentinel-2 by NDWI unmixing across
     the line, then clamped per class. Intermittent streams, tunnels and culverts are skipped.
   * **Ponds, lakes and reservoirs** (`pond`) and **industrial settling / storage ponds**
     (`industrial`). A pond is classed as industrial when its Sentinel-2 interior is bright and milky
     (mean reflectance > 0.085). That picks out the Azot storage ponds in the east (x ≈ 5–7 km) and
     the settling basins.
2. **Levels.**
   * **Rivers.** The river system is rasterised at 5 m. The along-channel distance comes from a
     Dijkstra geodesic run from the Kuban and Zelenchuk inflow pixels, which avoids errors between
     adjacent meander limbs. For each 50 m station the level is the 20th percentile of
     min(DSM, bare-ground DEM) in a ±100 m window. That series is made monotone non-increasing by
     isotonic regression (PAVA), Gaussian-smoothed (σ = 250 m), and lowered by 0.3 m. The Zelenchuk
     profile is forced to end exactly at the Kuban level at the confluence. The Kuban profile has a
     1.5 m step at the headworks weir: pool 307.5 m, tail water 306.0 m. Overall the Kuban falls from
     340.6 m to 279.0 m across the region, about 2 m/km, which matches published data.
   * **Canals and streams.** The level is the minimum ground across the channel, made monotone by
     PAVA and smoothed, minus a freeboard: canal 1.2 m, stream 0.8 m. The Nevinnomyssk canal is capped
     at the weir-pool level minus 0.3 m.
   * **Still water.** Flat. The level is the 30th percentile of the DSM inside the body, which is
     hydro-flattened for large bodies. For small bodies it is limited by the 20th percentile of the
     ground ring 15 m outside the shore.
3. **Flow.** Flow comes from a potential-flow (Laplace) solution over the 5 m river grid, with
   φ = 0 at the inflows, φ = 1 at the outflow, and Neumann conditions at the banks. The gradient gives
   directions that split around islands, never reverse in braids, and fall to about zero in dead-end
   backwaters. |∇φ| relative to the median gives speed-ups in narrows. On top of that sit a bank
   velocity profile, a slow weir pool, and fast water below the weir. The maximum speed is 2.4 m/s on
   the Kuban, 1.6 m/s on the Zelenchuk, 1.1 m/s in the canal and 0.5 m/s in streams. Canals and
   streams take their direction from the tangent of their line.
4. **Foam / turbulence (baked).** Foam is baked where the level profile is steep (riffles), near
   Sentinel-2 gravel bars (NIR/red between 0.95 and 1.7 and brightness > 0.085, a test that
   separates bars from turbid water), and in a 160 m band below the weir.
5. **Colour.** Each body's colour is the median Sentinel-2 reflectance of its open-water interior,
   eroded by 15 m with NDWI > 0. It is clamped to a plausible range per type and blended 30% toward
   the type default. Examples: Kuban (0.098, 0.096, 0.075), a warm, silty glacial grey; canal
   (0.058, 0.072, 0.058); ponds dark green; Azot ponds milky (0.12–0.18).

### Outputs

| file | format |
|---|---|
| `data/processed/water_surface.npy` | float32 2049², water level (m) at heightmap vertices (i, j), where x = −10240 + 10i and north = 10240 − 10j. NaN means dry. |
| `data/processed/water_depth.npy` | float32 2049², **suggested** bed depth below the surface. **Negative** marks an emergent gravel bar or island, where the bed should stand above the water. |
| `data/processed/water_body.npy` | int16 2049², index into the body table, −1 for none. |
| `data/processed/water_sdf.npy` | float32 2049², signed distance to the mapped shoreline in metres: + inside, − outside, down to −60 m, NaN elsewhere. |
| `data/processed/water_level_ext.npy` | float32 2049², water level extended (nearest) into the −60 m bank band. |
| `data/processed/water_bodies.json` | body table. |
| `public/data/water/water.json` | tile directory, body table, binary layout, weir line, Kuban profile. |
| `public/data/water/water.bin.gz` | 187 tiles of 1024 m (177k vertices, 287k triangles, 2.5 MB). Per vertex: `pos` int16×3 (x, z in dm relative to the tile centre; level as uint16 cm above 200 m), `flow` int8×2 (vx, vz in world axes, 0.05 m/s units), `attr` uint8×4 (shore distance (d+8)·4 m, foam, bar proximity, 0), `body` uint16. Indices are uint16×3 per triangle, local to the tile. |

Meshes are constrained Delaunay (`triangle`, q26, max area 40–400 m²) of each body polygon. Each
polygon is extended 6 m beyond the mapped shore, so the terrain hides the margin where banks are
higher and no floating edges appear where they are not. Precedence is pools > ponds > rivers >
canals > streams, and overlaps are removed.

**Terrain carving** (`pipeline/terrain_water.py`, owned by the terrain module) reads
`water_surface`, `water_depth`, `water_sdf` and `water_level_ext`, then re-runs with
`build_terrain.py --if-water-changed`. The SDF puts the waterline on the polygon outline instead of
a 10 m staircase. The negative depth hints raise gravel bars and islands above the water.

## Runtime (`src/modules/water`)

* `data.ts` parses the tiles and builds a per-tile uniform grid (32 m) over the triangles, used for
  point queries.
* `material.ts` defines `WaterMaterial extends MeshPhysicalMaterial` and patches it through
  `onBeforeCompile`. Lights, CSM shadows, fog and IBL all keep working. External `onBeforeCompile`
  assignments, such as the sky's CSM and cloud-shadow patches, are chained after ours by a property
  setter, not dropped.
  * **Normals.** Two-phase flow-map advection of FFT ripple normal maps at 2.7 m and 8.3 m scales,
    along the per-vertex flow. Slow-phase 26×17 m swells and boils stretched along the current.
    Standing waves over riffles and bars, with crests across the flow. Phillips-spectrum wind waves
    aligned with `ctx.env.wind`, scaled by fetch (shore distance) and body exposure. Rain rings when
    `ctx.env.rain > 0`. Distance fade plus Toksvig roughness for specular anti-aliasing.
  * **Optics.** Depth is the water level minus the terrain height. The height field is sampled
    through its own nearest-filtered R32F texture with a `texelFetch` bilinear, so it matches
    `HeightField.sample()` and needs no float-linear extension. Beer–Lambert transmittance along the
    refracted view path and the sun path uses per-body extinction: Kuban 4.5/m, canal 2.4, ponds 1.2,
    industrial 6.0. In-scatter uses the body albedo, lit by the scene lights (so it takes shadows).
    Fresnel with n = 1.333.
  * **Foam.** Baked turbulence, speed, shallow shoreline and riffles set the foam amount. It is
    advected as flow-aligned streaks plus fine bubbles. The threshold sits at the pattern quantile, so
    the covered fraction roughly equals the amount.
  * **Output.** Premultiplied: `rgb = specular + (1 − F)(1 − T)·scatter` and
    `alpha = 1 − (1 − F)·T`, blended with ONE, ONE_MINUS_SRC_ALPHA over the already rendered terrain
    bed. Fog is premultiplied-aware. The surface writes depth, which the sky's aerial perspective,
    SSAO and composite use.
* `reflection.ts` renders a planar reflection, Reflector-style: mirrored main and backdrop cameras
  with an oblique near plane, into a half-float target whose alpha is coverage. Where nothing was
  drawn, the environment map still supplies the sky.
  * The plane height is the level of the nearest visible water sample, re-chosen every third frame.
    Bodies within about 4 m of that level use it, and the rest fall back to the IBL.
  * Reflections are distorted by the normals and smeared vertically on fast or rough water.
  * Shadow maps are not re-rendered for the reflection pass.
  * Resolution scales with quality: low off, medium 0.35, high 0.5, ultra 0.75 of the framebuffer.
    It is skipped when the path tracer is active.
* `envFallback.ts` is an analytic sky PMREM, with no sun disc, used only while `scene.environment` is
  null. Once the sky module sets `scene.environment`, that is used.
* `piers.ts` adds foam at bridge piers. It reads the pier walls published by the roads module in
  `public/data/roads/objects.json.gz` (`bridges[].piers[]`: position, wall normal, extent w0..w1)
  and handles a missing or changed file gracefully. For each pier in flowing water it lays a strip
  along the local current with a bow cushion at the upstream nose, foam lines along the sides, and a
  V-shaped wake behind the tail. The foam is advected at the local speed. This only runs when the
  roads module is loaded; it produced 32 wakes in testing.
* Underwater: a camera-attached tint quad appears when the camera goes below the local water level.
* Any object with `userData.noReflect = true` is skipped in the reflection pass. The scene is
  scanned for the flag about every 2 s, so heavy layers such as grass or particles can opt out.
* Quality tiers: low has no planar reflection and 0.8 normal detail. Medium renders the reflection
  at 0.35 scale, refreshed every other frame while the view is nearly static, out to 5 km. High uses
  0.5 scale out to 9 km, and ultra 0.75 out to 16 km.
* `userData.ptMaterial` is a transmissive `MeshPhysicalMaterial` proxy for the path tracer.
  `userData.isWater` is set, and so is `userData.noReflect` (informational).

### Service `water`

```ts
isWater(x, z): boolean          // open water visible at x/z (level above the terrain)
levelAt(x, z): number | null    // water surface elevation
depthAt(x, z): number | null
flowAt(x, z): { x, z } | null   // m/s, world axes (useful for buoyancy / floating debris)
bodyAt(x, z): WaterBody | null  // { name, type, albedo, ext, speed, ... }
bodies, meshes, material, reflection
```

## Assets and licences

All textures are generated procedurally by `pipeline/water_textures.py`: FFT spectra for the ripple
and wind-wave normal maps, and Worley/fbm noise for foam and noise. They are CC0 by construction.
Together they come to 1.3 MB in `public/textures/water/`. The water data is 2.5 MB.

## Known limitations

* The shoreline is wherever the terrain crosses the water plane, so it depends on the terrain carve
  being rebuilt after every water pipeline run.
* Pier wakes need the roads module's piers. The headworks weir's concrete barrage and gates are not
  modelled here; the water side (pool, 1.5 m drop, white-water band) is.
* One reflection plane is used per frame. Water bodies at very different levels in the same view
  fall back to IBL reflections.
* Swimming pools are points only in Overture, so they are not rendered.
* No screen-space refraction distortion. The bed is seen through alpha blending, which is fine for
  the very turbid local water.
