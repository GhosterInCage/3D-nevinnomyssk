# Physics module (`src/modules/physics`)

Rapier 3D (`@dimforge/rapier3d-compat` 0.21, WASM) world streamed around the player, first-person
walking, a drivable Lada Priora-like car with a chase camera and procedural sound, and physics toys.
Everything is procedural: there is no pipeline script, no `public/data/physics` and no texture files.

## Files

| file | what |
|---|---|
| `index.ts` | module entry, `physics` service, keys (F / G / 1-2-3), teleport + mode wiring |
| `system.ts` | `PhysicsSystem`: Rapier world, fixed 60 Hz step + render interpolation, collision groups, interest points, ray casts, free-space tests |
| `terrain.ts` | streamed terrain collision: 64 m Rapier heightfield tiles (2 m cells) |
| `statics.ts` | streams static colliders from every `ctx.colliderProviders` entry |
| `walk.ts` | `walk` controller (kinematic capsule + `KinematicCharacterController`) |
| `drive.ts` | `drive` controller: road spawn, input mapping, chase / far / bonnet cameras |
| `car.ts` | car dynamics: `DynamicRayCastVehicleController` + drivetrain, brakes, assists, water, skid marks |
| `carShape.ts`, `carModel.ts`, `carTextures.ts` | procedural PBR model of a VAZ-2170 Priora-like sedan |
| `skid.ts` | tyre skid-mark ring buffer |
| `toys.ts` | footballs (F) and wooden crates (G) |
| `audio.ts` | procedural Web Audio engine / tyre / wind sound |
| `hud.ts` | crosshair, speedometer / tachometer / gear, key hints |

## Static world streaming

* **Interest points.** Every frame the walker, the car and awake toys push `{x, z, terrainR, staticR}`
  circles (walker 110 / 75 m; driven car 150 / 110 m + 3 s of look-ahead along its velocity; parked
  car 12 / 0 m; toys ≈ 26 / 14 m). Only these areas have collision.
* **Terrain.** Rapier `heightfield` tiles of 64 m × 64 m with 33 × 33 samples (2 m) built nearest
  first (3 per frame, all at once when forced), evicted ~1.5 s after no interest covers them. Heights
  come from `ctx.get('terrain').heightAt` (Catmull-Rom bicubic, the rendered surface) and fall back
  to the same maths over `ctx.heightfield` when the terrain module is absent. Carriageways get the
  roads module's +8.5 cm asphalt lift (`roads.isRoad`), other ground +2 cm. Tiles are rebuilt when the
  `terrain`/`roads` services appear or `HeightField.version` changes.
* **Static colliders.** All providers are queried around each interest point when it moved more
  than ~8 % of its radius (or every 1.5 s, or when a provider registers). New colliders are created
  nearest first under a 2.5 ms/frame budget; colliders not returned for 4 s are removed. Shapes:
  `box` → cuboid, `cylinder` → cylinder, `trimesh` → trimesh, `prism` → convex hull when the
  footprint is convex (≤ 64 vertices), otherwise walls + earcut caps as a trimesh. Providers today:
  `buildings` (prisms), `vegetation` (tree trunks), `landmarks`, `roads-bridges` (deck trimeshes),
  `roads-furniture`, `roads-rail`, `roads-power`.
* **Collision groups.** STATIC, PLAYER, CAR, TOY. Camera probes and ground rays only test STATIC.

## Walking (`walk`, key 2)

Kinematic capsule (r 0.3 m, 1.8 m tall), Rapier character controller with 0.42 m autostep (curbs,
stairs), 50° max climb, 42° slide, 0.45 m snap-to-ground, pushes dynamic bodies. Walk 2.2 m/s,
sprint (Shift) 6.5 m/s, crouch (C / Ctrl), jump (Space, ≈ 1 m). Eye height 1.7 m, head bob and
sway scaled by speed, landing dip spring, smoothed autostep eye motion, FOV 70°. Swimming where the
`water` service reports depth > 1.25 m (float at head height, drift with `water.flowAt`). Click the
canvas for pointer lock (mouse look); drag-look also works. Entering walk from the air drops you on
the ground below the camera (or on a bridge deck / roof under a low camera); the nearest free spot
is searched when the capsule would intersect something.

## Driving (`drive`, key 3)

* **Spawn.** On the nearest drivable road to the player, preferring streets over service roads /
  tracks and avoiding junction interiors, in the right-hand lane facing along the road (the
  allowed direction on one-way streets, else the one closest to the camera heading). The spot is
  checked for obstacles and moved along the road when blocked. The car settles on its suspension
  before the first frame. R resets the car onto the road; leaving drive mode parks it (handbrake)
  and walking starts at the driver's door. E gets out of the car, and back in when the walker stands
  within 4.5 m of it (a hint appears).
* **Dynamics.** 1150 kg chassis (CoM 0.45 m, two rounded-box colliders), Rapier
  `DynamicRayCastVehicleController` with 4 wheels (185/65 R14, 0.30 m rest, 0.2 m travel), VAZ-21126
  1.6 16V torque curve, 5-speed automatic shifting (+ reverse after holding brake at rest), FWD,
  front-biased brakes, rear handbrake with reduced side grip (drifts), engine braking, aero drag +
  rolling resistance, light downforce, anti-roll bars, speed-sensitive steering limited to what the
  tyres can hold, a mild yaw-rate stability assist, cosmetic body roll / dive / squat, water
  buoyancy and drag, flip recovery, fall-through recovery. Skid marks where tyres slip.
* **Cameras** (V cycles): chase (5.4 m), far chase (9 m), cockpit (driver's eyes, mouse turns the
  head, steering wheel turns with the input) and bonnet. Chase cameras follow the travel direction
  when sliding, ray-cast against static colliders to stay in front of walls / trees, stay above the
  ground, widen FOV with speed, and can be orbited with the mouse (recentres after 1.6 s).
* **Model.** Lofted body and greenhouse from published Priora dimensions (4350 × 1680 × 1420 mm,
  wheelbase 2492 mm), a 1024² painted atlas (panel gaps, door handles, B-pillar trim, grille,
  badges) with clearcoat/roughness/metalness and a normal map from a height canvas. The atlas also
  paints a cut-out mask: window areas are removed from the paint shell (alpha test, so sunlight falls
  into the cabin) and drawn by a separate glass shell (tinted, blended so that the transmitted light
  is attenuated but the Fresnel-weighted reflection is not). Through the glass you see an interior:
  seats with headrests, rear bench, parcel shelf, dashboard with binnacle and gauges (lit at night),
  centre console, gear lever, a steering wheel on its column, mirror, carpet, dark door cards and a
  grey headliner (back faces of the shell). Lamp lenses are projected onto the body with a
  three-mesh-bvh; 5-spoke alloys with tyres (tread + sidewall lettering normal map), brake discs and
  calipers, mirrors, GOST number plates (region 26), exhaust, contact shadow.
  Paint colour: `?carcolor=cherry|silver|white|black|blue|green|beige|<hex>` or
  `physics.setCarColor()`.
* **Lights.** Low beams come on at dusk (`env.night > 0.25`), in fog or rain: emissive lenses plus
  two real `SpotLight`s (shadow-casting on `ultra`); tail lamps glow, brake lamps light when braking,
  reverse lamps when reversing.
* **Sound** (`audio.ts`, Web Audio, no samples): inline-4 engine note (firing frequency from rpm,
  load-dependent filter and drive), intake hiss, tyre squeal from slip, wind and road rumble with
  speed, impact thumps; footsteps while walking (hard on roads / paving / structures, soft on grass
  and soil, splashes when swimming). Starts on the first key / pointer press, fades out outside
  drive mode; off in `shot` mode or with `?audio=0`.

## Toys

F throws a size-5 football (0.43 kg, restitution 0.72) from the camera at 17 m/s plus the player's
velocity; G drops a 0.6 m wooden crate (20 kg) in front. Both use CCD, collide with the world, the
car, the walker and each other, float and drift in rivers, cast/receive shadows (instanced meshes
with procedural textures) and despawn after 5 min, when > 1.5 km away, below the ground, or when the
cap (40 balls, 30 crates) is exceeded. Toys keep the simulation running in fly mode until they sleep.

## Service `physics`

```ts
RAPIER, world, system                      // Rapier namespace, World, PhysicsSystem
raycast(origin, dir, maxDist?)             // {distance, point, normal, collider, kind, key?} | null (falls back to the height field)
spawnBall(pos, vel?) / spawnCrate(pos, vel?) / throwBall() / dropCrate() / clearToys()
setMode('fly' | 'walk' | 'drive'), mode
move(x, y) / look(dx, dy) / jump() / handbrake(on)    // touch / gamepad input (-1..1, y forward)
speed, speedKmh, gear, rpm                  // speedometer values (walk or car)
car      // {x, y, z, heading, speedKmh, gear, rpm} | null
walker   // {x, y, z, grounded, swimming} | null
resetCar(), setCarColor(name|hex), setDriveCamera(0 chase|1 far|2 cockpit|3 bonnet), setHud(on), setAudio(on)
simulate(seconds, {forward, strafe, sprint, throttle, brake, steer, handbrake})  // scripted tests
stats()  // bodies, colliders, terrain tiles, statics, queue, steps, ms
```

URL: `?mode=walk|drive` starts in that mode, `?physhud=1` shows the HUD in shot mode, `?audio=0`.
The UI module owns the mode buttons (1/2/3); without it, physics binds 1/2/3 itself.

## Testing

```
node tools/shot.mjs --only terrain,physics --cam -20,330.2,240,20,0 \
  --eval "(() => { const p = __city.ctx.get('physics'); p.setMode('walk'); return p.simulate(3, {forward: 1}); })()" \
  --out tools/shots/physics/walk.png
node tools/shot.mjs --only terrain,sky,roads,physics --cam -20,330.2,240,20,0 \
  --eval "(() => { const p = __city.ctx.get('physics'); p.setMode('drive'); return p.simulate(4, {throttle: 0.7}); })()" \
  --out tools/shots/physics/drive.png
```

`simulate()` runs the fixed-step simulation synchronously with held inputs and returns JSON with the
car / walker state and world stats.

## Known limitations

* Raised sidewalks (22 cm) and curbs drawn by the roads module have no collision (the ground is the
  terrain + 8.5 cm everywhere on roads), so wheels and feet sink ~14 cm into sidewalks.
* Traffic vehicles are not physics bodies: the player's car drives through them.
* Building colliders are extruded footprints up to the eaves (+ half the roof): no interiors, roof
  shapes are approximate.
* Rapier is excluded from Vite's dependency pre-bundling (WASM); in the dev server its import is
  the slowest part of module init.
