# Module `traffic`

Life in the city: moving cars, marshrutkas, buses and trucks on the road graph, parked cars in
courtyards / along kerbs / on parking lots, trains on the railway (plus wagons standing on the
station yard and on the Azot sidings), pedestrians on footways and sidewalks, flocks of pigeons and rooks.
Provides the `traffic` service.

## What is built

| Layer | Source | Runtime |
|---|---|---|
| Moving road traffic | `roads` service graph (preferred: same node ids, bridge decks, rendered carriageway heights, traffic signals); fallback `traffic/graph.bin.gz` built from Overture when `roads` is absent (`?only=traffic`) | ~300 (low) to ~1800 (ultra) vehicles in a radius of 600–2400 m around the camera (grows with altitude); structure-of-arrays state |
| Parked cars | `traffic/parked.bin.gz` (~24k): Overture parking lots filled in rows of 2.6 × 5.2 m stalls, courtyard driveways of apartment districts (perpendicular / parallel), kerbs in apartment districts, verges in the private sector; building / water / rail / carriageway / junction clearance checked in the pipeline | streamed in 128 m cells around the camera (260–1200 m) |
| Trains | `traffic/rail.json.gz`: rail topology from Overture connectors, routes Armavir ↔ Mineralnye Vody (main line, both tracks, right-hand running) and the Cherkessk branch, clipped to the region, with station / halt stops (Nevinnomysskaya, Zelenchuk, Niva, …) and bridge ranges | long-distance trains (EP1-type loco + 11–17 RZD coaches, stop at Nevinnomysskaya), ED9M suburban EMUs (stop everywhere), freight trains (2-section 2ES5K + 35–60 tank cars / fertilizer hoppers / gondolas / box cars / containers); 40 km/h through the station; one passenger train is standing at Nevinnomysskaya at start-up |
| Wagons on sidings | `rail.json.gz` sidings: tank cars and hoppers on the Azot works tracks, mixed wagons on the station yard | static instances, 1.5–5 km radius |
| Pedestrians | footway / path / pedestrian edges + sidewalks of urban streets (density raster `traffic/density.png`) + people waiting at bus stops | up to 120/350/700 figures within 170–380 m, walk cycle in the vertex shader |
| Birds | – | 3 pigeon flocks (8–25 m up) + 2 rook flocks (40–120 m) around the camera, flapping / gliding, hidden at night and in rain |

### Simulation (vehicles.ts)

* **Lanes**: right-hand traffic. Lanes per direction from the edge's lane count (oneway: all lanes);
  lane k (0 = kerb lane) offset `(n − k − 0.5) · width / 2n` from the centre line; narrow two-way roads
  (1 lane) use `max(0.9, width/4)`. Tangents are blended ±3 m around polyline vertices so lateral
  offsets stay continuous.
* **Junctions**: every lane is trimmed at its end nodes (junctions ≥ 3 drivable edges: widest half
  width + 1.2 m; signalised approaches: the stop line = signal head distance); vehicles cross the
  junction on a cubic Bézier connector between the two lane ends (turns slow to 3–9 m/s, U-turns at
  dead ends). Route choice prefers straight on and major roads; buses/trucks avoid residential streets;
  broken one-way chains are driven through rather than getting stuck.
* **Car following**: Intelligent Driver Model (a = type accel, b = 2.4 m/s², T = 1.25 s, s0 = 2 m).
  Leaders are found with a spatial hash (12 m cells, counting sort, no allocations) looking 12–50 m
  ahead: same-direction vehicles within a lane-width corridor (merging streams are tie-broken so one
  always yields), crossing traffic near junctions yields by road class, then priority to the right;
  vehicles already inside a junction have priority; after 7 s of waiting crossing traffic is ignored
  (no gridlock). Validated headless (`simulate()`): 10 simulated minutes, 300 vehicles, 0 vehicles
  waiting > 75 s.
* **Signals**: red / yellow phases from `roads.signalState(phase, ctx.env.elapsed)` (same clock as the
  rendered signal heads) stop vehicles at the stop line.
* **Stops**: buses and marshrutkas pull over to the kerb at bus stops (Overture `bus_stop` points
  attached to the nearest edge, served on the right-hand side) and dwell 8–26 s.
* **LOD / cost**: vehicles < 180 m update every frame, < 450 m every 2nd frame, beyond every 4th
  (accumulated dt, sub-stepped ≤ 0.12 s); pitch from front/rear axle heights near the camera; out-of-range
  vehicles are recycled and respawned out of view; teleports (> 250 m jumps) refill the whole radius at
  once so screenshots are populated immediately. Traffic density follows road class and the time of day.

### Models (models.ts, geom.ts, trains.ts, peds.ts, birds.ts)

All geometry is procedural (no textures): lofted bodies through cross-section stations with
auto-smoothed normals, one uber-material per fleet (`materials.ts`: MeshPhysicalMaterial +
`onBeforeCompile`) driven by per-vertex `aMat = (roughness, metalness, flags, emissive code)` and
per-instance `iColor` (paint) / `iData` (wheel angle, brake / lamp state, metallic, dirt). Paint has
clearcoat and a height-dependent dirt/dust gradient; glass is dark, smooth and clearcoated (reflects the
sky environment map); wheels (tyre, rim with openings, hub) spin in the vertex shader around `aWheel`.

| type | LOD0 / LOD1 / LOD2 triangles |
|---|---|
| VAZ-2107, VAZ-2114, Lada Granta, Vesta/Solaris/Rio, Kalina/Rio X, Lada Niva 4x4, crossover | ~900–1000 / 290–330 / 120–150 |
| UAZ-452 "Bukhanka", GAZelle marshrutka (yellow/white, route sign), GAZelle with tent | ~900–1000 / 310–370 / 110–170 |
| PAZ-3205, LiAZ-5256 (two-tone, lit windows, glazed doors), KamAZ-65115 dump truck | ~1050–1250 / 360–490 / 90–160 |
| rolling stock: 2ES5K section, EP1, RZD coach, ED9M head/intermediate car, tank car, hopper, gondola, box car, flat + 40' container | 650–1500 / 220–870 |

LOD distances (medium): 90 / 260 m (moving), 85 / 210 m (parked). LOD0/1 cast shadows, LOD2 does not.
One draw call per (type, LOD) with instances; typically 30–60 draw calls for the whole module.

**Lights**: headlights on by day (Russian daytime-running-light rule, dim) and bright at night;
tail lights at night, brake lights when decelerating or standing; buses/EMUs/coaches light their
windows at night; route-number LED sign on buses; the trailing cab of an EMU shows tail lamps; parked cars
are dark. At night additive headlight pools are drawn on the road in front of cars within 320 m
(`traffic-beams`, excluded from path tracing).

**Pedestrians**: three figure types (man in jacket/trousers, woman in coat/skirt with long hair,
older woman with long coat and headscarf), ~450 triangles each, bones for legs/arms animated in the
vertex shader, per-instance jacket / trousers colours, skin / hair tone from a seed.

## Service `traffic`

```ts
const t = ctx.get('traffic');
t.vehicles / t.parked / t.pedestrians     // live counts
t.nearestVehicle(x, z)                     // { type, speed km/h, x, z } | null
t.setEnabled(on)                           // hide + stop everything
t.clearInPolygon(ring)                     // hide parked cars inside [x0,z0,x1,z1,...]
t.stats()                                  // debug counters (alive, stopped, stuck, at bus stops, drawn, ...)
t.trains()                                 // debug: running trains
t.simulate(seconds)                        // debug: advance road + rail simulation headless
t.stuck(minWait)                           // debug: vehicles waiting longer than minWait s
t.showroom(x, z, heading, spacing, lod)    // debug: a row of every vehicle type
t.pedShowcase(x, z, heading)               // debug: a row of figures walking in place
```

## Data (`public/data/traffic/`, written by `pipeline/build_traffic.py`, ~0.75 MB)

* `meta.json` – `graph` (array directory into graph.bin.gz, classes, counts), `density`, `parked`,
  `rail` descriptors, `stops: [[x, z], ...]` (Overture bus stops).
* `graph.bin.gz` – fallback road graph, same layout as `roads/graph.bin.gz`:
  `nodes f32 (x,z) | ea, eb i32 | ecls u8 | ewidth u16 dm | elanes u8 | eflags u8 (1 fwd-only, 2 back-only, 4 link) | espeed u8 km/h | eoff u32 | epts f32`.
* `parked.bin.gz` – 10 bytes per car: `x f32, z f32, heading u8 (deg·256/360, cw from north), kind u8`
  (0 courtyard, 1 kerb in apartment district, 2 private-sector verge, 3 parking lot, 4 industrial lot).
* `rail.json.gz` – `routes: [{name, kind 'main'|'branch', el, p:[x,z,…] in travel order, br:[[s0,s1],…], stops:[[s, name],…], L}]`,
  `sidings: [{p:[x,z,…], cars:[[s, type],…]}]` (type 0 tank, 1 hopper, 2 gondola, 3 box, 4 flat/container).
* `density.png` – 1024² RGB, 20 m texels, row 0 = north: R pedestrian activity (apartment blocks,
  POIs, stops, centre), G apartment-block district, B private-house district.

Rebuild: `python3 pipeline/build_traffic.py` (~30 s; needs numpy, shapely, pyarrow, rasterio, scipy, Pillow).

## Sources / licences

All models and data are generated from Overture Maps (ODbL / CDLA) and procedural code in this repo;
no third-party textures or meshes. Vehicle dimensions from manufacturer data (VAZ-2107 4.13 × 1.62 ×
1.44 m, PAZ-3205 7.0 × 2.5 × 2.95 m, LiAZ-5256 11.4 m, …). Rolling-stock choice after the North
Caucasus Railway (ED9M EMUs on Nevinnomysskaya – Mineralnye Vody, 25 kV main line).

## Known limitations

* No lane changes / overtaking; lane choice happens at junctions (kerb lane for right turns).
* Pedestrians do not interact with cars (no zebra-crossing yielding) and can cross parked cars;
  sidewalk offsets are heuristic (the roads module's sidewalk polygons are not queryable).
* Parked cars can intersect trees (vegetation is placed independently).
* Trains do not change tracks at junctions other than the routes' own path; no shunting.
* Vehicles are not physics bodies.
