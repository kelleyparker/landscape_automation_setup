import * as THREE from 'three';
import { PALETTE, SUN_DIR, AMBIENT } from '../core/Palette';
import { TEX, makeRampTexture } from '../core/Textures';
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
 * The wave LOD is a two-stage cascade, because the mesh's ability to carry a
 * wavelength keeps falling all the way to the horizon rather than falling once.
 * Ring spacing is about `0.018 * radius`, and a Gerstner term needs roughly four
 * rings per wavelength before its normals start jumping between neighbours:
 *
 *     4.9 m  -> useless past  ~30 m      8.7 m -> past  ~80 m
 *    16.3 m  -> useless past ~190 m     27.5 m -> past ~350 m
 *
 * So the two chop layers go first (six terms -> four), then the two mid waves
 * (four -> two), leaving the 78 m and 51 m swells to carry the far sea. The old
 * single stage dropped three terms at once and then kept the 27.5 m wave alone
 * for the entire far field at two rings per wavelength, which is exactly where
 * the drawn surface came apart.
 */
export const MID_WAVE_COUNT = 4;
export const FAR_WAVE_COUNT = 2;

/**
 * Where the chop fade runs. It starts well beyond the boats (the CPU buoyancy
 * sampler always uses all six waves, so any difference is a mismatch between what
 * a boat floats on and what is drawn under it) and is spread over 300 m, so the
 * surface loses the two chop layers - 0.21 m of 2.9 m - as a gentle smoothing
 * rather than at a visible ring.
 */
export const CHOP_FADE_START = 100;
export const CHOP_FADE_END = 400;

/**
 * The second stage, over an even longer 660 m so it is even less findable, and
 * deliberately overlapping the first: two fades that meet edge to edge leave a
 * plateau between them, and a plateau bounded by two transitions is a ring by
 * another name.
 */
export const SWELL_FADE_START = 340;
export const SWELL_FADE_END = 1000;

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
 * Band edges in 0..1 height space, deliberately uneven. h01 is roughly normal
 * about 0.5 with a standard deviation near 0.31, so against that distribution
 * these five bands land at about 12% abyss / 20% deep / 26% mid / 25% shallow /
 * 17% crest. Five and not four: with four, the sea stepped from mid-blue
 * straight to foam white with no shoulder, and the whole trough interior was one
 * unbroken navy fill over a fifth of the frame. The abyss band gives the deep
 * water a deep/mid read of its own and the crest band gives the ramp a
 * shoulder under the foam.
 */
const BAND_EDGE_0 = 0.13;
const BAND_EDGES = new THREE.Vector3(0.35, 0.60, 0.80);

/** Foam tile sizes in metres. Three scales, mutually non-harmonic, so no beat. */
const FOAM_TILE_A = 12.0;
const FOAM_TILE_B = 41.0;
/** The carve tile: small, so it punches holes rather than moving the silhouette. */
const FOAM_TILE_C = 3.7;
/** Noise tile for the band-edge wobble. Features from ~3 m up. */
const NOISE_TILE = 14.0;
/**
 * The haze-edge wobble's own tile, and it has to be this much coarser.
 *
 * The band wobble is read from the 14 m tile, whose fbm base octave puts its
 * features around 3.5 m; that is right for an edge you meet at ten metres and
 * catastrophic for one you meet at eight hundred, where a dozen features land
 * inside a pixel and a hard step through them returns a coin toss per pixel.
 * That was the pepper across the whole mid-to-far field. At 260 m the same
 * field's features are ~65 m across - which is also simply the right scale for
 * the mark, since a haze edge should wobble like a brush stroke and not like
 * grain - and they stay several pixels wide out to the fog plane.
 */
const HAZE_NOISE_TILE = 260.0;
/**
 * A second, coarser octave for the same edge. 620 m is not harmonic with 260 m,
 * so the two never line up into a repeat, and its features are ~155 m across -
 * still several pixels wide at the fog plane. One octave is a sine; two is a
 * brush stroke, and a brush stroke is what makes the last two haze edges read as
 * two interlocking painted regions rather than as one fill with a wavy border.
 */
const HAZE_NOISE_TILE_2 = 620.0;
/** Sparkle tile. Sparse stars, so the repeat is not readable. */
const SPARKLE_TILE = 26.0;
/**
 * Facet-jitter tile for the sparkle's normal. Deliberately *coarser* than the
 * star tile: the facet decides whether a star lights, so if it varies faster
 * than the star is wide it chews each star into a cluster of speckle, which is
 * the very crawl the sparkle pass is meant to replace. Coarse facet, fine star.
 */
const SPARKLE_FACET_TILE = 7.0;

// ------------------------------------------------------------ water ramp -----

/**
 * The ocean's own lighting ramp, and the reason it is not `TEX.rampWater`.
 *
 * Two things in the shared water ramp were rotating the sea off the palette,
 * both measurable rather than matters of taste:
 *
 *  1. **Wash.** `wbCelDiffuse`'s washed path is `bandLight * (0.10 + 0.90*alum)`.
 *     Water's albedo luma is about 0.03, so the constant 0.10 dominates and the
 *     washed value is a near-neutral grey. At the old 10% it lifted the abyss's
 *     linear red from 0.0065 to 0.0272 - a 4x lift on the one channel whose
 *     smallness *is* deep blue - and the darkest fifth of the sea lost a third
 *     of its chroma. The wash exists to rescue hulls whose albedo has no
 *     headroom left; the ocean authors five band colours off wave height and has
 *     no such problem, so 2% is all it needs to keep the darks off the gamut
 *     edge.
 *
 *  2. **A cool shadow step.** The old shadow light (0.20, 0.25, 0.42) has
 *     B/G = 1.68. On an albedo that is already blue-dominant (waterDeep's B/G is
 *     4.2) that multiplies out to 7.1 and rotates the band from hue 214 to hue
 *     223 - which is `ink`'s hue exactly. "Cool the shadows" is right for a warm
 *     hull and wrong here: the sea's own colour *is* the cool end of the
 *     palette, so cooling it further can only walk it into the outline colour.
 *     The steps below are near-neutral with a whisper of warmth, sized to cancel
 *     the ambient term (which is bluer than waterDeep) rather than to add to it.
 *     The ink line goes on carrying the cool dark, which is where this project
 *     puts it everywhere else.
 *
 * Predicted, simulated through the exact linear chain including the composer's
 * 1.06 saturation lift, across every band x every step:
 *
 *   deep family hue   217.3 .. 223.0  ->  214.0 .. 217.4   (waterDeep = 213.8)
 *   deep family sat    0.67 .. 0.91   ->   0.87 .. 0.94    (waterDeep = 0.92)
 *
 * These are light *multipliers* - the form `RampBand.light` is documented as -
 * not colours, so no hex literal is introduced. Cost: one 128x1 RGBA
 * DataTexture, 512 bytes. `TEX.rampWater` is left in place for any other
 * consumer; today the ocean was its only one.
 */
const WATER_RAMP = makeRampTexture([
  { upto: 0.46, light: new THREE.Color(0.440, 0.400, 0.368), wash: 0.02 },
  { upto: 0.74, light: new THREE.Color(0.720, 0.698, 0.686), wash: 0.02 },
  { upto: 1.01, light: new THREE.Color(1.080, 1.020, 0.960), wash: 0.02 },
]);

/**
 * The water's own ambient. `AMBIENT` is a scene-wide sky bounce at hue 218, and
 * adding it un-tinted to an albedo at hue 214 pushes the result the same way the
 * old shadow step did. Pulling a fifth of it toward `waterDeep` keeps it a sky
 * bounce - it is still much lighter and much less saturated than the water - and
 * stops the fill drifting toward ink at exactly the values where the drift shows.
 */
const WATER_AMBIENT = AMBIENT.clone().lerp(PALETTE.waterDeep, 0.20);

/**
 * Legibility floor for the darkest band. `CEL_LIGHTING` declares `uShadowFloor`
 * and the ocean never supplied it, so GL left it at zero and the water had no
 * guard at all. It is deliberately quiet - under normal sun nothing in the sea
 * is dark enough to trip it - and it is `waterMid` rather than a neutral, so if
 * it ever does fire it lifts toward the sea's own hue instead of greying it.
 */
const WATER_SHADOW_FLOOR = PALETTE.waterMid.clone().multiplyScalar(0.10);

/**
 * The single distance ramp every drawn mark on the water fades along, in metres
 * of view depth. Deliberately enormous: the failure this replaces was a set of
 * narrow fades that all landed within a few screen rows of each other, which read
 * as a hard LOD ring with a band of per-pixel speckle just past it. Spread over
 * 600 m no single row carries a visible share of the transition.
 */
const DETAIL_FADE_START = 55;
const DETAIL_FADE_END = 900;

/**
 * The water's own aerial perspective.
 *
 * The near end is the water's own: it needs haze earlier than the course
 * furniture does, because a wave face at 300 m is already asking the eye to read
 * five flat tones inside a couple of screen rows. The *far* end is the scene
 * fog's, read from `THREE.Fog` in `syncFog()` rather than written here, and that
 * is the point - the sea and every gate, buoy and rival boat floating on it now
 * arrive at the horizon colour at the same distance. Ending the water's ramp
 * short of the fog plane was what left the last few hundred metres as one flat
 * pale slab with fully-saturated course furniture sitting on top of it, and the
 * slab's outer edge as a hard line against the sky.
 *
 * The curve is under 1, so most of the ladder is still spent in the near half of
 * the range where the sea is legible, and the last steps are stretched out over
 * the distance where the horizon actually forms.
 */
const HAZE_NEAR = 190;
const HAZE_CURVE = 0.74;
/**
 * Where the four painted haze layers cut in, in haze-ramp space. Four and not
 * three: the last step used to land at 0.84 with everything past it flat, so the
 * final approach to the horizon - which is most of what a high camera sees - had
 * no steps left in it at all.
 */
const HAZE_EDGES = new THREE.Vector4(0.24, 0.47, 0.68, 0.87);

// -------------------------------------------------------- derived colours ----

/**
 * Colours the palette does not name but that are pure functions of ones it does.
 * Deriving rather than adding entries keeps the hue relationships locked to the
 * palette: retint `waterDeep` and every one of these follows.
 *
 * All of them are built by mixing palette entries, never by rotating hue in HSL.
 * That is not a style preference: these colours are already linear, and
 * `waterDeep` sits at linear hue 0.636 - within a hair of pure blue - so a shift
 * of even +0.02 drives its green channel to exactly zero and the band comes out
 * of the frame as a near-black hole rather than as a deep blue.
 */

/**
 * The interior of a trough: `waterDeep` carried down toward the palette's ink.
 *
 * The previous derivation pulled it 20% toward `racerP3` - the violet hull
 * colour - to buy hue separation from the deep band. In linear terms that is a
 * brutal move: `racerP3` has more red than green, so a fifth of it is enough to
 * invert the two channels, and the darkest fifth of the sea came out of the frame
 * as plum. On a wide shot those read as oil slicks lying on the water rather than
 * as deep water, because nothing else in the sea is anywhere near that hue.
 *
 * `ink` is the palette's own deep indigo and is what everything else in the game
 * darkens toward, so the band stays unambiguously water, keeps `waterDeep`'s
 * blue-dominant channel order at every mix, and still separates from it - by
 * value, and by the small drop in chroma that going toward the ink brings with
 * it. There is no path from here to a warm hue: the darkest input is bluer than
 * the lightest, the water ramp's shadow step is cool, and both fresnel targets
 * are sky colours.
 *
 * The pull is 0.26 and not the 0.42 it was. `ink` sits at hue 224 against
 * `waterDeep`'s 214, so 42% of it pre-rotated the band four degrees toward the
 * outline colour before a single light hit it, and the ramp's cool shadow step
 * then carried it the rest of the way. At 0.26 the band still separates from
 * `BAND_DEEP` by value - simulated, 0.29 against 0.33 at the shadow step, the
 * same gap as before - without spending any of the separation budget on hue.
 */
const BAND_ABYSS = PALETTE.waterDeep.clone().lerp(PALETTE.ink, 0.26);
const BAND_DEEP = PALETTE.waterDeep.clone();
/** Subsurface note in the trough floor: the shallow cyan pulled into the navy. */
const DEEP_TINT = PALETTE.waterDeep.clone().lerp(PALETTE.waterShallow, 0.34);
/**
 * The hot inner lip of a backlit crest.
 *
 * This used to be the jade pulled a third of the way toward `sunGlow`, on the
 * argument that the water needed one warm note. In *linear* space that lerp is
 * not a warm note, it is a channel inversion: sunGlow's red is 1.0 and the
 * jade's is 0.072, so 34% of it drives red to 0.39 and the result lands at
 * sRGB (164, 231, 185) - hue 139, saturation 0.29. A pale sage green. Over a
 * stroke a few pixels wide nobody would name it; over the plates the old gate
 * produced it read as a sandbar lying on the sea, which is what `lowwater`
 * showed at 128k contiguous pixels.
 *
 * Toward `foam` instead it is the same jade, one value step up and a little
 * paler, which is what light exiting a thin crest actually looks like. The hue
 * separation the warm pull was buying is already there: at 171 the jade is the
 * palette's only break from the 186-214 blue-cyan axis the rest of the sea
 * lives on.
 *
 * The pull is 0.26 and not 0.40. At 0.40 this lands on sRGB (167, 245, 233) -
 * saturation 0.32 - and the frames showed why that is too far: measured over the
 * reference `lowwater` horizon the pale mix outnumbered the jade itself 2.7 to 1,
 * so the mark's *average* colour was the washed tone rather than the chroma, and
 * a low-chroma mint over any area at all reads as shallow ground. At 0.26 it is
 * (136, 243, 225), saturation 0.44 - still clearly the brighter inner lip, still
 * unmistakably the same jade. The hot tone is meant to be the highlight inside
 * the stroke, not the stroke.
 */
const TRANSLUCENT_HOT = PALETTE.waterTranslucent.clone().lerp(PALETTE.foam, 0.26);
/** Glint colour: foam with a warm core, so the sun track is not just white. */
const SPARKLE_COLOR = PALETTE.foam.clone().lerp(PALETTE.sunCore, 0.55);
/** Ink for the foam contour. The scene ink, lifted so it reads as a line not a hole. */
const FOAM_INK = PALETTE.inkSoft.clone().lerp(PALETTE.waterDeep, 0.45);

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
      uRamp: { value: WATER_RAMP },
      uSunDir: { value: SUN_DIR.clone() },
      uSunColor: { value: new THREE.Color(1.0, 0.985, 0.94) },
      uAmbient: { value: WATER_AMBIENT.clone() },
      // Declared by CEL_LIGHTING and previously never supplied by this material,
      // so GL left all four at zero. uShadowFloor is the one that matters (see
      // WATER_SHADOW_FLOOR); uBandBias belongs to symmetric standing figures and
      // is correctly 0 here, and the two rim numbers are dead while
      // uRimStrength is 0 but are supplied so the block is complete.
      uShadowFloor: { value: WATER_SHADOW_FLOOR.clone() },
      uBandBias: { value: 0.0 },
      uRimColor: { value: PALETTE.waterCrest.clone() },
      uRimPower: { value: 2.6 },
      uRimStrength: { value: 0.0 },
      uRimThreshold: { value: 0.55 },
      uRimWidth: { value: 0.18 },
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
      uSwellFade: { value: new THREE.Vector2(SWELL_FADE_START, SWELL_FADE_END) },

      // --- bands ------------------------------------------------------------
      uBandAbyss: { value: BAND_ABYSS.clone() },
      uBandDeep: { value: BAND_DEEP.clone() },
      uBandMid: { value: PALETTE.waterMid.clone() },
      uBandShallow: { value: PALETTE.waterShallow.clone() },
      uBandCrest: { value: PALETTE.waterCrest.clone() },
      uBandEdge0: { value: BAND_EDGE_0 },
      uBandEdges: { value: BAND_EDGES.clone() },
      uBandFraction: { value: BAND_FRACTION },
      uBandJitter: { value: 0.09 },

      uDeepTint: { value: DEEP_TINT.clone() },
      // The lower fifth of the height range, and only where it is turned up at
      // the sun - so it lands on trough floors and not on the faces beside them.
      uDeepTintGate: { value: new THREE.Vector2(0.05, 0.34) },
      uDeepTintCut: { value: 0.40 },
      uDeepTintStrength: { value: 0.60 },

      uDetailFade: { value: new THREE.Vector2(DETAIL_FADE_START, DETAIL_FADE_END) },

      // --- sky response -----------------------------------------------------
      uSkyNear: { value: PALETTE.skyMid.clone() },
      uSkyFar: { value: PALETTE.skyHorizon.clone() },
      uFresnelPower: { value: 4.0 },
      uFresnelEdges: { value: new THREE.Vector2(0.22, 0.58) },
      uFresnelStrength: { value: new THREE.Vector2(0.30, 0.62) },

      // --- backlit crest ----------------------------------------------------
      uTranslucent: { value: PALETTE.waterTranslucent.clone() },
      uTranslucentHot: { value: TRANSLUCENT_HOT.clone() },
      // Flat water sits at ndl 0.68 under this sun, so the window opens just
      // above that: only a face actively tilted into the sun clears it, which is
      // exactly the sun-facing lip of a crest and not the shadow-side face. It
      // opens marginally lower than it did (0.70 -> 0.66) to buy back the area
      // the much narrower pinch ring below gives up - the ndl gate was never the
      // term that was misfiring, so widening it costs nothing structural.
      uTransFacing: { value: new THREE.Vector2(0.66, 0.88) },
      uTransThin: { value: new THREE.Vector2(0.48, 0.74) },
      /**
       * The gate this term was missing: the surface has to actually be a crest.
       *
       * x/y is a window on the same Jacobian pinch the foam keys off. The lower
       * edge is where a lip starts to exist at all; z/w rolls the jade back off
       * again at the top of the pinch, where the whitecap takes over, so the
       * jade sits as a band *under* the white rather than fighting it for the
       * same pixels. That is also where subsurface light actually exits a wave -
       * the foam is opaque, the shoulder below it is not.
       *
       * Narrowed hard from (0.14, 0.46, 0.78, 1.00), and the roll-off in the
       * shader is now total instead of 85%. Those numbers described a *cap* on
       * the wave - open from a barely-there pinch all the way to the top, with a
       * residue surviving even under the foam - and a cap is a fill. Measured on
       * the reference frames it drew one connected jade mass over 2.9% of
       * lowwater. What is wanted is the strip between "pinching" and "breaking",
       * which on a real wave is a metre or two wide, and which in the far field -
       * where the pinch field flattens into a plateau - traces that plateau's
       * contour instead of painting its interior.
       */
      uTransPinch: { value: new THREE.Vector4(0.20, 0.40, 0.50, 0.72) },
      /**
       * x = uv per metre, y = feature cell, both fed to the shader's wbResolve.
       * A lip may be drawn while a pixel covers less than about 4.3 m of sea and
       * is gone by about 19 m - i.e. while a crest is still several pixels wide.
       * See the lipRes block in water.ts for why this, and not any surface
       * property, is what separates a stroke from a sandbar.
       */
      uTransResolve: { value: new THREE.Vector2(1 / 26.0, 0.55) },
      // The lower cut opens the jade band wherever the ring exists at all; the
      // upper one is well inside it, so the pale hot tone is the highlight in the
      // stroke rather than the stroke. At the old 0.52 the hot colour won two
      // pixels in three and the mark's average was the wash, not the chroma.
      uTransCut: { value: new THREE.Vector2(0.18, 0.66) },
      uTransStrength: { value: new THREE.Vector2(0.96, 0.42) },
      uTransFade: { value: new THREE.Vector2(160, 620) },

      // --- crest strokes ----------------------------------------------------
      uStrokeColor: { value: PALETTE.waterCrest.clone() },
      uStrokeGain: { value: 1.55 },
      // Below the foam bar, so the strokes form a shoulder around every whitecap
      // and go on appearing on crests that never break at all.
      uStrokeCut: { value: 1.62 },
      uStrokeStrength: { value: 0.82 },

      // --- foam -------------------------------------------------------------
      uFoamTex: { value: TEX.foam },
      uFoamColor: { value: PALETTE.foam.clone() },
      uFoamShadeColor: { value: PALETTE.foamShade.clone() },
      uFoamScrollA: { value: new THREE.Vector2() },
      uFoamScrollB: { value: new THREE.Vector2() },
      uFoamScaleA: { value: 1 / FOAM_TILE_A },
      uFoamScaleB: { value: 1 / FOAM_TILE_B },
      uFoamScaleC: { value: 1 / FOAM_TILE_C },
      uFoamCarve: { value: 0.44 },
      // Measured over 200k samples of the shipped wave set the Jacobian runs
      // 0.82 .. 1.19, median 1.00, 5th percentile 0.90. Foam therefore starts
      // just under the median and saturates at that 5th percentile, so the
      // whitecaps land on the most pinched twentieth of the sea and nowhere else.
      uFoamJac: { value: new THREE.Vector2(0.90, 1.005) },
      uFoamHeightGate: { value: new THREE.Vector2(0.50, 0.74) },
      uFoamGain: { value: 1.6 },
      // x = near, y = far. The far bar is now *higher* than the near one: past
      // the LOD ring the old lower bar exploded the foam into flat white plates
      // and then into horizon confetti. Fewer marks with distance, not more.
      uFoamCut: { value: new THREE.Vector2(2.16, 2.62) },
      uFoamCutJitter: { value: 0.34 },
      uFoamStrength: { value: 1.0 },
      // Every patch keeps a 0.07 rim of foamShade; the side facing away from the
      // sun grows to 0.31, which is what stops the whitecaps reading as stickers.
      uFoamRim: { value: new THREE.Vector2(0.07, 0.24) },
      // Roughly three pixels of guaranteed mark width at 1440p.
      uFoamWidthClamp: { value: 0.13 },
      uFoamInk: { value: FOAM_INK.clone() },
      uFoamInkWidth: { value: 0.075 },
      uFoamInkStrength: { value: 0.62 },

      // --- sparkle ----------------------------------------------------------
      uSparkleTex: { value: TEX.sparkle },
      uNoiseTex: { value: TEX.noise },
      uNoiseScale: { value: 1 / NOISE_TILE },
      uSparkleScale: { value: 1 / SPARKLE_TILE },
      uSparkleColor: { value: SPARKLE_COLOR.clone() },
      uSparkleFacetScale: { value: 1 / SPARKLE_FACET_TILE },
      uSparkleRough: { value: 0.85 },
      // A hard window on the facet's alignment with the sun, not a power lobe.
      // Flat water under this sun lands near 0.45 with the camera low, so the
      // window straddles it: the jittered facets fall on either side of the edge
      // and the field breaks into discrete on/off stars.
      uSparkleFacetEdges: { value: new THREE.Vector2(0.40, 0.56) },
      // 14 m of track at the camera, opening out by 0.22 m per metre of range -
      // the classic wedge of glitter running back to the sun.
      uSparkleTrack: { value: new THREE.Vector2(14, 0.22) },
      uSparkleWidthClamp: { value: 0.22 },
      uSparkleCut: { value: 0.32 },
      uSparkleRate: { value: 2.4 },
      uSparkleStrength: { value: 1.0 },
      uSparkleFade: { value: new THREE.Vector2(150, 520) },

      // --- hull interaction -------------------------------------------------
      uInteractors: { value: this.interactors },
      uWakeCut: { value: 0.86 },
      uWakeDarken: { value: 0.3 },
      uWakeFoam: { value: 0.80 },

      // --- atmosphere / g-buffer --------------------------------------------
      uHazeA: { value: PALETTE.waterMid.clone() },
      uHazeB: { value: PALETTE.waterMid.clone() },
      uHazeC: { value: PALETTE.waterMid.clone() },
      uFogColor: { value: PALETTE.skyHorizon.clone() },
      uHazeEdges: { value: HAZE_EDGES.clone() },
      /**
       * Wider than it was, and it now grows with the fog rather than shrinking.
       *
       * A row-mean scan of the reference `aerial` frame found 68 consecutive
       * rows - about 420 to 770 m out, and 60% of every pixel in the far band -
       * sitting at one single colour, row-to-row delta 0 to 2. That far sea has
       * nothing in it: from a high camera `fwidth(h01)` trips `hFlat`, the ramp
       * folds to `uBandMid`, the vertex LOD has already taken the pinch so no
       * crest stroke or foam is generated, and `uHazeA` covers the result. The
       * only mark left with any business being there is the haze edge itself,
       * and the old `(1.0 - fog * 0.4)` was quietly turning it *down* over
       * exactly that stretch.
       *
       * See the jitter block in water.ts for the fog scaling and the second,
       * coarser octave that turns the edge from a sine into a brush stroke.
       */
      uHazeJitter: { value: 0.26 },
      uHazeNoiseScale: { value: 1 / HAZE_NOISE_TILE },
      uHazeNoiseScale2: { value: 1 / HAZE_NOISE_TILE_2 },
      uFogCurve: { value: HAZE_CURVE },
      // y is overwritten from the scene fog every frame - see syncFog().
      uFogRange: { value: new THREE.Vector2(HAZE_NEAR, 1750) },
      uEdgeMask: { value: new THREE.Vector2(0.12, 0.2) },
    };

    const { vertexShader, fragmentShader } = buildWaterShaders(
      MID_WAVE_COUNT,
      FAR_WAVE_COUNT,
      WATER_MAX_INTERACTORS
    );

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

  /**
   * Builds the water's haze ladder from the sky's *actual* horizon colour, and
   * its far plane from the scene fog's, so the sea and everything floating on it
   * arrive at the horizon together instead of the sea getting there first and
   * waiting for the course furniture in a flat pale slab.
   *
   * The near end stays the water's own (HAZE_NEAR): scene fog is tuned for gates
   * a kilometre out and would leave a wave face at 300 m asking the eye to read
   * five flat tones inside two screen rows.
   *
   * The last water tone now stops about 4% short of the sky's value rather than
   * 12%. Some gap has to survive - without any, a pale foam band arriving at the
   * waterline matches the sky exactly and the line disappears in patches while
   * staying razor sharp elsewhere, which reads worse than either extreme - but
   * an eighth of a stop was not a horizon, it was a wall, and it was the hard
   * line the sea was ending on.
   */
  private syncFog(): void {
    const fog = this.scene.fog;
    if (!(fog instanceof THREE.Fog)) return;
    const skyH = fog.color;
    (this.uniforms.uFogRange!.value as THREE.Vector2).set(HAZE_NEAR, fog.far);
    (this.uniforms.uFogColor!.value as THREE.Color)
      .copy(skyH)
      .lerp(PALETTE.waterShallow, 0.10)
      .multiplyScalar(0.96);
    // Three intermediate layers: chroma leaves before value does, and the last
    // of them sits close enough to the sky that the final step is a hairline.
    (this.uniforms.uHazeA!.value as THREE.Color)
      .copy(PALETTE.waterMid)
      .lerp(skyH, 0.32);
    (this.uniforms.uHazeB!.value as THREE.Color)
      .copy(PALETTE.waterMid)
      .lerp(skyH, 0.60);
    (this.uniforms.uHazeC!.value as THREE.Color)
      .copy(PALETTE.waterMid)
      .lerp(skyH, 0.84);
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
