# UI module (`ui`)

The UI module draws the overlay you interact with, the floating place labels and the places gazetteer. It also restyles the loading screen and provides two services, `ui` and `places`.

The code is in `src/modules/ui/`. The data comes from `pipeline/build_places.py` and is written to `public/data/places/`.

## What you get

**Top left: title, search and place card**
- **Search with autocomplete** (press `/`). It covers about 1,090 entries:
  - the city itself (`Невинномысск` flies to a whole-city overview)
  - Overture POIs
  - named buildings and land-use areas
  - streets, merged by name and connectivity
  - rivers, canals and lakes
  - bus stops and railway stations
  - districts and settlements
  - curated landmarks
- **Ways to search:**
  - Russian or Latin letters: `gagarin` finds `улица Гагарина`, and `grés` finds ГРЭС.
  - Small typos are tolerated. Typo matching is a fallback pass that runs only when exact/prefix matching finds fewer than 3 hits, so `стадион` does not also list every "station".
  - House numbers are optional tokens: `менделеева 34` lists улица Менделеева, then the POI at that address.
  - Text typed with the wrong keyboard layout is corrected: `uflfhbyf` finds `гагарина`.
  - A category finds places of that type, in Russian or English (`аптека`, `school`, `church`).
  - Coordinates such as `44.636, 41.94` fly to that point.
- **Results** are ranked by match quality, importance and distance. Bus stops rank slightly below the street or place they are named after. Use ↑/↓ to move through them, Enter to fly to one and Esc to close the list. With the box empty, the list shows the main places and chips for each district.
- **Place card.** Choosing a result flies the camera there along a smooth arc and opens a card. The card shows the category, address, description (for curated landmarks), a live distance (updated while the camera flies), coordinates and elevation. Its buttons are *Fly here*, *Walk* (only when the physics module is loaded) and *share link*.

**Top right: compass and toolbar**
- **Compass rose.** It rotates with the camera heading; click it to turn and face north.
- **Toolbar**, which can be extended with `registerPanel`:
  - **Time & weather.**
    - Large clock, time-of-day slider with a day/night gradient, and the sun's elevation.
    - Sunrise and sunset times for the current date, computed with the core NOAA sun model.
    - Play/pause, with the speed as 1 min/s, 10 min/s or 1 h/s (`ctx.env.timeScale`).
    - Date picker and season shortcuts.
    - Seven weather presets: clear, fair, cloudy, overcast, rain, storm and fog. They match the sky module's presets and are applied with `sky.setWeather`.
    - Sliders for cloud, rain and fog.
  - **Big map** (`M`).
  - **Settings:**
    - Quality tier: `ctx.settings.setQuality`, then `ctx.resize()`, then `emit('settings')`. A toast offers a reload.
    - On/off switches for labels, street names, the minimap and stats.
    - Field of view.
    - Flight speed (`FlyController.speedFactor`).
    - Language: RU or EN. The UI is rebuilt in place, so the scene doesn't reload.
  - **Screenshot** (`K`). This calls `canvas.toBlob` inside the `frame` event, so it runs in the same task as the render and works without `preserveDrawingBuffer`. The screen flashes and the file downloads as `nevinnomyssk-3d-YYYYMMDD-HHMMSS.png`.
  - **Share.** Builds a `?cam=x,y,z,heading,pitch&time=&date=&clouds=&rain=&fog=&mode=` URL and copies it to the clipboard, or opens the native share sheet on touch devices. It also writes the URL into the address bar with `history.replaceState`.
  - **Stats.** FPS, a frame-time graph, draw calls, triangles, geometries, textures, the quality tier and the JS heap.
  - **Help** (`H` / `?`). Keyboard, mouse and touch controls, plus data attribution.
  - **Fullscreen.**

**Top centre: location pill.** It shows the nearest *named* street and the district or settlement. The street comes from a UI-side spatial index over the named edges of `roads.graph.edges`, because `roads.nearest` returns the nearest drivable edge, which is often an unnamed yard or service road. If the roads service is missing, it falls back to the gazetteer. It uses the city boundary to tell Nevinnomyssk apart from Kochubeevsky district.

**Bottom left: minimap**
- North-up and centred on the camera.
- Draws a view cone that uses the real horizontal FOV.
- Zooms automatically with height above ground; the +/− buttons and the mouse wheel override this.
- Scale bar.
- The base image is `places/map.jpg`. When zoomed in, crisp vector roads (from `roads.graph.edges`) and building footprints (from `buildings.query` and `buildings.footprint`) are drawn on top.
- **Interaction:**
  - Drag the map to move the camera, like panning a map.
  - Click to fly to that point, keeping the current heading, pitch and altitude.
  - The expand button or a double-click opens the **big map**. It is a full-window pan/zoom map with pinch support. It shows the city boundary, labels for districts, settlements, landmarks, water and main streets, and the camera marker. Click anywhere on it to fly there.

**Bottom centre: mode bar.** Buttons for Fly, Walk, Drive and Photo RTX, also on keys `1`–`4`.
- Walk and Drive appear only when those controllers are registered, and Photo only when the `pathtracer` service exists. The bar updates on `controller:added` and `service:pathtracer`.
- Photo calls `pathtracer.start()` and `stop()`, and shows a samples-per-pixel badge while it runs. The path tracer's own `P` / `Esc` keys work too; the bar follows `pathtracer.active`.
- While photo mode is active, the root gets `nv-photo`, which hides the labels, the pick marker, the location pill, the brand/search/card column and the minimap (the camera is frozen while it renders). The path tracer's overlay sits at the top centre, so toasts move below it and our own "photo on" toast is skipped.
- The bar is hidden when only Fly is available.
- **Physics HUD awareness.** The physics module draws its own key hint at the bottom centre for about 5 s after a mode switch, and a 188 px speedometer at the bottom right in drive mode. The UI checks for `.phx-hint.on` and `.phx-dash.on` four times a second (read-only). It lifts the mode bar (and on mobile the location pill) above the hint, and the status line above the dashboard. It also skips its own mode toast when the physics hint exists. The root gets an `nv-ctl-<controller>` class for mode-specific CSS.

**Bottom right:** status line with lat/lon, ground elevation, height above ground, heading and cardinal direction.

**Clicking the 3D view** (fly mode):
- **Click:** casts a ray against the height field and building roofs (`buildings.roofAt`) and shows an info card. The card can show:
  - For a building: typology (in Russian or English), number of floors (marked *estimated* when inferred), height, and the POI inside the same footprint.
  - Street, district, ground type (`terrain.groundTypeAt`), and the water body (`water.isWater`).
  - The nearest named street (within about 120 m), coordinates and distance.

  A pulsing marker shows the picked point.
- **Double-click:** flies to the point.

**Floating labels** (`L` toggles them):
- DOM labels are projected every frame. They come in four styles:
  - pins with coloured category icons and a stem
  - upper-case district and settlement names
  - white street plates, near the ground only
  - italic water names
- The visible distance depends on kind and rank; for example, rank 1 landmarks show up to 18 km, and minor POIs only within about 260 m.
  - Street plates only show while the camera is below 420 m above ground. Street fly-to framing stays below that height.
  - The city name (`НЕВИННОМЫССК`, large letter-spaced) only shows above 1,400 m above ground.
  - District and settlement names are hidden below 25 m above ground (at pedestrian height they only float over the rooftops).
  - The selected place (search result, clicked label) is always a candidate. It shows from at least 2.5 km and outranks everything else.
- Labels are kept entirely inside the viewport; a half-visible pill reads as a glitch.
- Labels fade smoothly and are placed in priority order in screen space, so they don't overlap each other or the UI panels.
- **Occlusion:** labels hidden by the terrain are removed. Near the ground (below 250 m above ground), labels hidden by buildings are removed too. That check samples `buildings.roofAt` every 7 m along the line of sight, skipping samples more than 70 m above the ground.
  - A label stays hidden until its first occlusion test has run.
  - New labels are tested first, on-screen ones before off-screen ones, up to 16 per frame.
  - A camera jump of more than 40 m in one frame (teleport, minimap drag, end of a flight) invalidates every result and hides all labels instantly, so old labels don't cross-fade over the new view.
  - Below 60 m above ground, area labels are building-tested too.
  - After that, 6 labels per frame are re-tested round-robin, each about every 0.35 s.
- For long streets and rivers, the label anchor is the closest of several points along the line.
- Clicking a label flies there and opens its card.

**Touch devices** (`pointer: coarse`):
- A virtual joystick. It sends WASD, or feeds `controller.analog` directly when the active controller has one (physics walk). Pushing it all the way means sprint.
- Up and down buttons in fly mode.
- Reliable look-drag: the module adds the delta that is missing when `movementX` isn't reported for touch.
- Double-tap flies to a point.
- A mobile layout at ≤720 px wide:
  - compact brand
  - full-width search
  - the card as a bottom sheet
  - panels as bottom sheets
  - the minimap reached through the Map button

**Loading screen** (`#loading` is only restyled; its progress logic isn't touched):
- A dimmed version of the map image with a slow Ken Burns zoom behind a glass card.
- A gradient progress bar.
- A status line in Russian or English and a chip for each module, both read from `window.__city.states`.
- A rotating fact about the city and the data credits.

**Intro flight:** after `ready`, the camera flies in over 6 s from high above the Kuban valley to the default view. It is skipped when the URL has `?cam=`, `?ll=`, `?mode=` or `?intro=0`, and any input cancels it.

**Shot mode (`?shot=1`):** only the services are provided. The module adds no DOM and no per-frame work.

## Services

```ts
ctx.get('ui'): {
  toast(msg, { duration?, action?: {label, fn}, key? }?): () => void   // returns dismiss()
  registerPanel({ id, title, icon /*svg or text*/, content?: HTMLElement | (body) => void, order?, key? /*KeyboardEvent.code*/,
                  onClick?, onOpen?, onClose?, separator? }): PanelHandle   // {el, button, open, close, toggle, remove, setActive, setTitle, isOpen}
  flyTo(x, z, { distance?, pitch?, heading?, height?, duration?, position?, onDone? }?)
  showPlace(nameOrItem): boolean        // fly + card
  setLabelsVisible(v)
  root: HTMLElement | null; lang: 'ru' | 'en'
}
ctx.get('places'): {
  list: Array<{ name, x, z, kind, rank }>     // filled once places.json is loaded (the service is provided after loading)
  items: PlaceItem[]                          // full records (see data format)
  flyTo(name): boolean                        // exact name/alias match, else best search hit
  search(q, limit = 8): PlaceItem[]
  nearest(x, z, kind?, maxDist?): PlaceItem | null
  ready: Promise<void>
}
```

`registerPanel` handles stay valid across language switches, because they are proxies to the rebuilt toolbar.

## Camera flights

`CameraFlight` (`flyto.ts`) handles every animated camera move.

- **While flying.** It switches to the `fly` controller and sets `ctx.paused = true`, restoring the previous value when it finishes. Every frame, at order −3000, it writes the camera position and orientation.
- **Path.** The position follows an eased path with an altitude arc (up to 2.5 km for long jumps) and stays at least 40 m above the terrain. The orientation eases from the start toward "look at the target" and ends exactly at the requested heading and pitch.
- **Rotate in place.** `rotateTo()`, used by the compass, slerps between the two orientations.
- **Cancelling.** Any WASD, QE, C, Space or arrow key, or a mouse drag, cancels the flight.
- **When done.** It calls `ctx.controller.enter(ctx)` so the fly controller picks up the new heading and pitch, and emits `teleport`.

`teleport()` moves the camera instantly and keeps the height above ground. The minimap drag uses it.

## Data: `public/data/places/`

Built by `python3 pipeline/build_places.py`, which takes about 20 s, or 2 s with `--no-map`. It is registered in `build_all.py`.

**`places.json`**, about 150 KB of UTF-8 JSON. Coordinates are world x/z as integer metres.

```jsonc
{ "version": 2, "generated": "...",
  "kinds": { "church": ["Храм", "Church"], ... },          // labels per kind (ru, en)
  "boundary": [x0, z0, x1, z1, ...],                          // городской округ Невинномысск, simplified 25 m
  "items": [ {
    "n": "улица Гагарина",   // name (Russian, as in OSM/Overture)
    "k": "street",           // kind: city district settlement landmark church monument park water street station bus_station bus_stop
                             //       industry power education medical culture sport mall shop food hotel gov fuel service allotment
                             //       viewpoint nature building
    "x": 425, "z": 1201,     // representative point
    "r": 1,                  // rank 1 (most important) .. 5
    "c": "Улица",            // category label (ru)          (optional)
    "a": "с. Кочубеевское",  // address / settlement context (optional)
    "en": "...", "d": "...", "de": "...",  // English name, description ru/en (curated)  (optional)
    "al": ["..."],           // aliases (searchable)          (optional)
    "h": 4,                  // label height above ground (m) (optional)
    "p": [x, z, ...],        // extra label anchors along long streets / rivers (optional)
    "L": 6760                // length of street / river in the region (m) (optional)
  } ] }
```

Ranking adjustments in the pipeline:
- Street fragments shorter than 500 m never rank above 3, even on a primary road. For example, the 310 m central «улица Ленина» is not a highlight.
- A name-based refinement pass fixes Overture's "public" and "civic" building classes. It separates administrations, ZAGS, police and MFC (rank 2–3) from post offices, passport desks, fire stations, saunas and vets (rank 4). Unrecognised civic buildings drop to rank 4.
- Name keywords refine generic categories, for example `МБОУ СОШ №12` is filed under Школа rather than Учебное заведение.

The items come from these sources, merged and deduplicated by name, aliases and distance:
- Overture `places`. Instagram-style handles are dropped. Wildberries/CDEK pickup points and low-confidence places are demoted to rank 5.
- Named buildings.
- Named land use and land.
- Infrastructure: bus stops (merged per stop pair), railway stations and halts, viewpoints, power plants and substations.
- Water lines, clipped to the region.
- Street segments. Segments with the same name are clustered when they are within 500 m of each other, so `улица Ленина` in Nevinnomyssk and in Kochubeevskoye stay separate, and each cluster is tagged with its settlement from the Overture division polygons.
- A curated list of about 23 landmarks, 11 districts and the city itself (kind `city`, at (250, 400), with a description: founded 1825, town status 1939, about 117 thousand inhabitants in 2025). It has hand-checked positions, taken from Overture / `landmarks.json`, plus short descriptions.

Transliteration and search normalisation happen at runtime (`translit.ts`), so the file stays compact.

**`map.jpg`**, 2048² at 10 m/px and about 740 KB. It is north-up, and pixel (0,0) is world (−10240, −10240). The layers are:
- The Sentinel-2 true-colour composite (`terrain_ortho.npy`), tone-mapped with an exposure and filmic curve, then sRGB-encoded.
- Water tint from the terrain water mask.
- All 57k building footprints.
- Roads by class with casing.
- Rail.
- The city boundary.

Vector overlays are drawn at 2× supersampling. The minimap, the big map and the loading screen all use this image.

The minimap's vector layer caches decoded building footprints, so decoding isn't repeated on every redraw. The cache is cleared above 30,000 entries.

**Facts and sources.**
- GRES: first turbine June 1960, ≈1550 MW. Source: nevadm.ru news, 2021 and 2025.
- Azot: first ammonia August 1962, part of EuroChem. Source: nevadm.ru, 2023.
- Wind farm: 84 turbines are in the data (ВЭУ1–84); the 210 MW figure is commonly published.
- Founded 1825, town status 1939. Source: city reference pages.
- Informal district names (Фабрика, Рождественское, Головное, ПРП, ЗИП, Красная Деревня…) come from the Russian Wikipedia summary of the city's districts. Their label positions come from matching Overture land-use, bus stop and railway halt names. They are approximate centroids, not boundaries.

## Files

| file | purpose |
|---|---|
| `index.ts` | module, `UIApp` (mount / rebuild, services, actions, picking, shortcuts, intro) |
| `styles.ts` | all CSS (glass theme, mobile media queries, loading screen) |
| `gazetteer.ts`, `translit.ts` | data model, search index / scoring, transliteration, layout swap, edit distance |
| `labels.ts` | floating labels (projection, fade, declutter, occlusion) |
| `minimap.ts` | minimap + big map + vector layer |
| `flyto.ts` | camera flights / teleport |
| `hud.ts` | compass, status line, location pill |
| `panels.ts` | toolbar + panels (`registerPanel`), toasts |
| `timeweather.ts`, `stats.ts`, `help.ts`, `modes.ts`, `placecard.ts`, `search.ts`, `touch.ts`, `loading.ts` | the individual widgets |
| `i18n.ts`, `icons.ts`, `dom.ts` | strings (ru/en), inline SVG icons (drawn for this project), DOM helpers |
| `dev/ui-shot.mjs` | Playwright harness **without** shot mode (desktop 1280×720, `--mobile` 390×844 touch) |

UI screenshots are taken with:

```
node src/modules/ui/dev/ui-shot.mjs --out tools/shots/ui/desktop.png                # all modules, quality low, intro off
node src/modules/ui/dev/ui-shot.mjs --mobile --only terrain,sky,ui --extra "&skypipe=0" --out tools/shots/ui/m.png
node src/modules/ui/dev/ui-shot.mjs --steps '[{"press":"/"},{"type":"gagarin","out":"s.png"}]' --dir tools/shots/ui
```

The script pauses the render loop before each capture, because SwiftShader frames take 5–20 s when frames render continuously.

Step fields are applied in this order: `eval`, `type`, `press`, `click`, `tap`, `until`, `settle`, `out`.
- `until` is a JS expression polled until it is truthy.
- The core clamps `dt` to 0.1 s and SwiftShader renders about one frame per second, so camera flights crawl in the harness. To jump to the end of a flight, use `{"eval":"__ui.flight.t=0.97","until":"!__ui.flight.active"}`.
- The default ready timeout is 15 min, because a full-city load takes about 7 min on a busy 4-core machine.
- `--loading-shot file --loading-wait ms --loading-only 1` captures the loading screen.

## Keyboard

| key | action |
|---|---|
| `/` | search |
| `1` `2` `3` `4` | fly / walk / drive / photo |
| `M` | big map |
| `T` | time & weather |
| `L` | labels on/off |
| `K` | screenshot |
| `U` | hide UI |
| `H` or `?` | help |
| `Esc` | close |

Fly-controller keys are unchanged: WASD, QE / Space and C, Shift, Alt, the mouse wheel and drag.
