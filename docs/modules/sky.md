# Sky module (`sky`)

The sky module owns the atmosphere, the sun and moon, shadows, clouds, fog, weather, image-based lighting and the post-processing pipeline. It also provides the `sky` service.

Files are in `src/modules/sky/`. The assets are in `public/textures/sky/`. The cloud texture is built by `pipeline/build_sky.py`.

## What you get

- **Physically based sky and aerial perspective.** These use Eric Bruneton's precomputed atmospheric scattering, taken from `@takram/three-atmosphere`'s GLSL and LUTs. The world frame is converted to ECEF with a rigid ENU basis at lon 41.94 / lat 44.64, as set up in `frame.ts`. The sky and haze are applied in post-processing, so everything gets consistent aerial perspective: the main scene, the `ctx.backdrop` far terrain and Caucasus, and the clouds. This covers distances from 8 m to 400 km.
- **Sun and moon.** The sun direction is `ctx.env.sunDirection` (the core's NOAA sun). The moon comes from astronomy-engine, with its real position and phase; `ctx.env.moonDirection` is overwritten every frame. The sun disc is rendered with limb darkening, and the moon disc shows the correct lunar phase. Stars come from the Yale Bright Star Catalogue (9096 stars) and rotate correctly for the date and time.
- **Key light.** This is a `SunLight` (three r186 addon) in `ctx.scene`, lit by the sun during the day and the moon at night. Its colour and intensity come from the atmospheric transmittance, sampled on the CPU from the LUT. There is a matching `DirectionalLight` for `ctx.backdrop.scene`.
- **Cascaded shadow maps.** `CityShadow` generalises three's `SunLightShadow` to 1–4 cascades in one atlas. Unlike three's CSM there is no material patching and no N-lights problem, because every built-in lit material supports it natively. It has these properties:
  - It is stable: fitted by bounding sphere, with texel snapping and a quantised radius.
  - It is soft: PCF with a 5-tap Vogel disk and radius 2.5 texels.
  - Cascades start near the closest visible ground and extend with altitude, so shadows also appear in aerial views.
  - A caster ceiling means tall off-screen casters, such as the GRES chimney, still cast.
  - The per-cascade depth range is scaled so the depth bias equals a constant number of texels, and the normal bias grows with distance.
  - Quality settings: `shadowMapSize` per cascade, `shadowCascades`, and `shadowFar`. The far distance is extended by the camera's height above ground.
- **Image-based lighting.** `scene.environment` (and the backdrop's) is a PMREM of the sky rendered with the same shader. It includes the clouds, the moonlit or night sky, and a lambertian ground hemisphere. It is refreshed when the sun moves more than 0.25°, the moon moves, the weather changes, the camera moves more than 3 km, or every 20 s. This is the only sky or ambient light, so don't add hemisphere or ambient lights.
- **Clouds.** A cumulus or stratocumulus layer is drawn as a 2.5D "plane-stack" volume:
  - 2D coverage from `clouds.png`, sampled with a mip bias for smooth shapes, is extruded into dome-shaped columns.
  - The coverage is domain-warped with height by a tileable 3D noise (`noise3d.bin`), so the column flanks are not vertical extrusions.
  - The same 3D noise erodes the volume.
  - Lighting has analytic optical depth towards the sun or moon, single and multiple scattering, sky ambient from above, ground and city bounce from below, and a "powder" term.
  - Aerial perspective comes from the froxel LUT.
  - It is rendered at half resolution (a third on software GL), with 2–3 jittered sub-samples accumulated in one frame and bicubic upsampling.
  - In interactive mode the cloud buffer is also accumulated over time: the jitter changes every frame, and a resolve pass reprojects the history by cloud distance, clamps it to the current neighbourhood and blends it at 0.88. Screenshot mode disables this by default so that single frames stay deterministic; `?skytaa=1` enables it.
  - A cirrus sheet sits at 9.5 km.
  - Clouds drift with `ctx.env.wind`, except in screenshot mode where they stay put.
- **Crepuscular rays (god rays).** A quarter-resolution radial blur of sun visibility is computed from the combined depth and the cloud alpha, and added as in-scattered sunlight. It is strongest at low sun, so shafts appear through cloud gaps and between buildings.
- **Cloud shadows.** These appear on everything registered with `ctx.registerMaterial`, and on any lit material found in the scenes, which are rescanned every 2 s. The patch is a non-destructive `onBeforeCompile` hook:
  - It chains with your own `onBeforeCompile`, even one assigned *after* registration.
  - It keeps a distinct program cache key per hook.
  - It multiplies the sun or moon light by the cloud transmittance.
- **Weather.**
  - Cloud cover goes from clear to overcast. Overcast decks get a lower, thicker base and textured variation in thickness.
  - Rain adds GPU streaks in a world-anchored box around the camera, a heavier and darker deck and rain haze. It also sets `ctx.env.rain` for wet materials.
  - Fog is analytic exponential height fog lit by the sun and sky, ranging from haze (fog ≈ 0.3) to valley fog (fog = 1).
- **Night.** There is airglow plus urban light pollution (an orange horizon glow), and city light reflected by cloud bases. Moonlight is artistically boosted (×9000). A scotopic (Purkinje) shift makes dim parts bluish and desaturated while bright lights keep their colour.
- **Post-processing** uses pmndrs `postprocessing`, in this order:
  1. composite of backdrop and scene
  2. N8AO
  3. AP LUT, cloud buffers and god rays
  4. atmosphere
  5. bloom and grade
  6. SMAA, or FXAA on software GL

  The grade stage applies exposure, an optical vignette, AgX with a mild "punchy" look, the Purkinje shift and dithering.

## Units and exposure (important for emissive materials)

Scene radiance is Bruneton relative luminance × 2 (`RADIANCE_SCALE`). The noon sun has an irradiance of about **3.0**, the same as three.js's usual `DirectionalLight` intensity of 3.

`ctx.env.sunIntensity` and `ctx.env.sunColor` are the sun's real values at the camera. They drop to 0 at night and are reduced under overcast. The display value is AgX(exposure × radiance).

The exposure is a deterministic time-of-day curve with partial adaptation, so it is identical in screenshots:

| situation | exposure |
|---|---|
| noon, clear | ≈ 1.1 |
| overcast | ≈ 2–3 |
| sunset, clamped | ≈ 13 |
| night | 13 |

Suggested emissive radiance, which you can scale by `ctx.env.night`:

| source | radiance |
|---|---|
| lit windows | 0.05–0.25 |
| street-lamp bulbs and headlights | 2–20 (these bloom) |
| a `PointLight` street lamp | 5–30 cd over the road |

Because of the high night exposure, anything above about 0.3 already reads as a light source at night.

`renderer.toneMappingExposure` is kept equal to the current exposure. That lets another pipeline, such as the path tracer, use the renderer's AgX with the same exposure.

## Rendering details

- **Depth.** `CompositePass` renders `ctx.backdrop.scene` and `ctx.scene` into their own HalfFloat targets, each with its own depth range. It then merges them and writes one combined depth in an "atmosphere camera" with near 1 m and far 1000 km. N8AO, the atmosphere and the clouds all use that single depth. Transparent main-scene content over the sky, such as rain or smoke plumes, keeps its coverage in alpha and is composited *over* the clouds.
- **Aerial perspective.** `SkyBuffersPass` renders a screen-aligned froxel LUT, a `WebGL3DRenderTarget` of 64×36×(2×32) with exponential depth slices from 8 m to 400 km. It holds in-scatter from the sun, moon and overcast, plus transmittance. The full-resolution pass only does two 3D-texture fetches per pixel.
- **Fake ground.** Sky pixels below the horizon, where nothing was drawn, continue as a hazy lambertian plain, so the horizon never shows the Bruneton "ground" colour.
- **Screenshot mode (`shot=1`).** The pipeline renders on demand. It re-renders only when the camera, time, weather, mesh count or GPU memory counts change, and each frame is finished synchronously. This keeps SwiftShader from queuing frames behind the screenshot. If you change a material or uniform in a screenshot script, call `ctx.get('sky').requestRender()` afterwards.
- **Software GL** (SwiftShader, llvmpipe, or forced with `?skysoft=1`) uses a cheaper configuration:
  - AP LUT of 32×18×16
  - clouds at 1/3 resolution with 9 planes and 3 sub-samples
  - FXAA instead of SMAA
  - N8AO in Performance mode
  - 4 bloom levels
  - a 32² environment cube

## Service `sky`

```ts
interface SkyService {
  sunLight: DirectionalLight;   // mirror of the key light (sun/moon); NOT in the scene graph - clone it for path tracing
  keyLight: Light;              // the SunLight in ctx.scene (cascaded shadows); userData.noPathTrace = true
  setTime(hours: number): void; // sets ctx.env.hours and emits 'time'
  setWeather(w: { cloudCover?, rain?, fog?, cirrus? }): void;   // 0..1, eases over ~4 s (instant in shot mode)
  getWeather(): { cloudCover, rain, fog, cirrus };
  requestRender(): void;        // screenshot mode: force a re-render
  readonly exposure: number;
  readonly radianceScale: number;   // 2
  cloudShadowAt(x, y, z): number;   // coarse CPU estimate (coverage only)
  moonDirection: Vector3;           // = ctx.env.moonDirection
  readonly moonIntensity: number;
  readonly envMap: Texture | null;  // PMREM of the sky (also scene.environment)
  pipeline: SkyPipeline | null;     // composer, apCamera, grade, bloom...
  uniforms: SkyUniforms | null;     // shared shader uniforms (sun/moon dirs, cloud params, fog...)
}
```

The GLSL for cloud coverage and shadow (`skCloudDensityCoarse`, `skCloudShadowAt`) is in `shaders.ts`. A water or glass shader can bind `service.uniforms` and include the same code to get matching reflections of the clouds.

## URL parameters

| param | effect |
|---|---|
| `weather=clear\|fair\|cloudy\|overcast\|rain\|storm\|fog\|haze` | weather preset (default `fair`: 32 % cumulus and some cirrus) |
| `clouds=0..1`, `rain=0..1`, `fog=0..1`, `cirrus=0..1` | override individual weather values |
| `skysoft=0\|1` | force the GPU or the software-GL configuration |
| `skypipe=0` | don't install the post pipeline (lighting only, for debugging) |
| `skylog=1` | log sky state, environment updates and on-demand renders in screenshot mode |
| `skyondemand=0` | render every frame in screenshot mode as well |
| `skytaa=1` | enable temporal cloud accumulation in screenshot mode too (it is always on when interactive) |

The date and time come from the core (`date=`, `time=`). The default date, 2026-07-15, is close to new moon. Use `date=2026-07-29` for a full moon.

## Data and assets (`public/textures/sky/`, about 5.1 MB)

| file | source / licence | notes |
|---|---|---|
| `atmosphere/{transmittance,scattering,irradiance}.exr` | `@takram/three-atmosphere` assets (MIT). Bruneton model, Earth parameters | half-float LUTs (4.1 MB) |
| `stars.bin` | `@takram/three-atmosphere` (MIT), from the Yale Bright Star Catalogue v5 | 9096 stars |
| `clouds.png` | generated by `pipeline/build_sky.py` (CC0, procedural) | 512² RGBA, tileable, 10 km tile |
| `noise3d.bin` | generated by `pipeline/build_sky.py` (CC0, procedural) | 64³ uint8 tileable inverted-Worley fbm (x fastest), 1.1 km period |

The `clouds.png` channels are:

- R: cumulus cells (inverted Worley at 16/32/64 cells, clustered by low-frequency noise)
- G: cirrus streaks (anisotropic spectral noise)
- B: erosion detail
- A: large-scale weather

Each channel is histogram-equalised, so a threshold of (1 − cover) gives roughly that fraction of cover.

## Known limitations and ideas

- The clouds are a 2.5D approximation, not a full 3D noise volume. Screenshots (with no temporal accumulation) keep a faint static grain from the jittered planes, most visible on dark sunset clouds. `@takram/three-clouds` volumetric clouds could replace the plane stack at ultra quality, since their buffers are compatible with this pipeline, but they rely on temporal upscaling, which never converges in screenshots.
- God rays are a screen-space effect. They fade out when the sun leaves the view and do not include shadowed in-scatter along the view ray.
- The shadow cascade count is a shader define. Changing the quality at runtime swaps the shadow and forces a recompile by adding a zero-intensity hemisphere light. This works, but a stall of a few hundred milliseconds is expected.
- `cloudShadowAt()` on the CPU is only a coverage-based estimate.
- On SwiftShader each frame takes about 5–15 s under load. Screenshot mode's on-demand rendering keeps runs possible, but content that streams in late re-triggers renders.
