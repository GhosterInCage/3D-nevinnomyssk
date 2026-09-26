# Module `buildings`

Every building footprint in the 20 km region is rendered in 3D: 57 419 cleaned Overture Maps footprints, a mix of OpenStreetMap and Microsoft ML. The pipeline infers each building's height, typology, roof and materials. In the browser, the buildings are meshed per 512 m tile in Web Workers and drawn with one procedural PBR material, a `MeshStandardMaterial` extended through `onBeforeCompile`.

## Files

| file | role |
|---|---|
| `pipeline/build_buildings.py` | main build: level model, typology rules, roofs and orientation, binary writer |
| `pipeline/buildings_clean.py` | loads and cleans footprints: projection, `make_valid`, simplification, sliver removal, de-duplication, squaring |
| `pipeline/buildings_geom.py` | geometry helpers: orthogonalisation, maximal-rectangle roof decomposition, MRR |
| `pipeline/buildings_features.py` | per-building features: shape, DSM relief, summer and winter Sentinel-2 shadow profiles, land use, roads, density |
| `pipeline/buildings_s2winter.py` | fetches five clear, low-sun winter Sentinel-2 L2A scenes (sun elevation 22–32°) |
| `pipeline/buildings_fences.py` | infers street and side fences of private-house plots |
| `pipeline/buildings_textures.py` | generates `public/textures/buildings/noise.bin`: 512² RGBA8 tileable noise, raw, CC0, procedural |
| `src/modules/buildings/index.ts` | module entry: loading, ground sampling, spatial index, worker pool, tile streaming and LOD, service, colliders |
| `src/modules/buildings/format.ts` | binary format reader, shared with the worker |
| `src/modules/buildings/mesher.ts` | geometry generation: walls, flat and pitched roofs, parapets, balconies, canopies, roof equipment, house details |
| `src/modules/buildings/shader.ts` | GLSL: facades, windows, interiors, roofing, night lighting |
| `src/modules/buildings/material.ts` | material factory with a chain-safe `onBeforeCompile` |
| `src/workers/buildings.worker.ts` | mesher worker |

Rebuild with `python3 pipeline/build_buildings.py`. Add `--refresh` to recompute the cached cleaning and feature stages in `data/processed/`. A full run takes about 2 minutes, or about 6 minutes with `--refresh`. It needs `scikit-learn` (`pip install scikit-learn`).

## Pipeline

1. **Cleaning.** Footprints are projected to the local frame and clipped to the region. Underground buildings are dropped. Each footprint goes through `make_valid` and has its multipolygons exploded. Simplification uses 0.15 m for OSM and 0.45 m for ML footprints, which are pixel-derived. Holes under 12 m² are removed. Slivers are dropped: area under 8 m², narrow side under 1.8 m, or very thin and long.

   De-duplication checks ML against OSM (OSM wins), ML against ML, and OSM against OSM (exact or near-contained duplicates). Remaining partial overlaps are subtracted from the ML footprint. Overture had already conflated almost all of them: 5 duplicates were dropped and 124 footprints were trimmed.

   Near-orthogonal footprints are then squared. Edges within ±12° of the dominant axes are snapped (±9° for OSM), and jogs under 0.6 m are removed. The result is accepted only if IoU > 0.86 (0.9 for OSM). 57 105 of 57 419 were squared, and 92 % end up as 4-vertex rectangles. Holes (courtyards) are kept.

2. **Features.** Each building gets these features:
   - area, minimum-rotated-rectangle length and width, elongation, compactness, rectangularity, vertex count
   - Copernicus DSM relief: local max minus local 15th percentile at several scales, plus the footprint max and mean
   - summer Sentinel-2 shadow contrast
   - **winter Sentinel-2 shadow profiles**: brightness behind the anti-sun edge of the footprint, sampled in height-equivalent bins `h = d·tan(sun elevation)` and averaged over five scenes, plus integrated darkness
   - NDVI, WorldCover built-up fraction, neighbour counts within 60, 150 and 300 m, neighbour area statistics
   - Overture land-use class of the polygon containing the footprint
   - distances to major roads, minor roads and rail, and distance to the centre

   With the sun 22° high, a 5-storey block casts a shadow about 40 m long and a 9-storey block about 72 m. That makes the winter shadow profiles the strongest open height signal available at 10 m resolution.

3. **Level model.** A `HistGradientBoostingClassifier` with balanced class weights is trained on the 932 OSM buildings that carry `building:levels`. It predicts storey buckets {1, 2, 3, 4, 5, 6–8, 9, 10–12, 13+}. Validation uses spatial GroupKFold with 700 m blocks, so neighbouring identical blocks never leak between folds:

   | metric | value |
   |---|---|
   | bucket accuracy | 0.74 |
   | within one bucket | 0.93 |
   | recall, 5-storey | 0.91 |
   | recall, 9-storey | 0.57 (9 and 10 together: 0.70) |
   | recall, 1-storey | 0.91 |
   | recall, 2-storey | 0.35 (usually predicted as 1) |

   Without the winter-shadow features, bucket accuracy is 0.68 and 9-storey recall is 0.32. The full report is in `public/data/buildings/meta.json` under `model`. Predictions are gated by shape: 4 or more storeys requires at least 200 m², at least 9 m depth and at least 16 m length, and 9 or more storeys requires P(tall) ≥ 0.45.

4. **Typology rules.** The OSM class, subtype and name come first: schools, kindergartens, hospitals, churches, shops, garages, greenhouses, and roof-only canopies. Overture land use comes next: garages, allotments, industrial, farmyard, cemetery and others. Then come garage-row detection (narrow, elongated rows in clusters) and the level model plus footprint shape.

   The rules produce 22 typologies: house, outbuilding, garage row, dacha, khrushchevka, panel 9-storey, tower, stalinka, low-rise apartments, school, kindergarten, public, commercial, mall, industrial, warehouse, agricultural, greenhouse, religious, modern apartments, utility and kiosk.

   Each typology sets:
   - floor height, socle and parapet
   - roof shape: flat, gable, hip, pyramid or shed, with pitch and overhang
   - facade style (16 styles)
   - wall colour, drawn from regional palettes: silicate or red brick, panel greys and beiges, stalinka ochres, and so on
   - roof material (8 types: bitumen, gravel, corrugated, metal tile, asbestos slate, standing seam, glass, tiles) and colour
   - flags: balconies, ground-floor shops

   Industrial heights come from the shadow profile, and from the DSM for large halls. The entrance side faces the nearest minor or service road, which is usually the courtyard driveway. The shop side faces the nearest major road, for apartment blocks within 3 km of the centre.

5. **Plot fences.** Plot boundaries are not in the open data, so the pipeline infers them. Each private house is attached to its nearest drivable road within 45 m. Along each road side, plots run to the midpoints between neighbouring houses, extending 4–14 m to either side of the house.

   The street fence line uses one offset per road side: the median distance of the house fronts, clamped between the road half-width plus verge (the same widths as `build_roads.py`) and 4 m beyond that. The fence is interrupted where the house front stands on the street line.

   Each plot gets a gate and short side fences. All pieces are clipped against footprints and carriageways and split into pieces of at most 8 m, so the fence follows the terrain.

   Fence types are corrugated steel sheet (62 %), sheet with brick pillars (10 %), wooden planks (18 %) and metal picket (10 %), with typical regional colours. The result is 26 919 houses on 4 445 street sides.

6. **Pitched roofs.** Orthogonal footprints are covered by up to 4 overlapping maximal rectangles, found by a greedy set cover on the vertex grid. Each rectangle gets its own hip, gable or pyramid roof at a common pitch. Where two roofs interpenetrate, the result looks like a correct cross-gabled or L-shaped roof. Non-orthogonal footprints use the minimum rotated rectangle if IoU > 0.85. Otherwise they get a flat roof.

## Data format (`public/data/buildings/`)

- `buildings.bin.gz` holds a 64-byte header, `u32 tileStart[nTiles+1]`, 52-byte records, `i16` vertices, `u16` ring lengths and 12-byte roof-part records. The field-by-field layout is in the docstring of `pipeline/build_buildings.py` and in `src/modules/buildings/format.ts`.
  - Buildings are sorted by 512 m tile, 40×40 tiles over the region.
  - Vertices are stored in cm relative to the building centre, in the world x/z frame with z pointing south.
  - Outer rings have negative signed area in (x, z), so the outward normal of edge A→B is (−dz, dx).
  - File size is about 3.0 MB.
- Version 2 adds plot fences after the roof parts: `u32 fenceStart[nTiles+1]`, then one 16-byte record per fence. A record holds `i16` x0, z0, x1, z1 in cm relative to the tile centre, a `u8` type (0 sheet, 1 sheet with brick pillars, 2 wood, 3 picket, 4 gate), a `u8` height in dm, `rgb`, a `u8` seed and 2 reserved bytes. There are about 133 k fence pieces, and the file is about 4.3 MB.
- `ids.bin.gz` holds the first 16 hex digits of each Overture id, plus the OSM id and element type. It is loaded lazily after initialisation.
- `meta.json` holds typology names, the building-name table, the model validation report and statistics.

## Runtime

- **Ground.** On the main thread, the ground under each footprint is sampled from `ctx.heightfield` at every vertex and edge midpoint and at the centroid, giving `gMin` and `gMax`. The floor base is `max(gMin, gMax − 1.2) + socle`. Walls start 1 m below `gMin`, so slopes never show gaps. The module declares `after: ['terrain']`, so terrain edits made during the terrain module's init are respected.
- **Loading.** The data file and the noise texture are fetched and gunzipped inside a worker. Under software GL, the main thread may only get one task per rendered frame, so keeping this work off the main thread matters. The initial meshing goes out as one batch per worker, which means one reply per worker. The timing log reads `[buildings] timing(ms) …`.
- **Workers.** A pool of `hardwareConcurrency − 1` workers (at most 4) each holds a copy of the dataset.
  - The **base** mesh of a tile holds walls and roofs, including gable walls, shed walls and pitched roofs with overhang. Every tile has a base mesh, and it is shown within `profile.drawDistance`.
  - The **detail** mesh of a tile is built within a radius of 220, 420, 650 or 900 m (low, medium, high, ultra), reduced when the camera is high above the ground. It adds:
    - parapets with caps and inner faces
    - loggias and balconies: slab, parapet (4 finishes) and irregular glazing (4 frame types)
    - entrance canopies with lamps and steps
    - AC units and shop sign boards
    - roof equipment: elevator machine rooms on 9-storey blocks, vent stacks, TV antennas
    - eaves soffits, fascia boards and gutters
    - chimneys, antennas and downpipes on houses
    - satellite dishes, clerestory roof monitors on large industrial halls, and **plot fences** (posts or brick pillars, gates)
- **Vertex layout.** Each vertex has `position`, `normal` and `uv`, plus three custom attributes:
  - `aA` u8×4: kind, style, seed, levels
  - `aC` u8×4 normalised: sRGB colour and an aux byte
  - `aW` u16×4: wall length in cm, bay width in cm, `nCols | secCols << 8`, `flags | floorH << 8`

  For walls, `uv` is (metres along the wall, metres above the floor base). For pitched roofs it is (metres along the eave, metres up the slope).
- **Shader.** All surface detail is procedural in the fragment shader:
  - Window grids are centred per wall. Windows are recessed with parallax: the reveals get proper normals, and the metal sills protrude.
  - The glass reflects the environment map with a small per-pane tilt. When no environment map is present, a procedural sky and skyline stands in.
  - Behind the glass, interior mapping draws rooms (wallpaper, furniture, carpets, floor, ceiling), with tulle and curtains in front.
  - Staircase windows are offset by half a floor above entrance doors.
  - The shopfronts are drawn procedurally too, along with panel seams with sealant patches, running-bond bricks with per-brick colour, plaster, siding, corrugated cladding, garage gates, stalinka rustication, cornices and window surrounds, a socle with basement vents, and dirt streaks and grime.
  - Roofing profiles are rendered as normal perturbation: corrugated sheet, metal tile, asbestos slate with lichen, standing seam and greenhouse glazing. Flat roofs get bitumen with patches.
  - Private houses get painted window trims (nalichniki), shutters on some houses, and a door. Industrial walls get sectional doors.
  - The shader has three distance levels, measured in metres per pixel:
    - near: full detail
    - mid (> 6 cm/px): flat window rectangles and pattern averages, with explicit-LOD noise lookups only
    - far (window cell < 2.5 px): windows fold into the average facade colour, which avoids moiré
  - Beyond the detail radius, loggias are drawn as faux loggias in the shader.
  - At night, windows light up from a hashed fraction of rooms that depends on the hour. Lamps are warm or cool, with occasional TV blue. Entrance lamps, a glow on the wall around them, and shop signs are emissive, scaled by `ctx.env.night`.
- **Service `buildings`.**
  - `hideById(ids)`, returns a Promise. It accepts Overture ids (full or 16-hex prefix), `w123` or `r123` OSM ids, and `#index`.
  - `hideInPolygon(ringXZ)` hides buildings whose centroid lies inside the polygon, or whose vertices are mostly inside it.
  - `infoAt(x, z)` returns `{index, id, name, levels, height, cls, base, top, labelled}`.
  - `count`, `query(x, z, r)`, `footprint(i)`, `roofAt(x, z)`, `idOf(i)`, `info(i)` and `ready`.

  Hiding rebuilds only the affected tiles.
- **Colliders.** `ctx.registerColliders({id: 'buildings'})` returns prisms. The `ring` is the outer ring as world `[x0, z0, x1, z1, …]`, `minY` is `gMin − 1`, and `maxY` is the eave plus half the roof. Keys have the form `bld:<index>`.
- **Path tracer.** Each chunk mesh has a `color` attribute holding a linear average albedo (walls darkened by their windows), and `userData.ptMaterial` is a `MeshStandardMaterial` with `vertexColors`. The procedural shader itself is not visible to the path tracer.
- **Isolated runs.** With `?only=buildings` and the sky module absent, the module adds its own simple sun and hemisphere lights.

## Performance

Measured in Node with the same mesher:

- **Base meshes** for the whole city: about 825 k triangles and 1.77 M vertices. Meshing takes about 1 s of CPU in total, spread over the workers.
- **Detail meshes**: at most about 100 k triangles per 512 m tile in the densest micro-districts, and about 65 k at the centre.
- **Draw calls**: one per visible tile per pass. There are 713 non-empty tiles in total. Tiles are frustum-culled and distance-culled.

## Licences

- Footprints: © OpenStreetMap contributors (ODbL), and Microsoft ML Building Footprints (ODbL), both via Overture Maps.
- Copernicus DEM GLO-30: © DLR/Airbus, provided under COPERNICUS by the European Union and ESA.
- Sentinel-2: Copernicus Sentinel data 2023–2026.
- `noise.bin` is generated procedurally (CC0).
