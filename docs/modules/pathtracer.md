# Path tracer module (`pathtracer`): Photo mode

Photo mode path traces the frozen view with a real, progressive Monte Carlo path tracer. It uses
[three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) 0.0.24 (MIT) for the
WebGL 2 path-tracing kernel and [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)
0.9.15 (MIT) for the SAH BVH.

It gives you:

- global illumination (sky and sun bounce light, colour bleeding)
- soft sun shadows from the real 0.53° solar disc
- ambient occlusion that follows from the geometry
- glossy and mirror reflections, water transmission and Fresnel
- depth of field with a hexagonal aperture
- night lighting from the street lamps

The module adds no assets and no pipeline script. Everything is generated at runtime from the scene
that the other modules have already built.

Files are in `src/modules/pathtracer/` and `src/workers/pathtracer-build.worker.ts`.

## Using it

- Press **P**, or use the UI's Photo button (key 4), to start photo mode. Press **P** or **Esc** to
  leave it.
- While photo mode is on, the camera is frozen (`ctx.paused`).
- An overlay shows the build progress, then the samples per pixel and the elapsed time. Its controls
  are:
  - depth of field on or off, and the aperture from f/1.4 to f/16. With depth of field on, click the
    image to focus on that point. The autofocus distance is the scene point at the image centre.
  - edge-aware denoising on or off
  - the number of light bounces
  - Save PNG, which snapshots the canvas, so it includes the sky post-processing
  - Exit
- If time of day changes while rendering (the UI time panel emits `time`), photo mode re-lights
  without rebuilding the BVH.
- If the camera is moved from a script, photo mode rebuilds for the new view.

### Service `pathtracer`

```ts
start(opts?: {
  spp?, quality?, radius?, budget?, renderScale?, bounces?,
  dof?, fStop?, focus?, denoise?, trees?,
}): Promise<'rendering' | 'unsupported' | 'error' | 'cancelled'>
stop(); toggle();
active: boolean;       // building or rendering
samples: number;       // completed samples per pixel
state: 'idle' | 'building' | 'rendering' | 'error';
message: string;
saveImage(download = true): Promise<Blob | null>
whenDone(): Promise<void>        // resolves when opts.spp is reached (or photo mode stops)
stats(): {...}                   // triangles, materials, textures, build and BVH ms, ms per spp...
```

### URL parameters

| param | effect |
|---|---|
| `photo=1` | start photo mode once the city is ready |
| `ptspp=N` | target samples per pixel. Default 4096 interactive, 16 in `shot=1` |
| `ptscale=s` | path tracer resolution relative to the drawing buffer |
| `ptradius=m` | override the gather radius |
| `ptbudget=n` | override the scene triangle budget |
| `ptbounces=n` | number of light bounces |
| `ptdof=1` | turn depth of field on |
| `ptfstop=f` | aperture f-number |
| `ptfocus=m` | focus distance in metres |
| `pttrees=0` | leave trees out |
| `ptdenoise=0` | turn denoising off |

## How it works

1. **Freeze and snapshot.** The module sets `ctx.paused`, installs its own `RenderPipeline` (which
   remembers the previous one), and blocks canvas pointer events so UI click handlers don't fire.
   Then it picks a re-centring origin: the camera's xz and the ground height, rounded to 1 m. The
   whole path-tracer scene lives in this local frame. This matters because the kernel offsets rays by
   `(|p| + 1)·1e-4`, which would be about 1 m at 10 km from the world origin.
2. **Gather** (`gather.ts`). The module walks `ctx.scene`, skipping the following:
   - invisible subtrees
   - `userData.noPathTrace`
   - camera-attached helpers
   - Points, Lines and Sprites
   - the vegetation module's live LOD group, which is replaced in step 4

   An object or instance is kept if it is within the gather radius, is larger than about 0.6 px in
   angular size, and meets one of these conditions:
   - it is in a slightly widened view frustum
   - it is within `keepNear`, which is 80 m or half the AGL, so reflections and bounce light work
   - its shadow can fall into view, tested by sweeping the bounding sphere along the horizontal sun
     direction

   `InstancedMesh` and `BatchedMesh` are expanded into per-instance matrices, with per-instance
   culling and `instanceColor` baked into vertex colours. Multi-material meshes are split per group.

   Candidates are sorted nearest first and kept within the triangle budget. Every source geometry is
   converted once into a canonical float form. Vertex ranges are compacted when a group uses only
   part of the geometry.
3. **Materials** (`materials.ts`). Every material is mapped to a clean `MeshPhysicalMaterial` proxy
   that carries only the parameters and plain 2D textures the kernel understands. The kernel uploads
   *every* texture-valued property into one texture array, so a stray `envMap` or array texture would
   break it.
   - `userData.ptMaterial` on the object or the material wins. Water, buildings, roads and bridges
     provide one.
   - Standard and Physical materials are copied field by field.
   - Lambert, Phong and Toon materials are converted, with roughness derived from shininess.
   - Basic materials become emissive when they are obviously lights (`toneMapped: false`, or a name
     like glow, lamp or lens) and matte otherwise.
   - A `ShaderMaterial` is converted only if it has a `diffuse` or `color` uniform. Otherwise it is
     skipped and counted in `stats().skippedMaterials`.
   - Additive and non-depth-writing transparent effects are skipped.
   - Opaque surfaces are made double-sided, because city meshes are often open, and single-sided
     faces leak light in a path tracer.
   - Textures are capped per quality (24–96 unique sources), dropping the least-used first.
4. **Trees** (`vegetation.ts`). The vegetation module draws near trees as instanced LODs and
   everything else as impostors, which are not path-traceable. This module reads the vegetation
   service's instance data directly (feature-detected) and chooses its own LODs. Trees are sorted
   nearest first within a tree triangle budget:
   - LOD0 meshes (branches and alpha-tested leaf cards) near the camera
   - LOD1 meshes further out
   - a lumpy low-poly crown plus a trunk proxy (92 triangles) for distant trees. Its colour is the
     species leaf tint times the mean leaf albedo, so the city's canopy still appears from the air.
5. **Terrain** (`terrain.ts`). The CDLOD ground is displaced on the GPU and flagged `noPathTrace`, so
   the module builds its own terrain:
   - Nested square LOD rings are centred on the camera. Spacing starts at 1.5–3 m, rises to about
     AGL/60 for aerial views, and doubles per ring until the whole 20 km region is covered.
   - Heights are sampled from `terrain.heightAt`, the rendered bicubic surface. Normals come from
     central differences.
   - The odd vertices on each ring's border are interpolated so they match the coarser ring, which
     leaves no T-junction cracks for rays to leak through.
   - The surface is lowered by 3 cm + 1.2 % of the spacing, so draped road layers are never pierced.
   - The material is the terrain module's `pathTraceProxy` material (the ground-albedo map).
6. **Build** (worker `pathtracer-build.worker.ts`). All instances are baked into one indexed geometry
   with these attributes:
   - position, normal and tangent. Tangents are computed from UVs for normal-mapped materials, and
     planar world UVs are generated for normal-mapped meshes without UVs, such as water.
   - uv, colour (rgba) and materialIndex

   The worker then builds a `MeshBVH` (SAH, one triangle per leaf, indirect) and transfers every
   buffer back with no copies. The main thread deserialises it and feeds it straight into the
   `WebGLPathTracer`, bypassing the library's main-thread `StaticGeometryGenerator`.
7. **Lighting.**
   - The sun (by day) or moon (by night) is a clone of `sky.sunLight`: its direction, colour and
     intensity, times the sky's mean cloud transmittance. Every sample jitters its direction inside
     the 0.267° solar disc (an R2 sequence), which gives physically correct penumbrae.
   - The environment is the sky module's PMREM (Bruneton sky, clouds and ground hemisphere),
     rendered on the GPU into a 512×256 float equirect and read back for importance sampling (a
     CDF). Without the sky module, an analytic clear sky is used, and a background with a sun disc is
     shown.
   - At night, up to 64 street lamps from `roads.lamps()` within 320 m become spot lights. They use
     the same 70 cd × `env.night`, 60 m range and cone as the roads module's real lamps. Other
     visible point and spot lights within 600 m are cloned as well, after removing duplicates.
8. **Render loop** (`photo.ts`). Each frame the module calls `renderSample()` as many times as fit
   in the budget. It adapts to keep the frame time at 24–45 fps, and splits large frames into up to
   4×4 tiles so one dispatch stays short. Once the target spp is reached, the GPU goes idle.
9. **Display** (`display.ts`).
   - **Composite mode** (the sky pipeline is active). The primary-ray background is transparent black,
     so the path tracer outputs premultiplied radiance, with alpha as coverage. The merged geometry
     is rasterised once into a depth texture. For the frame, `ctx.scene`'s children are temporarily
     swapped for a single full-screen quad. That quad writes the radiance and the real scene depth,
     converted to the main camera's depth range, and the sky's `SkyPipeline` renders as usual.
     - The backdrop (far terrain and the Caucasus) is still rasterised behind.
     - Aerial perspective, clouds, god rays, fog, bloom, the exposure and AgX grade, and FXAA/SMAA
       all apply exactly as in the real-time view.
     - N8AO is disabled for these frames, because the path tracer already has real occlusion.
   - **Standalone** (no sky pipeline). The output is tone-mapped with the renderer's AgX and
     `toneMappingExposure`, which the sky keeps equal to its exposure.
   - **Denoiser.** A joint bilateral filter uses depth, tone-compressed colour and alpha. Its radius
     is about 3.5 px at 1 spp and fades to 0 by about 256 spp.
10. **Stop.**
    - The previous pipeline, controller and input are restored.
    - The kernel is given an empty scene, so the BVH and attribute textures are freed.
    - The compiled kernel and render targets are kept, so the next start is fast.

## Quality tiers

| tier | gather radius | scene tris | tree radius / tris | terrain rings (n, s0) | texture layer | bounces | render scale |
|---|---|---|---|---|---|---|---|
| low | 1.6 km | 0.8 M | 450 m / 0.25 M | 48, 3 m | 512² | 3 | 0.5 |
| medium | 3.5 km | 2.0 M | 1.0 km / 0.7 M | 64, 2 m | 1024² | 4 | 0.75 |
| high | 6.5 km | 4.0 M | 1.6 km / 1.3 M | 80, 2 m | 1024² | 5 | 1 |
| ultra | 11 km | 7.0 M | 2.6 km / 2.2 M | 96, 1.5 m | 2048² | 6 | 1 |

Building chunks are large (about 360 m spheres), so the whole city's 825k building triangles usually
fit at medium and above.

## Fallbacks and safety

- If WebGL 2 is missing, `EXT_color_buffer_float` is missing, or textures are smaller than 4096 px,
  the overlay shows a message, `start()` resolves `'unsupported'`, and nothing else changes.
- Build errors are caught, and the previous pipeline is restored.
- When photo mode is inactive, the module adds nothing to the scene and has no per-frame cost.
- With `?only=pathtracer`, the module uses its own analytic sky and sun and meshes the heightfield.

## Performance notes

(see the report and the measurements below)

## Known limitations

- Custom shader looks aren't reproduced; only the `ptMaterial` proxies are. That means:
  - no window grids on buildings (average facade albedo per vertex)
  - no road markings (the markings mesh is `noPathTrace`)
  - no grass or wind
  - the ground albedo is the 10 m ground map, without the terrain shader's detail textures
- Emissive windows at night aren't in the proxies, so night photos are lit by the street lamps, the
  moon and sky glow only.
- The environment comes from the sky's low-resolution PMREM (32–64 px cube), so mirror reflections
  of the sky in water are soft. Clouds appear in the reflections, but not as sharply as in the
  real-time planar reflection.
- Cloud shadows use a scene-wide mean transmittance, not a pattern.
- Aerial perspective and fog are applied in post-processing from the rasterised depth, not
  volumetrically. Hazy light shafts come from the sky's screen-space god rays.
- Hedges are left out of the path-traced scene.
