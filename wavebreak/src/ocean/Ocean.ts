import * as THREE from 'three';
import { PALETTE, SUN_DIR, AMBIENT } from '../core/Palette';
import { TEX } from '../core/Textures';
import { WAVES, MAX_WAVE_HEIGHT } from './waveConfig';
import { buildWaterShaders, WATER_MAX_INTERACTORS } from './shaders/water';

/**
 * The ocean surface: one mesh, one material, one draw call, no seams.
 *
 * ## The mesh
 *
 * A radially graded disc centred on the camera. Rings are spaced geometrically -
 * `INNER_SPACING` metres at the centre, multiplied by `RING_GROWTH` every ring -
 * so a ring's width grows roughly in proportion to its distance and the triangles
 * stay about the same size *on screen* from the bow rail out to the horizon. A
 * uniform grid dense enough for the foreground would need something like four
 * million triangles to reach 1900 m; this reaches it with 140 thousand.
 *
 * The disc is a disc and not a projected grid on purpose. A projected grid is
 * denser where it matters and wastes nothing behind the camera, but it has to be
 * clipped against the frustum every frame, it degenerates when the camera pitches
 * through the horizon, and it re-tessellates continuously as the camera turns -
 * which is exactly the crawl this design is built to avoid. A disc is fixed
 * geometry that only ever translates.
 *
 * ## Why it does not swim
 *
 * The disc's centre is snapped to a grid quantised to `INNER_SPACING`, so vertices
 * can only ever occupy a fixed lattice of world positions: as the camera drives,
 * the mesh either stands still or jumps by exactly one quantum. Following the
 * camera continuously instead would slide every vertex smoothly through the wave
 * field, and because a triangle is a *linear* approximation of a curved surface,
 * the approximation error would slide with it - a shimmer crawling over the whole
 * sea that reads as cheap instantly. Snapped, the error pattern is nailed to the
 * world and simply does not move.
 *
 * ## Why the waves do not move with it
 *
 * Displacement is evaluated from the reconstructed world coordinate
 * (`position.xz + uOrigin`) inside the vertex shader, never from the mesh's local
 * position. Sliding the disc changes which parts of the sea are tessellated and
 * nothing else.
 */

// ------------------------------------------------------------------ mesh -----

/**
 * 320 x 220 -> 320 * (2 * 220 - 1) = 140,480 triangles, 70,401 vertices.
 * The split between the two is deliberate: radial detail is cheap to buy (rings
 * grow geometrically) while angular detail is not (every ring costs the same),
 * so the angular count is set by what the *mid* field needs - at 50 m ahead one
 * segment is about a metre, roughly 13 px on a 1280-wide frame, which is finer
 * than the 4.9 m chop needs to read.
 */
const ANGULAR_SEGMENTS = 320;
const RING_COUNT = 220;

/** Innermost ring spacing in metres. Also the camera-follow snap quantum. */
const INNER_SPACING = 0.7;

/**
 * Geometric growth per ring. 1.018 over 220 rings lands the outer edge at about
 * 1931 m - past the 1750 m fog far plane, so the sea reaches full atmosphere
 * before it runs out and there is no edge to see.
 */
const RING_GROWTH = 1.018;

// ------------------------------------------------------------------- LOD -----

/**
 * Waves that survive at long range: the two swells and the first mid wave.
 * Beyond ~200 m the rings are wider than the 16.3 m / 8.7 m / 4.9 m layers, so
 * those three are past Nyquist and contribute nothing but aliased normals. Their
 * combined amplitude is 0.49 m of 2.9 m, and the fade is spread over 320 m, so
 * the surface loses them as a gentle smoothing rather than at a visible ring.
 */
const LOD_WAVE_COUNT = 3;

/**
 * Where the chop fade runs. It starts well beyond the boats (the CPU buoyancy
 * sampler always uses all six waves, so any difference is a mismatch between what
 * a boat floats on and what is drawn under it) and ends before the rings get wide
 * enough for the surviving mid wave to alias in turn. At 200 m the fade has taken
 * about 0.1 m of height, which at that distance is half a pixel.
 */
const CHOP_FADE_START = 110;
const CHOP_FADE_END = 430;

// -------------------------------------------------------------- look ---------

/**
 * Fraction of the theoretical maximum wave height that spans the full band range.
 * The six waves sum to 2.9 m but their *actual* distribution is roughly normal
 * with a standard deviation near 1.07 m, so normalising by the full sum would
 * squash every band into the middle third of the range and the deep and crest
 * colours would essentially never be seen.
 */
const BAND_FRACTION = 0.6;

/**
 * Band edges in 0..1 height space, deliberately uneven. Against the height
 * distribution above these give roughly 25% deep / 32% mid / 27% shallow /
 * 16% crest - the crest colour has to stay rare or it stops reading as a crest.
 */
const BAND_EDGES = new THREE.Vector3(0.26, 0.54, 0.80);

/** Foam tile sizes in metres. Two scales, mutually non-harmonic, so no beat. */
const FOAM_TILE_A = 12.0;
const FOAM_TILE_B = 41.0;
/** Noise tile for the band-edge wobble. Features from ~3 m up. */
const NOISE_TILE = 14.0;
/** Sparkle tile. Sparse stars, so the repeat is not readable. */
const SPARKLE_TILE = 13.0;

// --------------------------------------------------------------- scratch -----

// Module scope. Nothing below may allocate inside update()/follow().
const _dir0 = new THREE.Vector2(WAVES[0]!.dirX, WAVES[0]!.dirZ).normalize();
const _dir1 = new THREE.Vector2(WAVES[1]!.dirX, WAVES[1]!.dirZ).normalize();
const _speed0 = WAVES[0]!.speed;
const _speed1 = WAVES[1]!.speed;

/**
 * Builds the graded disc in the XZ plane, centred on the origin, wound so faces
 * point at +Y. Ring `j` sits at `sum(INNER_SPACING * RING_GROWTH^i)` for i < j.
 */
function buildGradedDisc(): { geometry: THREE.BufferGeometry; outerRadius: number } {
  const A = ANGULAR_SEGMENTS;
  const R = RING_COUNT;

  const vertexCount = 1 + A * R;
  const positions = new Float32Array(vertexCount * 3);

  // Ring 0 of the buffer is the single centre vertex, already (0, 0, 0).
  const cosT = new Float32Array(A);
  const sinT = new Float32Array(A);
  for (let i = 0; i < A; i++) {
    const th = (i / A) * Math.PI * 2;
    cosT[i] = Math.cos(th);
    sinT[i] = Math.sin(th);
  }

  let radius = 0;
  let spacing = INNER_SPACING;
  for (let j = 0; j < R; j++) {
    radius += spacing;
    spacing *= RING_GROWTH;
    const base = (1 + j * A) * 3;
    for (let i = 0; i < A; i++) {
      positions[base + i * 3 + 0] = cosT[i]! * radius;
      positions[base + i * 3 + 1] = 0;
      positions[base + i * 3 + 2] = sinT[i]! * radius;
    }
  }
  const outerRadius = radius;

  const triangleCount = A * (2 * R - 1);
  // Well past 65k vertices, so 32-bit indices are mandatory.
  const indices = new Uint32Array(triangleCount * 3);
  let k = 0;

  // Centre fan. Reversed winding (0, next, current) because in a right-handed
  // XZ plane the naive order faces -Y.
  for (let i = 0; i < A; i++) {
    indices[k++] = 0;
    indices[k++] = 1 + ((i + 1) % A);
    indices[k++] = 1 + i;
  }

  // Ring quads. No seam vertex is needed: the angular index simply wraps.
  for (let j = 0; j < R - 1; j++) {
    const inner = 1 + j * A;
    const outer = inner + A;
    for (let i = 0; i < A; i++) {
      const i1 = (i + 1) % A;
      const a = inner + i;
      const b = inner + i1;
      const c = outer + i;
      const d = outer + i1;
      indices[k++] = a; indices[k++] = d; indices[k++] = c;
      indices[k++] = a; indices[k++] = b; indices[k++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // The mesh never moves (uOrigin does), and it is never culled, but three still
  // wants a bounding volume for raycasts and for its own sanity checks.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), outerRadius + MAX_WAVE_HEIGHT + 2);
  geometry.name = 'oceanDisc';

  return { geometry, outerRadius };
}

// --------------------------------------------------------------- Ocean -------

export interface OceanInteractor {
  x: number;
  z: number;
  radius: number;
  strength: number;
}

export class Ocean {
  readonly mesh: THREE.Mesh;
  readonly outerRadius: number;

  private readonly scene: THREE.Scene;
  private readonly material: THREE.ShaderMaterial;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly interactors: THREE.Vector4[] = [];

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;

    const { geometry, outerRadius } = buildGradedDisc();
    this.outerRadius = outerRadius;

    for (let i = 0; i < WATER_MAX_INTERACTORS; i++) {
      this.interactors.push(new THREE.Vector4(0, 0, 1, 0));
    }

    this.uniforms = {
      // --- shared cel lighting block (celChunks CEL_LIGHTING) ----------------
      uRamp: { value: TEX.rampWater },
      uSunDir: { value: SUN_DIR.clone() },
      uSunColor: { value: new THREE.Color(1.0, 0.985, 0.94) },
      uAmbient: { value: AMBIENT.clone() },
      uRimColor: { value: PALETTE.waterCrest.clone() },
      uRimPower: { value: 2.6 },
      uRimStrength: { value: 0.0 },
      uSpecColor: { value: PALETTE.foam.clone() },
      // A narrow, hard highlight: at power 110 the outer step is ~9 degrees wide
      // and the hot core ~6, which reads as a drawn glint rather than a sheen.
      uSpecThreshold: { value: 0.22 },
      uSpecPower: { value: 110 },
      uSpecStrength: { value: 0.62 },
      uSpecSoftness: { value: 0.02 },
      uMatcap: { value: TEX.matcapGloss },
      uMatcapStrength: { value: 0.0 },
      // Water is nearly flat; a wide wrap would smear the terminator across the
      // whole swell and cost the sea its form.
      uWrap: { value: 0.14 },
      uCameraFar: { value: camera.far },

      // --- vertex -----------------------------------------------------------
      uOrigin: { value: new THREE.Vector2() },
      uTime: { value: 0 },
      uChopFade: { value: new THREE.Vector2(CHOP_FADE_START, CHOP_FADE_END) },

      // --- bands ------------------------------------------------------------
      uBandDeep: { value: PALETTE.waterDeep.clone() },
      uBandMid: { value: PALETTE.waterMid.clone() },
      uBandShallow: { value: PALETTE.waterShallow.clone() },
      uBandCrest: { value: PALETTE.waterCrest.clone() },
      uBandEdges: { value: BAND_EDGES.clone() },
      uBandFraction: { value: BAND_FRACTION },
      uBandJitter: { value: 0.08 },

      // --- sky response -----------------------------------------------------
      uSkyNear: { value: PALETTE.skyMid.clone() },
      uSkyFar: { value: PALETTE.skyHorizon.clone() },
      uFresnelPower: { value: 4.0 },
      uFresnelEdges: { value: new THREE.Vector2(0.22, 0.58) },
      uFresnelStrength: { value: new THREE.Vector2(0.30, 0.62) },

      // --- backlit crest ----------------------------------------------------
      uTranslucent: { value: PALETTE.waterTranslucent.clone() },
      uTransCut: { value: 0.33 },
      uTransStrength: { value: 0.92 },
      uTransFade: { value: new THREE.Vector2(120, 460) },

      // --- foam -------------------------------------------------------------
      uFoamTex: { value: TEX.foam },
      uFoamColor: { value: PALETTE.foam.clone() },
      uFoamShadeColor: { value: PALETTE.foamShade.clone() },
      uFoamScrollA: { value: new THREE.Vector2() },
      uFoamScrollB: { value: new THREE.Vector2() },
      uFoamScaleA: { value: 1 / FOAM_TILE_A },
      uFoamScaleB: { value: 1 / FOAM_TILE_B },
      // Measured over 200k samples of the shipped wave set the Jacobian runs
      // 0.82 .. 1.19, median 1.00, 5th percentile 0.90. Foam therefore starts
      // just under the median and saturates at that 5th percentile, so the
      // whitecaps land on the most pinched twentieth of the sea and nowhere else.
      uFoamJac: { value: new THREE.Vector2(0.90, 1.005) },
      uFoamHeightGate: { value: new THREE.Vector2(0.50, 0.74) },
      uFoamGain: { value: 1.6 },
      uFoamCut: { value: new THREE.Vector2(1.90, 1.46) },
      uFoamCutJitter: { value: 0.40 },
      uFoamStrength: { value: 1.0 },
      // Every patch keeps a 0.07 rim of foamShade; the side facing away from the
      // sun grows to 0.31, which is what stops the whitecaps reading as stickers.
      uFoamRim: { value: new THREE.Vector2(0.07, 0.24) },

      // --- sparkle ----------------------------------------------------------
      uSparkleTex: { value: TEX.sparkle },
      uNoiseTex: { value: TEX.noise },
      uNoiseScale: { value: 1 / NOISE_TILE },
      uSparkleScale: { value: 1 / SPARKLE_TILE },
      uSparkleLobe: { value: 10 },
      uSparkleCut: { value: 0.60 },
      uSparkleRate: { value: 2.4 },
      uSparkleStrength: { value: 1.25 },
      uSparkleFade: { value: new THREE.Vector2(90, 340) },

      // --- hull interaction -------------------------------------------------
      uInteractors: { value: this.interactors },
      uWakeCut: { value: 0.86 },
      uWakeDarken: { value: 0.3 },
      uWakeFoam: { value: 0.80 },

      // --- atmosphere / g-buffer --------------------------------------------
      uFogColor: { value: PALETTE.skyHorizon.clone() },
      uFogRange: { value: new THREE.Vector2(260, 1750) },
      uEdgeMask: { value: new THREE.Vector2(0.12, 0.2) },
    };

    const { vertexShader, fragmentShader } = buildWaterShaders(LOD_WAVE_COUNT, WATER_MAX_INTERACTORS);

    this.material = new THREE.ShaderMaterial({
      name: 'OceanWater',
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      lights: false,
      fog: false, // fog is applied by hand so it can key off the same uniforms
      transparent: false,
      depthWrite: true,
      depthTest: true,
      // DoubleSide costs essentially nothing here - at this steepness the sea has
      // no back faces from above - but it means a camera that dips behind a crest
      // sees water rather than a hole through to the sky.
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'ocean';
    // The disc is repositioned through uOrigin, not through its transform, so its
    // object-space bounds say nothing about where it is on screen. Culling it
    // against them would cull the whole sea the moment the camera looked away
    // from the world origin.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 0;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;

    scene.add(this.mesh);

    this.syncFog();
    this.follow(camera);
  }

  // ---------------------------------------------------------------- tick -----

  /**
   * One uniform write per animated value - no traversal, no allocation, and the
   * whole surface is a pure function of `elapsed`, so a given (seed, time) pair
   * reproduces the identical frame.
   */
  update(_dt: number, elapsed: number): void {
    this.uniforms.uTime!.value = elapsed;

    // Foam scroll. A Gerstner crest satisfies k*(d.p) + omega*t = const, so
    // differentiating along the crest gives d.v = -speed: crests travel along
    // *minus* the configured direction. A parcel of foam therefore follows
    // p(t) = p0 - d*speed*t, and adding +d*speed*t back to the sampling
    // coordinate holds the texture still relative to the crest it sits on. Scroll
    // it with time alone instead and the foam pattern crawls through the crests,
    // which is the single most obvious tell in stylised water.
    this.setScroll(this.uniforms.uFoamScrollA!.value as THREE.Vector2, _dir0, _speed0, elapsed, FOAM_TILE_A);
    this.setScroll(this.uniforms.uFoamScrollB!.value as THREE.Vector2, _dir1, _speed1, elapsed, FOAM_TILE_B);

    this.syncFog();
  }

  /**
   * Wraps the scroll to one texture period so the value stays small however long
   * the race runs. The tile is seamless, so shifting by a whole period lands on
   * the identical texel - this is exact, not an approximation.
   */
  private setScroll(
    out: THREE.Vector2,
    dir: THREE.Vector2,
    speed: number,
    elapsed: number,
    tile: number
  ): void {
    out.set((dir.x * speed * elapsed) % tile, (dir.y * speed * elapsed) % tile);
  }

  /** Mirrors `scene.fog` so the sea and the sky arrive at the same horizon value. */
  private syncFog(): void {
    const fog = this.scene.fog;
    if (fog instanceof THREE.Fog) {
      (this.uniforms.uFogColor!.value as THREE.Color).copy(fog.color);
      (this.uniforms.uFogRange!.value as THREE.Vector2).set(fog.near, fog.far);
    }
  }

  /**
   * Re-centres the disc on the camera, snapped to the finest ring spacing.
   *
   * Called from the late-update pass, after the camera rig has settled, so the
   * mesh is never a frame behind the view it is built around.
   */
  follow(camera: THREE.PerspectiveCamera): void {
    const q = INNER_SPACING;
    const origin = this.uniforms.uOrigin!.value as THREE.Vector2;
    origin.set(
      Math.round(camera.position.x / q) * q,
      Math.round(camera.position.z / q) * q
    );
    this.uniforms.uCameraFar!.value = camera.far;
  }

  /**
   * Hull disturbance rings. Entries past the eighth are dropped rather than
   * queued: the loop bound is baked into the shader, and eight is every boat in
   * the race plus spares.
   */
  setInteractors(list: OceanInteractor[]): void {
    const n = Math.min(list.length, WATER_MAX_INTERACTORS);
    for (let i = 0; i < n; i++) {
      const it = list[i]!;
      this.interactors[i]!.set(it.x, it.z, Math.max(it.radius, 0.01), it.strength);
    }
    // Empty slots keep a legal radius and zero strength, so the shader's max()
    // ignores them without needing a branch.
    for (let i = n; i < WATER_MAX_INTERACTORS; i++) {
      this.interactors[i]!.set(0, 0, 1, 0);
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
