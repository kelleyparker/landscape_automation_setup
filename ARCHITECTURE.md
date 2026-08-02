# WAVEBREAK — shared architecture

This is the contract every contributor builds against. Read it before touching code.

## Hard rules

1. **Zero external assets.** No file loading of any kind. Every mesh is `BufferGeometry`
   built in code, every texture is drawn to a `<canvas>` or generated in a shader, every
   sound is Web Audio oscillators/noise. No `TextureLoader`, no `GLTFLoader`, no fetch.
2. **No PBR.** No `MeshStandardMaterial`, `MeshPhysicalMaterial`, `PMREMGenerator`,
   environment maps, or IBL anywhere. Cel materials come from `src/render/CelMaterial.ts`.
   Anything else is a bug.
3. **One palette.** Import colours from `src/core/Palette.ts`. Never write a hex literal
   in a subsystem file.
4. **One wave definition.** `src/ocean/waveConfig.ts` is the only place wave numbers live.
   The GLSL is *generated* from it (`gerstnerGLSL()`); the CPU sampler
   (`src/ocean/GerstnerCPU.ts`) evaluates the same maths. Never re-derive waves.
5. **Determinism.** All randomness comes from `src/core/Rng.ts` seeded by `?seed=`.
   No `Math.random()` in gameplay or generation code.
6. **Typecheck clean.** `npm run typecheck` must pass. `strict: true` is on.
7. **Performance is a feature.** Target 60fps at dpr 2 on an M-series MacBook.
   Instance repeated meshes, share geometries and materials, never allocate
   `Vector3`/`Color`/arrays inside `update()`. Use module-scope scratch objects.

## Layout

```
src/
  main.ts               bootstrap: engine, game, harness hooks
  Game.ts               composition root — owns every subsystem, wires the loop
  core/
    Engine.ts           renderer, camera, clock, adaptive pixel ratio, loop
    Input.ts            keyboard/gamepad -> BoatInput
    Palette.ts          THE palette + SUN_DIR
    Rng.ts              seeded RNG
    types.ts            cross-subsystem interfaces
    Textures.ts         procedural canvas textures (ramps, matcaps, noise, sparkle)
    CameraRig.ts        spring chase cam, FOV kick, shake, cinematic orbit
  render/
    CelMaterial.ts      the cel ShaderMaterial factory (ramp, rim, banded spec, matcap)
    OutlineHull.ts      inverted-hull outline builder
    Composer.ts         post stack: normal/depth prepass -> Sobel edges -> stylised bloom
    shaders/*.ts        GLSL chunks as template strings
  ocean/
    waveConfig.ts       THE wave contract + GLSL generator
    GerstnerCPU.ts      CPU mirror for buoyancy/wake/gates
    Ocean.ts            infinite surface mesh + water material
    FoamSystem.ts       wake ribbons, spray particles
    shaders/water.ts    water GLSL
  sky/
    Sky.ts              gradient dome, cel clouds, sun + stylised flare
  boat/
    BoatMesh.ts         procedural hull/deck/engine geometry
    Buoyancy.ts         multi-point wave sampling -> forces
    BoatPhysics.ts      arcade handling, drift, boost, airtime
    Boat.ts             entity: mesh + physics + rider + wake, implements Racer
  rider/
    RiderRig.ts         procedural skeleton + segmented cel body
    RiderAnimator.ts    lean, weight shift, crouch, idle bob, celebration
  race/
    Course.ts           CatmullRomCurve3 circuit, wave-riding ribbon, gates, buoys
    RaceDirector.ts     countdown, laps, checkpoints, wrong-way, placement, results
    AIController.ts     lookahead spline following, personalities, avoidance, mistakes
  ui/
    Hud.ts              2D-canvas HUD in the cel style
    Minimap.ts
    Screens.ts          countdown, results, title
  audio/
    Audio.ts            synthesised engine, water rush, impacts, horn
  debug/
    TestHooks.ts        window.__wavebreak for the Playwright harness
```

## Composition root

`Game.ts` constructs subsystems in this order and registers their `update`:

```
Sky -> Ocean -> Course -> Boats(4) -> Riders -> FoamSystem -> RaceDirector
-> AIControllers -> CameraRig -> Hud -> Audio
```

Every subsystem exposes `update(dt, elapsed)`. Nothing reaches into another subsystem's
internals; they communicate through the interfaces in `core/types.ts`.

## Key interfaces

- `Racer` — a boat's public face (state, progress, root object, `setInput`).
- `BoatState` — physics output consumed by camera, HUD, audio, rider animation.
- `BoatInput` — the only thing physics accepts. AI and the player both produce one.
- `RacerProgress` — owned by `RaceDirector`, read by HUD/AI.

## Water sampling

Anything that floats calls `sampleSurface(x, z, t)` / `sampleHeight(x, z, t)` from
`ocean/GerstnerCPU.ts`. `t` is `engine.elapsed`. Do not approximate the surface.

## Materials

`makeCelMaterial({...})` in `render/CelMaterial.ts` returns a `ShaderMaterial` with:
ramp-quantised diffuse (3–4 hard bands, NearestFilter ramp texture), fresnel rim light,
banded specular, optional matcap fake-reflection, and MRT-friendly normal/depth output
for the Sobel pass. Outlines come from `addOutline(mesh, opts)` in `render/OutlineHull.ts`.

## Harness

`window.__wavebreak` (see `debug/TestHooks.ts`) exposes:
- `ready: boolean`
- `advanceTo(seconds)` — fixed-step simulate to an exact moment
- `setShot(name)` / `listShots()` — named camera setups
- `renderFrames(n)`
- `stats()` — draw calls, triangles, programs, fps estimate
- `setInput(partial)` — script the player
- `phase(name)` — jump the race to a phase

`node tools/shoot.mjs --shots a,b --time 12 --out shots/x` captures retina PNGs and
**fails the process on any console error or page error** — a shader that fails to
compile can never pass unnoticed.
