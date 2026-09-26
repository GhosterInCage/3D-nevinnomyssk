# Module `roads`

Roads, sidewalks, curbs, road markings, bridges and overpasses, railways with catenary, street furniture
and the power grid of Nevinnomyssk. Provides the `roads` service.

## What is built

| Layer | Source | Runtime |
|---|---|---|
| Carriageways (asphalt, worn asphalt, concrete slabs, gravel, dirt, paving) | Overture `transportation/segment` buffered by class width (`width_rules` when plausible), unioned per surface so junctions merge seamlessly | draped ground mesh, 2x2 km super-tiles |
| Sidewalks + curbs | generated along trunk/secondary/tertiary (urban) and residential streets in apartment districts (building-density zones), plus Overture footways / paths | raised 22 cm slabs; vertical curb face towards the road, bevelled border stone elsewhere; separate curb stones where a lawn strip separates road and sidewalk |
| Parking lots | Overture `infrastructure` parking polygons | asphalt + perpendicular 2.5 m stall lines along the long sides |
| Pedestrian squares | land use `pedestrian` | raised paving |
| Markings (GOST 51256 style) | centre lines (1.3 double solid on 4-lane roads, 1.5 dashed, 1.1 solid before junctions), lane dividers, edge lines on rural trunk roads, zebra crossings (1.14.1) at `crossing` nodes (bicolour where tagged), stop lines at signalised junctions | transparent paint strips with worn/speckled coverage, dash pattern in the shader |
| Bridges / overpasses | segments with `is_bridge` / level 1, plus automatic bridges where roads or rails cross rivers / canals | deck profile computed at runtime from the final terrain: ends meet the approach roads, clearance over crossed rails (7.2 m) / roads (6 m) / water (water service level + 4 m); approach ramps with retaining walls where the rise needs them (5 % grade), slab fascia, concrete parapets + railings, underside, column piers with cap beams, abutments, physics trimesh |
| Railways | `rail` segments (standard gauge 1520 mm); `is_disused` = rusty rails and wooden sleepers; `is_abandoned` not drawn | ballast bed in the ground mesh (sloped shoulders), 3D rails + sleepers streamed in 150 m chunks within ~420 m, level crossings with rails flush to the road, low platforms (0.95 m) with a yellow safety line along the tracks |
| Catenary (25 kV AC main line) | electrified = long main-line segments + parallel station tracks (the Azot industrial network and the Cherkessk branch stay diesel) | concrete masts every ~55 m with cantilevers (outside of the track, or portals spanning the station yard), contact wire with zig-zag, messenger wire with sag, droppers |
| Street lights | LED steel poles (both sides of main roads), sodium lamps on concrete poles (tertiary, apartment districts, courtyard roads), distribution poles with lamps + overhead SIP cables in the private sector, lamps on bridge parapets | instanced within ~650 m (poles 420 m); glowing lenses at night; night glow sprites for every lamp in the city; lamp light pools on all road surfaces; the 4 (medium) / 8 (high) nearest lamps are real `SpotLight`s so facades, trees and cars get lit too (their lamp-map pool is faded out to avoid double lighting) |
| Traffic signals | `traffic_signals` nodes -> one T.1 head per approach, right-hand side | animated two-phase plan (26 s green, 3 s yellow, 2 s all-red) |
| Bus stops | `bus_stop` points, placed behind the sidewalk facing the road | modern glass shelters, Soviet concrete pavilions (private sector / villages), 5.16 sign |
| Signs | 5.19.1/5.19.2 at zebra crossings, 2.4 give way, 2.5 stop | procedural canvas atlas |
| Benches, fences, walls, guard rails | `bench`, `fence`, `wall`, `guard_rail`, substation outlines | instanced / merged |
| Power grid | `power_tower`, `power_pole`, `portal` points + `power_line` / `minor_line` (voltage, circuits, bundles) | lattice pylons by voltage (P500/P330 wine-glass, P110-2 double circuit, P110-1, P35, 10 kV concrete poles, substation portals) with glass insulator strings; conductors and ground wires in catenary sag |

Everything is draped on the terrain module's bicubic surface (`Ground.height`, identical to
`terrain/shaders.ts` `tHeightBicubic`), so the roads sit exactly on the rendered ground at every LOD 0 patch.
Draped layers are additionally pulled towards the camera in the vertex shader by a depth-precision
dependent amount (`rsPullP`) so they never z-fight with coarser terrain LODs far away.

## Rendering

* **One PBR surface shader** (`materials.ts`, MeshStandardMaterial + `onBeforeCompile`) for all hard
  surfaces: 8-layer texture array (albedo + normal/roughness) with anti-tiling, oxidised vs fresh asphalt,
  road-aligned rectangular repair patches with tar seams, crack networks, potholes on bad private-sector
  roads, wheel-track polish/ruts and oil strips per lane (from the per-vertex lateral offset), dusty edges,
  crumbling edges on narrow old roads, a grass strip in the middle of dirt tracks, cast-iron manhole covers and
  storm-drain grates along the curbs (near the camera), mid-distance track pattern
  on ballast, wetness (`ctx.env.rain`) with puddles in ruts/low spots + rain ripples, and **street-lamp light
  pools**: a 16 m lamp grid texture (two nearest lamps per cell) evaluated per fragment with three's
  `RE_Direct` (diffuse + GGX specular, so wet asphalt reflects the lamps).
* Wires are camera-facing ribbons at least ~0.75 px wide with alpha = radius / width (no shimmering).
* Instanced props use `InstanceSet` (distance-limited, nearest first, refreshed as the camera moves).
* Draw calls: ~100 ground/marking tiles (frustum culled), ~40 instanced sets, a few wire meshes per 2 km tile.
* Junctions for markings / wear are nodes where >= 3 public streets meet (driveways and service roads do not
  interrupt centre lines).
* Screenshot mode (`shot=1`) builds all tiles in bulk (SwiftShader frames are slow); interactive mode
  time-slices tile building nearest-first.

## Service `roads`

```ts
const roads = ctx.get('roads');
roads.graph.nodes            // Float32Array x,z
roads.graph.edges[i]         // { a, b, cls, width, lanes, oneway, dir (+1 a->b only, -1 b->a only, 0 both), name?,
                             //   speed (km/h or 0), link, tunnel, bridge (group id or -1),
                             //   points: Float32Array x,z, y: Float32Array carriageway top per point (deck on bridges) }
roads.nearest(x, z, maxDist?) // { x, z, dirX, dirZ, width, cls, name?, edge, t, s, dist, y } | null  (drivable roads)
roads.streetNames()          // string[]
roads.isRoad(x, z, margin = 0, includeFoot = true, includeRail = true)   // for vegetation / buildings placement
roads.distanceToRoad(x, z, maxDist = 50)   // to the nearest carriageway edge (negative inside)
roads.heightAt(x, z, bridge = -1)          // terrain (bicubic) or deck height of bridge group
roads.roadSurfaceY(x, z, bridge = -1)      // top of the carriageway (wheel contact): deck, or terrain + 8.5 cm
roads.groundHeight(x, z)
roads.bridges()              // [{ id, name, kind, axis }]
roads.signals                // [{ x, z, heading, phase, node }]  signal heads (graph node index)
roads.signalState(phase, t)  // 'green' | 'yellow' | 'red'  (t = ctx.env.elapsed)
roads.lamps()                // flat [x, z, type] (0 LED white, 1 sodium orange)
roads.lampMap                // { texture: IUniform<DataTexture>, params: IUniform<Vector4(x0, z0, 1/cell, n)> } - see rsLamps()
roads.uniforms               // shared shader uniforms (night, wetness...)
```

Traffic is right-hand. Edges are split at every Overture connector, so junction nodes are shared.

## Data (`public/data/roads/`, written by `pipeline/build_roads.py`)

* `meta.json` - tiles (1024 m, 20x20), array directory `name -> [dtype, byteOffset, count]` into
  `ground.bin.gz`, surface table, polyline kinds, marking styles, street names, graph array directory.
* `ground.bin.gz` - little-endian arrays:
  `gpos` u16 (x,z tile-relative, 1/32 m), `glat` i16 (cm, signed distance to the nearest centre line),
  `gatt` u8 x4 (surface, lanes, half width dm, wear), `gdir` i8 x2 (cos 2θ, sin 2θ of the line direction),
  `gidx` u32 (tile-local triangles, 10 m grid-subdivided constrained Delaunay);
  `lpos`/`lrec` polyline pool (skirts, curbs, markings, fences, walls, guard rails; u16 coords relative to the
  tile origin minus half a tile, records `[tile, kind, style, widthCm, group, start, count]`);
  `bpos/bidx/batt/blat/bdir` bridge deck meshes (world x,z f32, per-group ranges in objects.bridges).
* `graph.bin.gz` - nodes f32, edges (a, b, class, width dm, lanes, flags, speed, name index, bridge, point offsets, points f32).
* `objects.json.gz` - `bridges` (axis, length, real span range, clearance points, wet points, outline
  polylines, piers `{s,x,z,nx,nz,w0,w1}` - also read by the water module for pier foam), `rail` (tracks with
  catenary supports, portals, level crossings), `furniture` (lights, pole chains, signals, stops, signs,
  benches, crossings), `power` (towers `[x,z,heading,type]`, lines `{v kV, c circuits, b bundle, t tower indices}`).

Zones (rural / private sector / apartment blocks / industrial) come from 5 m building-density rasters
(buildings >= 320 m2 mark apartment blocks) and Overture industrial land use; they drive surfaces,
sidewalks, lighting style and pole chains.

## Textures

`public/textures/roads/surf_albedo.jpg`, `surf_nrm.jpg`: 8 procedural tileable layers (asphalt, concrete,
gravel, dirt, pavers, ballast, platform slabs, curb stone) generated by `pipeline/roads_textures.py`
(numpy FFT noise + wrapped Voronoi aggregates) - original work, CC0. Sign faces, railing and fence
textures are drawn on canvases at runtime.

## Rebuilding

```
python3 pipeline/build_roads.py              # ~5 min; also generates the textures when missing
python3 pipeline/build_roads.py --textures   # force texture regeneration
```

## Known limitations

* Terrain micro-relief (+-6 cm, terrain module) is not suppressed under roads; road surfaces are lifted 8.5 cm
  (sidewalks 22 cm) above the bicubic terrain to stay on top of it.
* Vertical curb faces in shadow render quite dark (no bounce light in the renderer).
* Rails / sleepers are 3D only within ~420 m; farther the ballast shader draws the track pattern.
* Overhead catenary on station tracks between portals is simplified (no head-span wires, rigid portals only).

* Lane counts are inferred from class/width; turn lanes and arrows are not modelled.
* Bridge decks are straight-lerped between their ends plus a smooth hump - no superelevation; interchange
  ramps are approximated.
* Street lights / sidewalks follow rules by zone, not a survey of the real city.
* The ground mesh ends at the 20.48 km region.
