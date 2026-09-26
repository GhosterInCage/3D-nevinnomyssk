# Module `landmarks`

Hand-crafted procedural models of Nevinnomyssk's landmarks. `pipeline/build_landmarks.py` places them from the open data. The runtime (`src/modules/landmarks/`) builds the geometry procedurally in the browser, which takes about 1–2 s on the main thread. The generic building extrusions underneath are hidden through the `buildings` service.

## What is built

| Landmark | Placement / dimensions | Model |
|---|---|---|
| **Nevinnomysskaya GRES** (EL5-Energo, formerly Enel Russia) | Main chimney base at the Overture place "Невинномысская ГРЭС" (−848, −2160). Its winter Sentinel-2 shadow gives a best height of 245 m against the published 250 m. The TEC chimney is at (−757, −1929) and its shadow measures 115 m. The main buildings are the Overture footprints `ffd12a5f…` (249 × 70 m) and `7958db14…` (183 × 71 m). The four round tanks in the plant area are fuel-oil and water tanks. | Slip-formed reinforced-concrete chimneys with lift joints, obstruction marking, light platforms, caged ladder, sooty top and dark flue opening. The 250 m chimney has the top third in 7 red/white bands; the others have their top 14 % banded. Each main building has a turbine hall with a skylight lantern, a deaerator bay and a boiler bay, finished in 6 × 1.2 m wall panels with steel-framed strip glazing (lit at night). Six open-air drum boilers stand on the chimney side, because the 150 MW units are *open-configuration* ("открытой компоновки"). Each boiler has a steel frame, a furnace and convective-pass casing, walkways with yellow railings, a stair tower and risers. Gas ducts run to a collector and on into the chimney, with smoke-exhauster houses. Block transformers stand along the turbine-hall side. Tanks have stairs, roof railings and bund walls. |
| **Nevinnomyssk Azot** (EuroChem) | The tall structures come from the same shadow scan: a ~155–180 m stack at (205, −3057), an ~70–80 m prilling tower at (598, −2049), and two 55–60 m columns. The four isothermal ammonia tanks are Overture footprints (h 30 m, Ø 48 m). Nine further round footprints are storage tanks. **Process equipment** goes into 885 10 m cells inside the plant's process core. A cell qualifies where the Copernicus DSM stands ≥ 4 m above the ground, Sentinel-2 NDVI is < 0.32 (not trees), and there is no building footprint. **Pipe racks** (29 km of candidate lines, about 45 % used) run along the internal roads of the process core. The long linear DSM features follow those roads. | Stack as for the GRES. The prilling tower is a concrete cylinder with a head house, louvres, product dust and an inclined conveyor gallery. Columns carry insulation bands, platforms, a ladder and a vapour line. Ammonia tanks have a ribbed shell, stiffener rings, a dome, a stair tower, a bridge and roof equipment. Each process cell is chosen by seed and DSM height from five types: vertical vessels, open steel structures with floors and drums, horizontal drums or heat exchangers, fin-fan air coolers, and small tanks. Cells with a strong DSM signal get tall columns. Pipe racks are level steel bents every 7.5 m with 1–2 tiers of 4–9 pipes in several colours: aluminium-clad insulation, grey, gas yellow, water green and brown. The plant is split into 400 m tiles with a detail layer. |
| **Кафедральный собор Покрова Пресвятой Богородицы** (1988–1998) | Overture footprint `d3be91ae…`, 30 × 21 m, oriented E–W. Published: main dome 34 m, octagonal four-tier bell tower 50 m over the west part, white stone, five domes, facade risalits. | Parametric church: plinth and steps; a chetverik with risalits; three zakomary (kokoshnik gables) per facade; arched windows with white surrounds in two tiers ("двухсветный"); pilasters and string course; blind arcature; east apse with a half-dome; west narthex with a gable roof; a four-tier bell tower (square base, then octagonal tiers with an open belfry); five drums with arched windows; gilded onion domes with eight-pointed Orthodox crosses. |
| **Храм Серафима Саровского** (2005–2015) | Footprint `6702d4d6…`. The OSM building parts give a central drum (r ≈ 3.3 m, 18 m), four side drums (r ≈ 1.6 m, 14 m) and a west drum. | Same generator, in brick walls with white trim and gold domes. It is described as brick, Old Russian style, built with "named bricks". |
| Other churches and chapels | OSM `building=church/chapel` footprints: the baptistery chapel next to St Seraphim, a church at (−2266, 3605), the hospital chapel (−498, −246) and a church pair at (2550, 2080). | Single-dome church or chapel variants. Their names and colours are not in the data, so these are plausible defaults. |
| **Eternal Flame + obelisk "Вечная слава"** (1967, architect D. Zhuravlev) and the **Book of Memory** stele (2000, 2.75 m) | Overture place (182, 64), on the median of bulvar Mira at Gagarina street, aligned with the boulevard centre line (heading ~75°). | Granite-paved square; a 17 m tapered obelisk on a red-granite pedestal with a gilded star and a bronze plaque; the open granite book; a five-pointed star bowl with a bronze burner and an **animated flame** (noise shader on crossed planes, plus a glow); flowers and wreaths. The obelisk height is estimated, because no source gives it. |
| **Railway station Nevinnomysskaya** (1903, rebuilt 1953) | Footprint `db8b04f5…`, 60 × 13 m. The front faces the town (south); the tracks are to the north. | Described as a one-storey building with columns and a large glazed arched entrance portal, twin of the old Adler station. The model has a central block with a glazed arch, paired columns, entablature and attic with the canvas-texture name "НЕВИННОМЫССК", which glows at night. The wings carry tall windows and pilasters, with a cornice, parapet and hipped roofs. There is also a track-side canopy on cast-iron columns. |
| **Stadium "Khimik"** (land use "Стадион НГГТИ", place "Стадион Химик") | Pitch axis and centre come from the stadium polygon. The west stand is footprint `4ffa8295…` (89 × 15 m). | A 105 × 68 m pitch with mowing stripes and markings; a 400 m track with 8 lanes and a curb; a 14-row stand with coloured seats, aisles, a back wall and a cantilever roof; four 34 m floodlight masts whose lamp heads glow at night. |
| **Nevinnomyssk canal headworks** on the Kuban | Weir line and pool/tail levels (307.5 / 306.0 m) from `water.json`. The canal start comes from Overture. | Gated weir with piers every ~12 m, lift gates, a downstream sill, a road deck with railings, hoist houses and abutments, plus a 4-bay canal head regulator with a gatehouse. |
| **Kubanskaya GES-4** (78 MW, 1970) | Footprint `ee20efc9…`. | Powerhouse: substructure, machine hall, intake gantry crane, draft tube outlets, transformers. |
| **Kochubeevskaya wind farm** (NovaWind, 84 × 2.5 MW, 2020–21) | 76 OSM `generator:source=wind` points inside the region. The rest lie outside the detailed terrain. | Lagerwey L100-type direct-drive machine: 100 m tubular tower, ring generator, spinner, three 48.5 m twisted blades with red tip bands. Rotors yaw into `env.wind` and spin with the wind speed (0–15 rpm). Nacelles carry **blinking** red obstruction lights. It is drawn as three InstancedMeshes. |
| Telecom masts | 8 `mobile_phone_tower` points. The OSM height is used where given (30 m); otherwise 36–48 m. | Triangular lattice in red/white bands, antenna panels, dishes, obstruction lights and an equipment cabinet. |
| Ice Palace "Olimpiysky" (2013) | Footprint `26334040…`, 73 × 47 m. | Modern arena with a barrel roof, white profiled facade with a blue band, and a glazed foyer. This is an approximation; no facade reference was accessible. |
| Fountains | 3 OSM `amenity=fountain` points, including the station square and the central park. | Granite basin, water surface, central bowl. |
| Entrance signs "ГРЭС", "ЕВРОХИМ" | OSM `tourism=artwork` points, facing the nearest road. | Pedestal with canvas-texture letters, lit at night. |

The following were considered but are left to the generic buildings module, because the available sources did not describe their form: the Palace of Sport "Olimp", Kino "Mir", the Rodina culture centre and a Ferris wheel in the city park.

## Rendering

- **One material** for all hard surfaces: `material.ts`, a `MeshStandardMaterial` extended with `onBeforeCompile`. That keeps lights, CSM shadows, fog, IBL and the sky's cloud-shadow patch working. The geometry carries:
  - a vertex colour (linear)
  - `lmUv`, a surface parametrisation in metres
  - `aSurf` = (pattern, roughness, metalness, flags)
- **Patterns.** 16 procedural patterns: brick bond with per-brick tint, slip-form concrete, profiled sheet, 6 × 1.2 m wall panels, industrial glazing, painted steel with rust runs, gilding, white stone, grating, lamps, standing seam, tiles, windows, polished granite and asphalt. Relief comes from a derivative-based bump of the pattern height, only where a feature spans several pixels, and lines are anti-aliased against pixel size.
- **Weathering.** Triplanar tileable noise (`public/textures/landmarks/noise.png`, 512², CC0, generated by `pipeline/landmarks_textures.py`) drives stains, vertical rain streaks and splash-zone darkening.
- **Night.**
  - Floodlit facades (`F.FLOOD`, warm, falling off with height): churches, the obelisk, the station and the fountains.
  - Lit panes (`F.WINLIT`), with a fraction that depends on `env.night`.
  - Emissive lamps, steady or blinking.
  - Screen-space **glow sprites** (`effects.ts` `Glows`, one draw call) for obstruction lights, floodlights and the flame. Beacons keep a minimum apparent size so they read from far away.
- **Plumes** (`effects.ts` `Plumes`). A single instanced draw of camera-facing puffs from the GRES/Azot stacks and the prilling tower. They rise with buoyancy, drift with the wind (×1.8 at stack height), meander, grow and fade, and are lit by the sun colour. They are faint in summer and dense in winter (gas-fired flue gas condenses in the cold).
- **LOD.** Each landmark has a main mesh and a detail mesh (railings, ladders, gratings, small pipes, brackets):
  - Main meshes stay visible to at least 16 km, because chimneys and turbines are skyline elements. The Azot tiles are the exception: their main mesh is capped at 5 km.
  - Detail meshes are shown within 350 / 650 / 1000 / 1500 m (low / medium / high / ultra), plus the landmark radius.
- **Path tracer.** Meshes use the standard material. Glows, flame and plumes are flagged `noPathTrace`.
- **Colliders.** About 1 100 boxes and cylinders (buildings, stacks, tanks, columns, turbines, piers, stands, memorial), served through `ctx.registerColliders({id: 'landmarks'})`.
- **Service `landmarks`**: `{ list(): {name, x, z}[], group }`.

Triangles: about 700 k in total, most of them the Azot process equipment and racks in 40 tiles, which are distance-culled. There are about 60 draw calls.

## Data format: `public/data/landmarks/landmarks.json`

The world frame is x east, z south, in metres. `rot` is the three.js rotation about +Y that maps a model's local +X, its long axis, onto the footprint's long axis.

```
gres:     { stacks:[{name,x,z,h,r0,r1,style,shadowH,consistency}], main/tec:{x,z,len,wid,rot,ring,id,boilerSide},
            tanks:[{x,z,r,h,kind,id}], hide:[overture ids] }
azot:     { stacks, prill:[{x,z,h,r}], columns:[{x,z,h,r}], ammonia:[{x,z,r,h,id}], tanks:[...],
            cells:[[x,z,seed,dsmExcess]], racks:[[x0,z0,x1,z1,...]], hide, poly }
churches: [{name,kind,x,z,len,wid,rot,domes,dome,walls,bell,h,ring,hide}]
memorial: {x,z,rot,obeliskH}   station/ges4/arena: {x,z,len,wid,rot,ring,hide,...}   stadium: {x,z,rot,len,wid,stand,hide}
turbines: [[x,z]]  masts: [[x,z,h]]  signs: [{text,x,z,rot}]  fountains: [[x,z]]  weir: {line,up,down,canal:{x,z,dir}}
```

Rebuild with `python3 pipeline/build_landmarks.py`, which takes about 20 s. It needs `data/processed/s2w_*.npz` (winter scenes from `buildings_s2winter.py`), `dsm_excess.npy`, `s2_ndvi.npy` and `public/data/water/water.json`. It is registered in `build_all.py`.

## Sources

- Overture Maps 2026-09 (OSM, Microsoft ML footprints): footprints, building parts, land use, infrastructure (wind generators, masts, fountains, weir), places.
- Copernicus DEM GLO-30 (DSM excess), Sentinel-2 L2A: summer NDVI and five winter scenes for shadow measurement.
- Published facts, found with WebSearch:
  - GRES: 250 m chimney; ТЭЦ + open-configuration 150 MW condensing units + ПГУ-170 (decommissioned 2015) + ПГУ-410 (2011); gas, with fuel oil as reserve. Sources: so-ups.ru, rosteplo.ru, el5-energo.ru.
  - Cathedral: 34 m dome, 50 m four-tier bell tower, white stone, five domes, 1988–1998. Sources: sobory.ru, gosuslugi, azbyka.ru.
  - St Seraphim: 2005–2015, Old Russian style, brick.
  - Obelisk "Вечная слава": 6 Nov 1967, architect D. Zhuravlev, artist Yu. Untilov; Book of Memory 2000, 2.75 m. Source: nevadm.ru.
  - Station: 1903, rebuilt 1953, one storey, columns, glazed arched portal, twin of Adler. Source: nevadm.ru.
  - Kochubeevskaya VES: 84 × 2.5 MW NovaWind. Sources: novawind.ru, atomic-energy.ru.
  - Ice palace 2013, 600 seats.
- Street-level imagery was not reachable, so colours and details not stated in the sources are typical regional choices. The tables above name which parts are estimates.
- Textures: only `noise.png`, generated procedurally (CC0).
