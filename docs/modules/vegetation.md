# Vegetation module (`src/modules/vegetation`)

Trees, shrubs, hedges, grass and crops for the whole 20 × 20 km region of Nevinnomyssk.

## Pipeline: `pipeline/build_vegetation.py`

```
python3 pipeline/build_vegetation.py [--preview] [--cache] [--textures]
```

The script runs in about 90 s (`--cache` reuses the 2 m distance fields in `data/processed/veg_cache.npz`). It writes these files to `public/data/vegetation/`:

| file | content |
|---|---|
| `trees.bin.gz` (≈5.5 MB) | about 1.31 M instances: 0.89 M general trees, 39 k street trees, 0.37 M shrubs and 4.4 k clipped hedge runs, bucketed in 64 m cells (the binary layout is documented at the top of the script) |
| `cover.jpg` (2.4 MB) | 2048² at 10 m: R = ground-cover density, G = dryness, B = height factor |
| `covertype.png` (0.3 MB) | 2048² cover type: 0 lawn, 1 meadow/steppe, 2 reeds, 3 ripe cereal, 4 green crop (sunflower/maize), 5 stubble |
| `nogrow.bin.gz` (1.3 MB) | 10240² bit mask at 2 m that blocks grass and shrubs: buildings, carriageways plus sidewalks, footways, rail beds, water |
| `stats.json` | counts per species and zone |

### How trees are placed

1. **Exclusion rasters at 2 m** are built with PIL: Overture building footprints, road carriageways at the shared default widths (trunk 16, secondary 12, tertiary 9, residential 7, service 4.5 / 3.5, track 3.5, footway 2.2 …), sidewalks, footways, rail corridors (5 m bed plus 3 m margins) and water (Overture polygons plus WorldCover water). Euclidean distance fields give the building clearance and the carriageway, rail and water clearance. A tree trunk needs at least 1.6 m to the kerb, and its distance to a building must be at least 0.26 × its crown width.
2. **Zones at 10 m** are built from WorldCover, building-size densities, Overture land use and land, and the distance and height above the nearest river: `riparian` (Kuban, Bolshoy Zelenchuk and canal banks), `forest`, `shelterbelt` (лесополосы and rural tree lines), `urban` (apartment courtyards), `park`, `cemetery`, `private` (detached houses with gardens), `allotments` (СНТ dachas) and `industrial`.
3. **Canopy fraction** comes from WorldCover tree cover, modulated by Sentinel-2 NDVI. Green non-tree pixels in the private sector, allotments and courtyards add scattered garden trees, and Overture forest/wood polygons guarantee cover. Tree density is canopy × closure ÷ mean crown area of the zone.
4. **Blue-noise sampling**: a ranked Mitchell best-candidate pattern (a 64 m toroidal tile with 1024 points, 6 variants × 8 symmetries) is thresholded by local density. Every prefix of the pattern is blue noise, so any density gives a natural, non-overlapping spacing.
5. **Species** are drawn from per-zone mixes with 55 m spatial clumping (patches with a dominant species), in `pipeline/vegetation_species.py`. Heights and crown widths come from species ranges, scaled by the zone and slightly by the Copernicus DSM excess.
6. **Street trees**: every urban street side gets rows at 5.5–9 m spacing, 2–4.5 m beyond the carriageway edge. Species run in 150–350 m stretches (poplar 'Italica' columns, horse chestnut, linden, maple, acacia …). A tree is only planted where Sentinel-2 or WorldCover sees vegetation at that spot. Private-sector streets get irregular fruit, walnut and cherry trees instead. General trees that crowd a street tree are removed.
7. **Clipped hedges** run along city streets, either between the carriageway and the sidewalk or between the sidewalk and the lawn. **Shrubs** (lilac, privet/hawthorn, dog rose/sloe, willow scrub, juniper) grow in green urban areas, on riverbanks and at forest edges.

## Textures (`pipeline/vegetation_textures.py` → `public/textures/vegetation/`)

* `leaves.webp`: a 2048² atlas of 16 procedurally drawn leaf-cluster sprites (twigs with shaded, veined leaves). It has one sprite each for black poplar, white poplar (white undersides), willow, robinia (pinnate), horse chestnut (palmate), linden (cordate), maple (lobed), elm, walnut, fruit tree (with fruit), oak, birch, pine, blue spruce, thuja and shrubs. All sprites are generated, so they are CC0 and belong to this project.
* `bark_{oak,willow,pine,birch}_{color,normal}.jpg`: 512² versions of the MIT-licensed `@dgreenheck/ez-tree` bark assets. Those originals come from polyhaven.com (CC0) and texturecan.com (CC0).

## Runtime

* **Species models** (`species.ts`, `treegen.ts`, `src/workers/vegetation-treegen.worker.ts`) are 20 tree species and 6 shrub/hedge types, generated at startup in web workers. Broadleaf trees and shrubs use space colonisation inside a species crown envelope (column, ovate, dome, vase, weeping, bush) with foliage clumps, pipe-model branch radii and leaf-cluster cards on twig nodes. Conifers (pine, blue spruce, thuja, juniper) are built from whorls of drooping branches carrying needle sprays. Every model is emitted twice from the same skeleton:
  * **LOD0**: all branch tubes plus one card per twig node, about 3–8 k triangles.
  * **LOD1**: main limbs plus every 4th card scaled by ×1.84, about 0.6–1.2 k triangles.

  Foliage normals blend the card normal with the crown's radial direction. Vertex colours carry crown self-occlusion.
* **Materials** (`materials.ts`) are `MeshStandardMaterial` with patches added through a chain-safe `onBeforeCompile`, so they compose with the sky module's cloud-shadow patch and CSM. The patches add:
  * Hierarchical wind (trunk bend, branch sway, leaf flutter) driven by `ctx.env.wind` with travelling gusts. The same function drives the impostors and the grass.
  * Leaf translucency: back-lit and forward-scatter transmission, shadowed like the diffuse term.
  * Per-tree tint variation.
  * Mip-aware alpha test.
  * Complementary screen-space dithering, which cross-fades the LODs without popping.
* **Near/mid LODs** (`forest.ts`) use one `InstancedMesh` per species, LOD and part (bark or leaves), rebuilt every frame from the 64 m cells around the camera with CPU frustum culling. Hedges expand into 2 m modules along their line. Near and mid trees cast shadows through custom depth materials that include wind and alpha.
* **Far field** (`impostor.ts`): each tree species is baked once at startup into an 8 × 8 hemi-octahedral impostor atlas. The atlas has an albedo target and a normal target (MRT), is premultiplied and mip-mapped. Far trees are camera-facing quads that blend the 4 nearest views, are lit with the baked normals by the normal three.js lighting and translucency, and receive CSM shadows. Near the camera (inside the sky's shadow distance) they also cast shadows, using a single-view depth pass. The far field is split into 1 km chunks (`InstancedBufferGeometry`, frustum culled by three) whose instances are sorted by a random rank. Beyond `thinStart` a continuous density LOD keeps the fraction `(thinStart/d)^p` of trees and scales the survivors up so the canopy cover stays constant.
* **Grass** (`grass.ts`): 3–4 rings of instanced tufts around the camera out to 70–170 m, depending on quality. Positions are derived from `gl_InstanceID` on a world-aligned grid, so they stay stable as the camera moves. Height comes from `ctx.heightfield.texture`. Density, type and dryness come from the cover rasters, and a 2 m no-grow window around the camera (built from `nogrow.bin.gz` plus `clearInPolygon` rings) keeps grass off paved and built areas. Colour is matched to the terrain's Sentinel-2 ortho. Cover types are lawn, steppe, reeds along the rivers, ripe cereal with ears, tall green crop, and stubble, with some meadow flowers. Grass is wind-animated and fades out towards the outer radius.
* **Quality** (`forestParams`, `grassRings`):

  | tier | LOD0 | LOD1 / impostor switch | shrubs | impostor frame size | grass radius |
  |---|---|---|---|---|---|
  | low | – | 90 m | – | 32 px (single view) | no grass |
  | medium | 45 m | 190 m | – | 48 px | 70 m |
  | high | 75 m | 300 m | – | 64 px | 140 m |
  | ultra | 110 m | 420 m | – | 96 px | 170 m |

## Services and colliders

* `ctx.get('vegetation')` returns:
  * `clearInPolygon(ringXZ)`: removes trees, shrubs and grass inside a world-xz ring and returns how many instances were removed. Calls made before the data has loaded are queued.
  * `stats()`: returns the counts of LOD0, LOD1 and impostor instances.
  * `forest`, `grass`, `data`: the internal objects, for debugging.
* Colliders (`registerColliders` id `vegetation`) are trunk cylinders with the radius taken from the model and scaled per tree, and a height up to the crown base (at most 6 m).
* Impostors and grass set `userData.noPathTrace = true`. The mesh LODs are standard `InstancedMesh`es.

## Debug

* `?vegdbg=noimp,noimpshadow,nograss,nofar` switches off parts of the module, for measuring cost.
* `__city.ctx.get('vegetation').forest.debugGallery(x, z, spacing, ids, lod0Only)` places one instance of each listed species (LOD0, LOD1 and impostor side by side) for inspection.
* `…debugAtlas(0|1)` returns the impostor atlas as a PNG data URL.
