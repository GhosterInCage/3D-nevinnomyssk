# Module `buildings`

Every building footprint in the 20 km region is rendered in 3D: about 57 100 cleaned Overture Maps footprints, a mix of OpenStreetMap and Microsoft ML. The pipeline infers each building's height, typology, roof and materials. In the browser, the buildings are meshed per 512 m tile in Web Workers and drawn with one procedural PBR material, a `MeshStandardMaterial` extended through `onBeforeCompile`. Shadows, CSM, fog, the environment map and the path tracer's standard-material path all keep working.

## Files

| file | role |
|---|---|
| `pipeline/build_buildings.py` | main build: road filter, level model, typology rules, roofs and orientation, binary writer |
| `pipeline/buildings_clean.py` | loads and cleans footprints: projection, `make_valid`, simplification, sliver removal, de-duplication, squaring |
| `pipeline/buildings_roads.py` | drops or trims Microsoft-ML footprints that sit on road carriageways or rail beds (rule shared with `roads`) |
| `pipeline/buildings_geom.py` | geometry helpers: orthogonalisation, maximal-rectangle roof decomposition, MRR |
| `pipeline/buildings_features.py` | per-building features: shape, DSM relief, summer and winter Sentinel-2 shadow profiles, land use, roads, density |
| `pipeline/buildings_s2winter.py` | fetches clear, low-sun winter Sentinel-2 L2A scenes (sun elevation 22–32°) |
| `pipeline/buildings_fences.py` | infers street and side fences of private-house plots |
| `pipeline/buildings_textures.py` | generates `public/textures/buildings/noise.bin`: 512² RGBA8 tileable noise, raw, CC0, procedural |
| `src/modules/buildings/index.ts` | module entry: loading, ground sampling, spatial index, worker pool, tile streaming and LOD, service, colliders |
| `src/modules/buildings/format.ts` | binary format reader, shared with the worker |
| `src/modules/buildings/mesher.ts` | geometry generation: walls, flat and pitched roofs, parapets, balconies, canopies, gas pipes, roof equipment, house details, fences |
| `src/modules/buildings/shader.ts` | GLSL: facades, windows, interiors, roofing, night lighting, street-lamp light on facades |
| `src/modules/buildings/material.ts` | material factory with a chain-safe `onBeforeCompile`, street-lamp variant |
| `src/workers/buildings.worker.ts` | mesher worker (also fetches and gunzips the data file) |

Rebuild with `python3 pipeline/build_buildings.py`. Add `--refresh` to recompute the cached cleaning and feature stages in `data/processed/`. A full run takes about 2 minutes on an idle machine, or about 6 minutes with `--refresh`. It needs `scikit-learn`. The build reads only raw Overture parquet and rasters, so it doesn't depend on the other modules' outputs.

## Pipeline

1. **Cleaning.** Footprints are projected to the local frame and clipped to the region. Underground buildings are dropped. Each footprint goes through `make_valid` and has its multipolygons exploded. Simplification uses 0.15 m for OSM and 0.45 m for ML footprints, which are pixel-derived. Holes under 12 m² are removed. Slivers are dropped: area under 8 m², narrow side under 1.8 m, or very thin and long.

   De-duplication checks ML against OSM (OSM wins), ML against ML, and OSM against OSM (exact or near-contained duplicates). Remaining partial overlaps are subtracted from the ML footprint.

   Near-orthogonal footprints are then squared. Edges within ±12° of the dominant axes are snapped (±9° for OSM), and jogs under 0.6 m are removed. The result is accepted only if IoU > 0.86 (0.9 for OSM). About 99 % are squared, and 92 % end up as 4-vertex rectangles. Holes (courtyards) are kept.

2. **Roads and rail (cross-module rule).** Carriageways are the drivable Overture segments buffered by `build_roads.py` width / 2 − 0.5 m (tunnels excluded). Rail beds are the centreline ± 2.2 m.
   - An ML footprint with more than 30 % of its area on a carriageway or rail bed is dropped. This removes 308, mostly sheds in dacha streets, bridge decks and platform canopies.
   - An ML footprint with 8–30 % on them has the carriageway subtracted. It's kept if the remaining piece is at least 60 % of the original and not a sliver (522 trimmed).
   - OSM footprints are never touched.

3. **Features.** Each building gets these features:
   - area, minimum-rotated-rectangle length and width, elongation, compactness, rectangularity, vertex count
   - Copernicus DSM relief: local max minus local 15th percentile at several scales, plus the footprint max and mean
   - summer Sentinel-2 shadow contrast
   - **winter Sentinel-2 shadow profiles**: brightness behind the anti-sun edge of the footprint, sampled in height-equivalent bins `h = d·tan(sun elevation)` and averaged over the winter scenes, plus integrated darkness
   - NDVI, WorldCover built-up fraction, neighbour counts within 60, 150 and 300 m, neighbour area statistics
   - Overture land-use class of the polygon containing the footprint
   - distances to major roads, minor roads and rail, and distance to the centre

   With the sun 22° high, a 5-storey block casts a shadow about 40 m long and a 9-storey block about 72 m. That makes the winter shadow profiles the strongest open height signal available at 10 m resolution.

4. **Level model.** A `HistGradientBoostingClassifier` with balanced class weights is trained on the 932 OSM buildings that carry `building:levels`. It predicts storey buckets {1, 2, 3, 4, 5, 6–8, 9, 10–12, 13+}. Validation uses spatial GroupKFold with 5 folds of 700 m blocks, so neighbouring identical blocks never leak between folds. The current report, also stored in `meta.json` under `model`:

   | metric | value |
   |---|---|
   | bucket accuracy | 0.72 |
   | within one bucket | 0.94 |
   | accuracy, 3+ storeys | 0.65 |
   | recall, 1-storey (n = 514) | 0.90 |
   | recall, 2-storey (n = 170) | 0.30 (usually predicted as 1) |
   | recall, 5-storey (n = 144) | 0.90 |
   | recall, 9-storey (n = 37) | 0.60 |

   Predictions are then gated by shape:
   - 4 or more storeys needs at least 200 m², at least 9 m depth and at least 16 m length.
   - 9 or more storeys needs P(tall) ≥ 0.45.
   - Labelled OSM levels and heights always win.

   The resulting distribution is about 51 900 buildings with 1 storey, 4 000 with 2, 300 with 3, 530 with 5, 160 with 9, and 22 with 10–16.

5. **Typology rules.** The OSM class, subtype and name come first: schools, kindergartens, hospitals, churches, shops, garages, greenhouses, and roof-only canopies. Overture land use comes next: garages, allotments, industrial, farmyard, cemetery and others. Then come garage-row detection (narrow, elongated rows in clusters) and the level model plus footprint shape.

   The rules produce 22 typologies: house, outbuilding, garage row, dacha, khrushchevka, panel 9-storey, tower, stalinka, low-rise apartments, school, kindergarten, public, commercial, mall, industrial, warehouse, agricultural, greenhouse, religious, modern apartments, utility and kiosk.

   Each typology sets:
   - floor height, socle and parapet
   - roof shape: flat, gable, hip, pyramid or shed, with pitch and overhang
   - facade style (16 styles)
   - wall colour, drawn from regional palettes: silicate or red brick, panel greys and beiges, stalinka ochres, and so on
   - roof material (8 types) and colour
   - flags: balconies, ground-floor shops

   Industrial heights come from the shadow profile, and from the DSM for large halls. The entrance side faces the nearest minor or service road. The shop side faces the nearest major road, for apartment blocks within 3 km of the centre.

   Random choices use a per-building stream seeded by the Overture id plus the rounded centroid. That keeps colours and materials stable across rebuilds.

6. **Plot fences.** Each private house is attached to its nearest drivable road within 45 m. Plots run along the street to the midpoints between neighbouring houses. The street fence line uses one offset per road side, with a gate and side fences for each plot.

   Fences are clipped against footprints and carriageways and split into pieces of at most 8 m, so they follow the terrain. Types are corrugated steel sheet, sheet with brick pillars, wooden planks and metal picket. The result is about 133 k pieces.

7. **Pitched roofs.** Orthogonal footprints are covered by up to 4 overlapping maximal rectangles, found by a greedy set cover on the vertex grid. Each rectangle gets its own hip, gable or pyramid roof at a common pitch. Where two roofs interpenetrate, the result looks like a correct cross-gabled or L-shaped roof. Non-orthogonal footprints use the minimum rotated rectangle if IoU > 0.85. Otherwise they get a flat roof.

## Data format (`public/data/buildings/`)

- `buildings.bin.gz` (about 4.3 MB) holds a 64-byte header, `u32 tileStart[nTiles+1]`, 52-byte records, `i16` vertices, `u16` ring lengths, 12-byte roof-part records, `u32 fenceStart[nTiles+1]` and 16-byte fence records. The field-by-field layout is in the docstring of `pipeline/build_buildings.py` and in `src/modules/buildings/format.ts`.
  - Buildings are sorted by 512 m tile, 40×40 tiles over the region.
  - Vertices are stored in cm (2 cm for very large footprints) relative to the building centre, in the world x/z frame with z pointing south.
  - Outer rings have negative signed area in (x, z), so the outward normal of edge A→B is (−dz, dx).
  - A record holds height, roof height, levels, typology, roof shape and pitch, overhang, wall style, roof material, wall and roof sRGB, seed, flags, entrance and street directions, floor height, min height, socle and name index.
- `ids.bin.gz` holds the first 16 hex digits of each Overture id, plus the OSM id and element type. It is loaded lazily.
- `meta.json` holds typology names, the building-name table, the model validation report and statistics.

## Runtime

- **Ground.** On the main thread, the ground under each footprint is sampled from `ctx.heightfield` at every vertex, every edge midpoint and the centroid, giving `gMin` and `gMax`. The floor base is `max(gMin, gMax − 1.2) + socle`. Walls start 1 m below `gMin`, so slopes never show gaps. The module declares `after: ['terrain']`.
- **Loading.** The data file is fetched and gunzipped inside a worker. The 1 MB noise texture is fetched on the main thread. Under SwiftShader the main thread may only get one task per rendered frame, so the initial meshing goes out as one batch per worker. The timing log reads `[buildings] timing(ms) …`.
- **Workers.** A pool of `hardwareConcurrency − 1` workers (at most 4) each holds a copy of the dataset.
  - The **base** mesh covers 2×2 data tiles (1024 m) and holds walls and roofs, including gable walls and pitched roofs with overhang. It is shown within `profile.drawDistance`.
  - The **detail** mesh of a tile is built within 200, 400, 560 or 800 m (low, medium, high, ultra), or 60 % of that above 400 m altitude, and none above 900 m. It adds:
    - parapets with caps and inner faces
    - loggias and balconies: slab, parapet (4 finishes) and irregular glazing (4 frame types)
    - entrance canopies with lamps and steps
    - AC units, satellite dishes and shop sign boards
    - **yellow low-pressure gas pipes** along the entrance facade of houses (under the eaves, with drop and meter box) and 2–5-storey blocks (above the ground-floor windows)
    - roof equipment: elevator machine rooms on 9-storey blocks, vent stacks, TV antennas, clerestory monitors on large halls
    - eaves soffits, fascia boards and gutters
    - chimneys, antennas and downpipes on houses
    - plot fences with posts, brick pillars and gates
- **Vertex layout.** Each vertex has `position`, `normal` and `uv`, plus these attributes:
  - `aA` u8×4: kind, style, seed, levels
  - `aC` u8×4 normalised: sRGB colour and an aux byte
  - `aW` u16×4: wall length in cm, bay width in cm, `nCols | secCols << 8`, `flags | floorH << 8`
  - `color`: a linear average albedo, used by the path-tracer proxy

  For walls, `uv` is (metres along the wall, metres above the floor base). For pitched roofs it is (metres along the eave, metres up the slope).
- **Shader.** All surface detail is procedural, with three distance levels:
  - **Near (< 6 cm/px).** Window grids are centred per wall. Windows are recessed with parallax: the reveals get proper normals and the metal sills protrude.
    - Glass reflects the environment map with a small per-pane tilt.
    - Behind the glass, interior mapping draws rooms (wallpaper, furniture, carpets, floor, ceiling), with tulle and curtains in front.
    - Staircase windows sit half a floor above the entrance doors.
    - Facade materials include panel seams with sealant patches, running-bond bricks with per-brick colour, plaster, siding, corrugated cladding, garage gates, stalinka rustication, cornices and window surrounds, and a socle with basement vents.
    - Weathering adds dirt streaks and grime.
  - **Mid (6 cm/px up to a 2.5 px window cell).** Flat panes, but frames, mullions and transoms are still drawn as anti-aliased lines, with a hint of curtains. This avoids the flat coloured-tile look.
  - **Far.** Windows fold into the average facade colour, which avoids moiré.

  Roofing profiles are normal perturbations: corrugated sheet, metal tile, asbestos slate with lichen, standing seam with rust streaks on single sheets, and greenhouse glazing. Flat roofs are bitumen with patches.

  Beyond the detail radius, loggias are drawn as faux loggias in the shader.
- **Night.**
  - Windows light up from a hashed fraction of flats that depends on the hour: 42 % in the evening, 8 % before dawn. Private houses get 0.6 of that.
  - Lamps are warm or cool, with occasional TV blue. Emissive is about 0.08–0.13 × `env.night`, following the integration convention.
  - Entrance lamps (bulbs, 2 × night), the glow on the wall around them, and shop signs are emissive.
  - **Street lamps light the facades.** When the `roads` service is present, the material switches to a `BLD_LAMPS` variant. It shares the roads lamp grid (`roads.uniforms.rsLamp*`, 16 m cells, up to two lamps each) and adds each lamp as a direct light.
    - The lamp head sits 9 m above the ground; the ground comes from `HeightField.texture`.
    - It uses the same cut-off as the roads' ground pools, a facing test on the geometric normal, and a reduced contribution on roofs.
- **Service `buildings`.**
  - `count`
  - `hideById(ids)` returns a Promise with the number hidden. It accepts Overture ids (full or 16-hex prefix), `w123` or `r123` OSM ids, and `#index`.
  - `hideInPolygon(ringXZ)` hides buildings whose centroid lies inside the polygon, or whose vertices are mostly inside it.
  - `infoAt(x, z)` returns `{index, id, name, levels, height, cls, base, top, labelled}`.
  - `query(x, z, r)`, `footprint(i)`, `roofAt(x, z)`, `idOf(i)`, `info(i)`, `ready`.
  - `stats()` returns `{meshes, visible, triangles, visibleTriangles, detailChunks, hidden}`.

  Hiding rebuilds only the affected chunks. It was verified with the landmarks module's id list, and with `hideById(['#i'])` and `hideInPolygon` from the shot harness.
- **Colliders.** `ctx.registerColliders({id: 'buildings'})` returns prisms. The `ring` is the outer ring as world `[x0, z0, x1, z1, …]`, `minY` is `gMin − 1` (or the floor base plus min height), and `maxY` is the eave plus half the roof. Keys have the form `bld:<index>`.
- **Path tracer.** Each chunk mesh has a `color` attribute holding a linear average albedo (walls darkened by their windows), and `userData.ptMaterial` is a `MeshStandardMaterial` with `vertexColors`.
- **Isolated runs.** With `?only=buildings` and the sky module absent, the module adds its own simple sun, hemisphere light and background. This is the only case where it touches lighting.

## Performance

- **Base meshes** for the whole city: about 822 k triangles in 268 chunks. Meshing takes about 1–3 s of CPU in total, spread over the workers.
- **Detail meshes**: about 175 k triangles for the tiles around a street-level camera at medium quality, and at most about 100 k per 512 m tile in the densest micro-districts.
- **Total**: about 1.0 M triangles installed at street level, of which about 350 k were in the frustum in the test view (`stats()`).
- **Draw calls**: one per visible chunk per pass. Chunks are frustum-culled and distance-culled.
- **Material programs**: one main program, plus one variant once street lamps are enabled, plus the shadow-depth programs.

## Known limitations

- The level model under-predicts 2-storey private houses (recall 0.30), because 1- and 2-storey houses look almost the same in 10–30 m open data.
- The window grid is procedural: bay widths and entrance positions follow typology rules, not the real facades.
- Street-lamp light on facades is not shadowed. A lamp can light the street-facing wall of a house standing behind another house, within 32 m.
- Under SwiftShader, loading the dev-server worker module and handing the meshes back to a busy main thread takes most of the load time: 40–100 s in the harness, versus about 3–5 s of worker CPU.

## Licences

- Footprints: © OpenStreetMap contributors (ODbL), and Microsoft ML Building Footprints (ODbL), both via Overture Maps.
- Road and rail centrelines used by the filter: Overture transportation (ODbL).
- Copernicus DEM GLO-30: © DLR/Airbus, provided under COPERNICUS by the European Union and ESA.
- Sentinel-2: Copernicus Sentinel data 2023–2026.
- `noise.bin` is generated procedurally (CC0). All other facade and roof detail is procedural GLSL, with no external textures.
