import * as THREE from 'three';
import { PALETTE, SUN_DIR } from '../core/Palette';
import type { Rng } from '../core/Rng';
import { makeCelMaterial, CEL_PRESETS } from '../render/CelMaterial';
import { OutlineMaterial, computeSmoothNormals, type OutlineOptions } from '../render/OutlineHull';
import { sampleSurface, sampleHeight, type SurfaceSample } from '../ocean/GerstnerCPU';
// The ribbon rides the same wave LOD cascade the sea is drawn with. One
// definition, imported - see the "must match the ocean" note below.
import {
  MID_WAVE_COUNT, FAR_WAVE_COUNT,
  CHOP_FADE_START, CHOP_FADE_END,
  SWELL_FADE_START, SWELL_FADE_END,
} from '../ocean/Ocean';
import {
  buildRaceLineShaders,
  GATE_BANNER_VERT, GATE_BANNER_FRAG,
  GATE_LAMP_VERT, GATE_LAMP_FRAG,
} from './shaders/courseShaders';

/**
 * THE CIRCUIT — "Anchorline", 2.68 km, run anticlockwise.
 *
 * The layout is authored, not generated. It is a pen-walk of named sections
 * whose leg lengths were solved so the loop closes exactly, sampled into the
 * control-point table below. Reading it in order:
 *
 * ```
 *   0 m     START / FINISH, on a 420 m straight            half-width 26 m
 * 329 m   T1  THE REACH      R 208 m, 75 deg right         28 m   flat out
 * 601 m       link                                         21 m
 * 684 m   T2  THE ANCHOR     R 30 m, 164 deg left          15 m   HAIRPIN
 * 770 m       exit                                         18 m
 * 962 m   T3  THE DROP       R 205 m, 45 deg left          20 m   fast flick
 * 1123 m      approach                                     20 m
 * 1310 m  T4  THE STITCH     R 52 m, left-right-left       10 m   CHICANE
 * 1556 m      exit                                         17 m
 * 1758 m  T5  THE GATE       R 115 m, 110 deg left         20 m
 * 1979 m      THE SWELL LEG, 367 m dead straight           24 m   AIRTIME
 * 2346 m  T6  THE LONG LEFT  R 122 m, 116 deg left         24 m   medium sweeper
 * 2593 m      run to the line                              26 m
 * ```
 *
 * ## Why the swell leg points where it does
 *
 * `ocean/waveConfig.ts` carries two long swells - 78 m at 5.6 m/s heading
 * (0.987, 0.158), and 51 m at 4.7 m/s heading (0.622, -0.783). Weighted by their
 * amplitudes their mean travel direction is (0.963, -0.269), so the crest lines
 * run along (0.269, 0.963). The swell leg is laid *along the travel direction
 * and against it* - heading (-0.963, 0.269) - which is the orientation that
 * crosses the most crests per metre. Running into the waves rather than with
 * them also adds the wave's own speed to the encounter rate: at racing pace a
 * boat meets the long swell every 2.3 s and the second swell every 1.9 s, which
 * is a launch roughly every two seconds for the whole leg.
 *
 * The start/finish straight sits 64 degrees off that axis, so on the straight
 * the boat is running *with* the swell at close to its own speed and the
 * encounter period stretches to about 11 s - the water there is effectively
 * glassy. That contrast is the point: the straight is where you carry speed, the
 * swell leg is where you lose the water.
 *
 * ## What is drawn
 *
 * - The racing line: a 3.5 m ribbon of hard concentric bands with a scrolling
 *   chevron, displaced onto the sea in the vertex shader by the *generated*
 *   Gerstner GLSL at the ocean's own `uTime` (see `shaders/courseShaders.ts`).
 *   It rides the swell exactly because it is the same map applied to the same
 *   parameter space, not an approximation of it.
 * - Twelve gates: two moored pylons with a lamp on each and a banner slung
 *   between them. Each pylon samples the real surface on the CPU every frame and
 *   takes its height and its lean from it, so a gate rolls as the swell passes
 *   under one leg before the other - and the banner, built from the two pylon
 *   tops, rolls with them.
 * - Course buoys down the outside of every corner, moored and bobbing the same way.
 *
 * Nine draw calls for the whole course, of which four are ink.
 */

// --------------------------------------------------------------- contract ---

export interface Gate {
  index: number;
  /** Live world position of the gate's midpoint; the y component bobs. */
  center: THREE.Vector3;
  /**
   * The same Vector3 object as `center`, under the name the race director's
   * `CourseGate` asks for. One gate has one position; this is an alias, not a
   * copy, so there is no way for the two to disagree.
   */
  position: THREE.Vector3;
  /** Unit plane normal, horizontal, pointing the way the boats go through. */
  normal: THREE.Vector3;
  /** Half the gap between the pylons, in metres. */
  halfWidth: number;
  /** Arc-length parameter of the gate, 0..1. */
  t: number;
}

export interface GridSlot {
  position: THREE.Vector3;
  heading: number;
}

/** Result of `Course.project`. See the note on the method: this is recycled. */
export interface Projection {
  /** Arc-length parameter of the closest point, 0..1. */
  t: number;
  point: THREE.Vector3;
  tangent: THREE.Vector3;
  /** Signed metres from the line; + is to the right of the direction of travel. */
  lateral: number;
}

// ------------------------------------------------------------- the layout ---

/**
 * The circuit, as data: `x, z, halfWidth` per control point, in metres.
 *
 * Spacing follows the local corner radius (tight through the hairpin and the
 * chicane, long down the straights) and is smoothed across every junction -
 * a large spacing ratio either side of a control point is exactly what makes
 * Catmull-Rom overshoot, and an overshoot here is a kink in the racing line.
 *
 * The half-width is authored per section and interpolated along the lap, so the
 * gates, the buoys and anything that asks `widthAt()` all agree on how much
 * course there is. It is deliberately brutal through the chicane: 10 m of
 * half-width against 28 m on the sweeper is what gives the section its rhythm.
 */
const CONTROL: readonly number[] = [
  // --- start / finish straight -----------------------------------------------
  -285.5, -114.9, 26,
  -241.6, -65.5, 26,
  -197.8, -16.2, 26,
  -153.9, 33.2, 26,
  -110.4, 82.2, 26,
  // --- T1 "The Reach": wide constant-radius right, taken flat -----------------
  -67.2, 130.8, 28,
  -32.3, 185.2, 28,
  -15.8, 247.7, 28,
  -19.3, 312.3, 28,
  -36.8, 362.2, 28,
  // --- link: the course pinches on the way in ---------------------------------
  -56.4, 394.6, 21,
  -71.5, 417.6, 21,
  -82.6, 434.3, 21,
  -90.5, 446.4, 21,
  // --- T2 "The Anchor": the hairpin. 30 m radius, 164 degrees left ------------
  -96.5, 455.7, 15,
  -99.7, 466.1, 15,
  -99.0, 477.0, 15,
  -94.4, 486.9, 15,
  -86.5, 494.5, 15,
  -76.5, 498.9, 15,
  -65.6, 499.3, 15,
  -55.3, 495.8, 15,
  // --- hairpin exit ----------------------------------------------------------
  -43.5, 486.5, 18,
  -24.9, 470.6, 18,
  5.0, 444.9, 18,
  53.2, 403.5, 18,
  // --- T3 "The Drop": fast 45 degree flick ------------------------------------
  102.0, 361.4, 20,
  141.3, 310.6, 20,
  162.9, 250.1, 20,
  // --- approach to the chicane ------------------------------------------------
  169.1, 185.4, 20,
  172.9, 136.1, 20,
  175.7, 99.2, 20,
  177.8, 71.8, 20,
  179.4, 51.3, 20,
  // --- T4 "The Stitch": chicane, left ------------------------------------------
  180.3, 34.9, 11,
  177.1, 18.8, 11,
  169.0, 4.6, 11,
  // --- chicane, link -----------------------------------------------------------
  157.5, -7.2, 10,
  145.7, -18.8, 10,
  // --- chicane, right ----------------------------------------------------------
  134.8, -31.1, 10,
  128.0, -46.0, 10,
  126.2, -62.3, 10,
  129.6, -78.3, 10,
  137.8, -92.5, 10,
  // --- chicane, link -----------------------------------------------------------
  149.9, -103.5, 10,
  163.3, -113.1, 10,
  // --- chicane, left out -------------------------------------------------------
  176.7, -122.8, 11,
  187.5, -135.1, 11,
  194.0, -150.2, 11,
  // --- chicane exit ------------------------------------------------------------
  196.3, -170.5, 17,
  198.8, -202.4, 17,
  202.0, -244.2, 17,
  205.7, -292.6, 17,
  208.9, -334.5, 17,
  // --- T5 "The Gate": 110 degrees left, onto the swell -------------------------
  211.2, -370.4, 20,
  205.4, -405.7, 20,
  189.1, -437.6, 20,
  163.7, -462.8, 20,
  131.7, -479.1, 20,
  96.4, -484.7, 20,
  // --- THE SWELL LEG: straight, laid along the swell axis -----------------------
  59.5, -478.8, 24,
  13.7, -466.0, 24,
  -44.5, -449.7, 24,
  -108.1, -431.9, 24,
  -168.8, -415.0, 24,
  -219.4, -400.8, 24,
  -261.8, -389.0, 24,
  // --- T6 "The Long Left": medium sweeper back onto the straight ---------------
  -298.7, -378.1, 24,
  -331.9, -358.9, 24,
  -357.5, -330.3, 24,
  -372.9, -295.2, 24,
  -376.7, -257.1, 24,
  -368.5, -219.6, 24,
  -349.1, -186.6, 24,
  // --- run to the line ----------------------------------------------------------
  -318.0, -151.5, 26,
];

// ------------------------------------------------------------------ tuning ---

/**
 * Arc-length table resolution. 1200 samples over 2.68 km is one every 2.2 m,
 * which is finer than the tightest corner needs: linear interpolation between
 * two samples on the 25 m hairpin is 25 mm off the true curve, three orders of
 * magnitude under the course's half-width.
 */
const SAMPLES = 1200;
/** Fine sampling used once, at construction, to build the arc-length map. */
const RAW_SAMPLES = 8000;

/**
 * Half-window, in table samples, that `project` searches around its hint.
 * +-45 samples is +-100 m of course; a boat at 30 m/s covers 0.5 m per frame, so
 * the hint can be 200 frames stale before this misses.
 */
const PROJECT_WINDOW = 45;
/** Past this distance from the line the hint is assumed wrong and a full scan runs. */
const PROJECT_FALLBACK_D2 = 140 * 140;
/** Stride of the coarse full scan; 8 samples is 18 m, well under a course width. */
const PROJECT_STRIDE = 8;

/** How many separate `project` results can be live at once before recycling. */
const PROJECTION_POOL = 24;

// --- must match the ocean ----------------------------------------------------
/**
 * The ribbon's wave LOD is now *imported* from `ocean/Ocean.ts` rather than
 * restated here - see the import list at the top of the file.
 *
 * It used to be restated, and it had drifted: `LOD_WAVE_COUNT = 3` over
 * 110-430 m against the ocean's 4 waves over 100-400 m followed by 2 over
 * 340-1000 m, with no second stage on the ribbon at all. The ribbon therefore
 * dropped a 0.28 m wave the sea kept, and kept a 0.72 m pair the sea dropped -
 * a worst-case 0.44 m of disagreement past 430 m, which is the racing line
 * sawing through the drawn swell on the far side of the lap. Two constants that
 * have to be equal should be one constant.
 *
 * `CAMERA_FAR` still mirrors `core/Engine.ts`, which is not this subsystem's
 * file to change. Get it wrong and the Sobel pass mis-reads every course
 * surface's depth.
 */
const CAMERA_FAR = 4200;

// --- racing line -------------------------------------------------------------
/**
 * Metres between ribbon rows. At 2.5 m the strip's own triangulation was
 * visible as long hard-edged wedges wherever it crossed a crest - the ribbon is
 * displaced per *vertex*, so a row spacing coarser than the chop is a faceted
 * approximation of a curved surface. 1.1 m is well under the shortest wave in
 * waveConfig, and it is also what the band shading needs: the sea's normal is
 * sampled per vertex, so the step between two shading bands lands on a triangle
 * edge, and at a coarse spacing those edges are the wedges. 2400 rows of two
 * vertices is one static buffer built once at load.
 */
const RIBBON_STEP = 1.1;
/**
 * Half-width of the racing line ribbon, metres.
 *
 * 1.1 m was tried and is too little. A 2.2 m ribbon is narrower than one boat,
 * so from the chase camera it is hidden under the hull and the wake for the
 * whole of every straight, and from altitude it falls to a two-pixel scratch
 * that the eye reads as a scuff on the water rather than as a drawn line. The
 * ribbon has to survive both, and 3.5 m - four fifths of a boat length - is the
 * width at which its three bands are still separately visible at 400 m while
 * the strip is still obviously narrower than the thing driving along it.
 */
const RIBBON_HALF = 1.75;
/** Target chevron period; the real one divides the lap exactly so it seams. */
const CHEVRON_TARGET = 9.0;
/** Chevron travel, metres/second, in the direction of travel. */
const CHEVRON_SPEED = 16.0;
/** Constant lift off the water, and the per-metre depth-buffer allowance. */
const RIBBON_LIFT = 0.05;
const RIBBON_LIFT_SLOPE = 0.00055;
/**
 * Peak opacity of the racing line.
 *
 * 0.46 was tried and it is what turned the line into a wisp: a half-strength
 * fill over water that is itself high-chroma leaves a value difference of a few
 * counts, so the ribbon survived only where it happened to cross a dark trough
 * and vanished everywhere else - which reads exactly as a broken, patchy line
 * rather than as a continuous one. Continuity is the whole job here, and
 * continuity is a *minimum* contrast along the length, not an average one.
 *
 * The line can afford this because it is drawn before the wake foam and never
 * writes depth, so the churn still composites straight over it, and because the
 * alpha is not flat across the width: the sheath runs at roughly half this and
 * the outer ramp takes it to nothing well inside the geometry, so there is no
 * hard strip boundary anywhere for the foam to interlock with.
 */
const RIBBON_OPACITY = 0.76;
/**
 * Where the ribbon starts fading out, and where it is gone.
 *
 * 300/640 was tried and it is too short for any camera that gets above the
 * deck: from altitude the far side of the lap is 1.2 km away and the line
 * simply stopped, so the circuit read as a stub near the boat and bare sea
 * everywhere else. The ribbon is the only thing in the world that describes the
 * *shape* of the course, so it has to survive to the point where the course's
 * own haze has taken it anyway - see LINE_HAZE_FAR, which is what actually
 * retires it. This fade only makes sure it is gone before the horizon seam.
 */
const RIBBON_FADE_START = 700;
const RIBBON_FADE_END = 1700;
/**
 * The *near* fade, in metres of view depth. See the long note in the fragment
 * shader: inside this the ribbon is a foreshortened wedge lying on the player's
 * own wake, which is where every "green blotches punching through the foam"
 * report in the review came from. The chase camera sits about 10 m back, so the
 * line arrives just ahead of the boat and runs away from there.
 *
 * The start/finish strip overrides both to zero - it is a mark you cross, and
 * it has to be there when you are on it.
 *
 * 6/19 is pulled in to 4/12. The wedge this fade exists to remove lives inside
 * about 6 m - that is where the ribbon is wide enough on screen to interlock
 * with the wake - so the far end of the old ramp was not buying anything, and
 * from the chase camera, which sits ~10 m back, it meant the line only reached
 * half strength level with the boat. At 4/12 it is fully in a little ahead of
 * the bow and the wedge is still gone. Seven metres of stroke is a lot when
 * there were 6 643 pixels of line on the water in the whole frame.
 */
const RIBBON_NEAR_GONE = 4;
const RIBBON_NEAR_FULL = 12;
/** Length of the start/finish strip along the course, metres. */
const START_STRIP_LENGTH = 6.5;
/** How much wider than the course the start strip and the start gate are. */
const START_WIDEN = 1.16;

// --- gates -------------------------------------------------------------------
const GATE_COUNT = 12;
/**
 * Height above the waterline of the banner's *attachment points*, and of the
 * lamp above them.
 *
 * The history here is a pendulum and this is the settled end of it. At 4.05 m
 * the crossbar hung at exactly the height a racer occupies on screen and sliced
 * through the pack; the answer taken was 9 m, which fixed that by making the
 * gate motorway infrastructure - a fluted column and an arch that left the top
 * of the frame from thirty metres away.
 *
 * The real measure is the boat: 4.2 m long, with a standing rider whose head is
 * about 2.4 m off the water, on a sea whose swell is about a metre. Marine
 * furniture at that scale is a mark you pass, not a structure you drive under.
 *
 * 5.0 m was the settled value and it is still a little tall. Measured off the
 * chase frame - the pylon's waterline collar to its banner clamp spanned 358 px
 * of 1440 at a range of ~28 m, which back-solves to the 5 m it is built at - the
 * near gate's span filled 68% of the frame width and its mast stood 1.33 boat
 * lengths out of the water. 4.6 m puts the mast at 1.10 lengths and the banner's
 * underside at 4.03 m over the masts and 5.23 m at the crown of the arch: 1.6 m
 * of daylight over the rider at the worst point, which still reads as a span you
 * pass under rather than one you duck.
 */
const BANNER_Y = 4.6;
/**
 * How far the middle of the span rises above its two attachment points, in
 * metres. Positive: this is an arch, not a sag. A straight bar at any height is
 * still a horizontal rule across the picture; a bowed one is a shape you look
 * through, and the curve is what stops it reading as a second horizon.
 *
 * Held at about 6% of the span, which is the same bow the 3 m rise gave the old
 * 50 m gates - the arch is a proportion of the shape, not an absolute. The span
 * came in from 18-24 m to 15-20 m, so this follows it down.
 */
const BANNER_RISE = 1.20;
const BANNER_HEIGHT = 1.15;
const BANNER_THICKNESS = 0.13;
/** Clear of the mast head at 5.10 m, so the drum sits *on* the spar. */
const LAMP_Y = 5.30;
/**
 * The drawn gate is *narrower than the course*, and deliberately.
 *
 * `widthAt` runs from 10 m at the chicane to 28 m on the start straight, and a
 * gate built on that is 56 m of banner across the widest part of the circuit -
 * fourteen boat lengths, which is why it read as motorway gantry. A race marker
 * is something you aim at, so its span has to be a size the eye can judge
 * against the boat.
 *
 * 18-24 m was that correction and it overshot by about a fifth. Measured off the
 * chase frame: the near gate sat ~28 m out, where the frame is 35.3 m wide at
 * this FOV, and its 24 m span covered 68% of the picture - 5.7 boat lengths of
 * banner, which is why it still read as gantry rather than as a mark. 15-20 m is
 * 3.6 to 4.8 lengths, which is both the width of a real slalom gate on water and
 * a span the eye can measure a 4.2 m hull against in one glance.
 *
 * The *checkpoint* keeps the full course width - see `Gate.halfWidth`. Passing
 * outside the pylons but inside the course still counts, exactly as it does
 * around a real buoy course, and that split is what lets the marker be a
 * legible size without making the circuit harder to complete. It is also what
 * makes this trim free: nothing about where a boat may cross has changed.
 */
const GATE_DRAW_MIN_HALF = 7.5;
const GATE_DRAW_MAX_HALF = 10;
const GATE_DRAW_RATIO = 0.55;
/**
 * How much of the surface normal the moored furniture actually takes. A float
 * with any draught averages the slope under it, so leaning the full analytic
 * normal reads as a toy; 0.8 keeps the roll obvious without the pylons ever
 * looking hinged.
 */
const TILT = 0.8;

/**
 * The course's own haze, deliberately much tighter than `scene.fog`.
 *
 * The circuit is a 2.68 km closed loop, so from anywhere on it the *far side*
 * of the lap is in frame - six or seven gates strung along the horizon at 1 to
 * 1.5 km. On the scene's 260/1750 fog those arrived at roughly 70% haze, which
 * is not enough: a navy pylon at 30% strength is a black speck two pixels wide
 * with no colour, no bands and no silhouette, and its pink banner is a striped
 * bar that reads as a UI element stuck to the seam of the horizon. Twelve of
 * them across the skyline is a row of dirt.
 *
 * The sea and the sky keep the scene's fog; only the furniture takes this one.
 * Course objects are the smallest things in the world and the ones that reduce
 * to noise fastest, so they are the ones that have to leave first. Inside 200 m
 * - which is every gate the driver is actually being asked to read - this is
 * identical to no fog at all.
 */
const HAZE_NEAR = 190;
const HAZE_FAR = 880;
/** The racing line's own, much longer haze. See the note where it is applied. */
const LINE_HAZE_NEAR = 420;
const LINE_HAZE_FAR = 1750;

// --- buoys -------------------------------------------------------------------
/** Corners tighter than this get buoys down their outside edge. */
const BUOY_MAX_RADIUS = 235;
/** Buoy spacing scales with the corner radius, clamped to this range (metres). */
const BUOY_SPACING_MIN = 18;
const BUOY_SPACING_MAX = 55;
/** Clearance outside the course edge. */
const BUOY_MARGIN = 3.2;
/** Keep buoys clear of the gate pylons. */
const BUOY_GATE_CLEARANCE = 22;
const BUOY_MAX = 48;

// --- grid --------------------------------------------------------------------
/** Metres behind the line for the pole slot, then per row and per stagger. */
const GRID_FIRST = 15;
const GRID_ROW = 11.5;
const GRID_STAGGER = 5.5;
const GRID_LATERAL = 6.5;

// ------------------------------------------------------------------ scratch --

// Module scope. Nothing below may allocate inside update() or project().
const _up = new THREE.Vector3(0, 1, 0);
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _axX = new THREE.Vector3();
const _axY = new THREE.Vector3();
const _axZ = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _nrmL = new THREE.Vector3();
const _nrmR = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _mat = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
const _sampleA: SurfaceSample = { height: 0, normal: new THREE.Vector3(0, 1, 0), jacobian: 1 };
const _sampleB: SurfaceSample = { height: 0, normal: new THREE.Vector3(0, 1, 0), jacobian: 1 };

function wrap01(t: number): number {
  const f = t - Math.floor(t);
  return f < 0 ? f + 1 : f;
}

// ----------------------------------------------------------- geometry --------

interface LatheRing {
  y: number;
  r: number;
  color: THREE.Color;
}

/**
 * Flat-shaded lathe with per-ring vertex colours.
 *
 * Non-indexed on purpose: every triangle gets its own normal, so the facets stay
 * hard and the form reads as drawn planes rather than as a smooth revolve. The
 * inverted-hull outline re-welds the normals by position anyway
 * (`computeSmoothNormals`), so the ink shell is not torn by the split.
 *
 * `uv.y` runs 0..1 up the profile, which is what the lamp shader bands against.
 */
function buildLathe(profile: readonly LatheRing[], segments: number, name: string): THREE.BufferGeometry {
  const rings = profile.length;
  const first = profile[0]!;
  const last = profile[rings - 1]!;
  const capBottom = first.r > 1e-4 ? segments : 0;
  const capTop = last.r > 1e-4 ? segments : 0;
  const triCount = (rings - 1) * segments * 2 + capBottom + capTop;

  const pos = new Float32Array(triCount * 9);
  const col = new Float32Array(triCount * 9);
  const uv = new Float32Array(triCount * 6);
  let vi = 0;
  let ui = 0;

  const push = (x: number, y: number, z: number, c: THREE.Color, u: number, v: number): void => {
    pos[vi] = x; pos[vi + 1] = y; pos[vi + 2] = z;
    col[vi] = c.r; col[vi + 1] = c.g; col[vi + 2] = c.b;
    vi += 3;
    uv[ui] = u; uv[ui + 1] = v;
    ui += 2;
  };

  const cosA = new Float32Array(segments + 1);
  const sinA = new Float32Array(segments + 1);
  for (let s = 0; s <= segments; s++) {
    const a = (s / segments) * Math.PI * 2;
    cosA[s] = Math.cos(a);
    sinA[s] = Math.sin(a);
  }

  for (let i = 0; i < rings - 1; i++) {
    const lo = profile[i]!;
    const hi = profile[i + 1]!;
    const v0 = i / (rings - 1);
    const v1 = (i + 1) / (rings - 1);
    for (let s = 0; s < segments; s++) {
      const u0 = s / segments;
      const u1 = (s + 1) / segments;
      const c0 = cosA[s]!, s0 = sinA[s]!;
      const c1 = cosA[s + 1]!, s1 = sinA[s + 1]!;
      // (v00, v10, v11) then (v00, v11, v01) - outward-facing winding.
      push(lo.r * c0, lo.y, lo.r * s0, lo.color, u0, v0);
      push(hi.r * c0, hi.y, hi.r * s0, hi.color, u0, v1);
      push(hi.r * c1, hi.y, hi.r * s1, hi.color, u1, v1);
      push(lo.r * c0, lo.y, lo.r * s0, lo.color, u0, v0);
      push(hi.r * c1, hi.y, hi.r * s1, hi.color, u1, v1);
      push(lo.r * c1, lo.y, lo.r * s1, lo.color, u1, v0);
    }
  }
  for (let s = 0; s < capBottom; s++) {
    const c0 = cosA[s]!, s0 = sinA[s]!, c1 = cosA[s + 1]!, s1 = sinA[s + 1]!;
    push(0, first.y, 0, first.color, 0.5, 0);
    push(first.r * c0, first.y, first.r * s0, first.color, s / segments, 0);
    push(first.r * c1, first.y, first.r * s1, first.color, (s + 1) / segments, 0);
  }
  for (let s = 0; s < capTop; s++) {
    const c0 = cosA[s]!, s0 = sinA[s]!, c1 = cosA[s + 1]!, s1 = sinA[s + 1]!;
    push(0, last.y, 0, last.color, 0.5, 1);
    push(last.r * c1, last.y, last.r * s1, last.color, (s + 1) / segments, 1);
    push(last.r * c0, last.y, last.r * s0, last.color, s / segments, 1);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  g.name = name;
  return g;
}

/**
 * A moored gate pylon: a submerged spar, a fat float collar at the waterline
 * (which is what sells it as floating rather than piled into the seabed) and a
 * tapered mast with a shelf for the lamp.
 */
function buildPylonGeometry(): THREE.BufferGeometry {
  const dark = PALETTE.hullDark;
  const metal = PALETTE.metal;
  const trim = PALETTE.hullTrim;
  // Slim. The old profile was a 1.7 m-radius collar under a 9 m mast with three
  // fluted steps in it, which is a 3.4 m-wide fluted column - architecture. A
  // gate pylon is a mooring buoy with a spar on it: a 1.24 m float that a boat
  // could nudge aside, a spar barely thicker than a handrail, and exactly one
  // mid-height step, which is there so the silhouette has a proportion in it at
  // range rather than being a bare taper.
  //
  // 5.10 m from the water to the mast head, plus the lamp - 1.21 boat lengths,
  // trimmed with BANNER_Y from 5.60 (1.33) after measuring the near gate on the
  // chase frame. Only the spar above the float scales: the float itself is a
  // 1.24 m collar sized off what a hull could nudge aside, and that number has
  // nothing to do with how tall the mast is. The banner clamp collar at
  // 4.46-4.74 straddles BANNER_Y exactly, so the span attaches to hardware
  // rather than to bare spar.
  return buildLathe([
    { y: -1.30, r: 0.20, color: dark },
    { y: -0.72, r: 0.44, color: dark },
    { y: -0.20, r: 0.62, color: trim },
    { y: 0.22, r: 0.62, color: trim },
    { y: 0.50, r: 0.44, color: dark },
    { y: 0.72, r: 0.26, color: metal },
    { y: 2.24, r: 0.22, color: metal },
    { y: 2.42, r: 0.34, color: dark },
    { y: 2.60, r: 0.20, color: metal },
    { y: 4.46, r: 0.17, color: metal },
    { y: 4.60, r: 0.29, color: dark },
    { y: 4.74, r: 0.19, color: metal },
    { y: 5.10, r: 0.16, color: metal },
  ], 10, 'gatePylon');
}

/** The lamp drum. Its own shader bands it; the geometry is just the form. */
function buildLampGeometry(): THREE.BufferGeometry {
  const w = PALETTE.neutral;
  // Sized off the mast head it sits on, not off the old one: a 0.66 m drum on a
  // 0.16 m spar is a beacon the size of an oil drum.
  return buildLathe([
    { y: -0.15, r: 0.18, color: w },
    { y: -0.09, r: 0.28, color: w },
    { y: 0.09, r: 0.30, color: w },
    { y: 0.15, r: 0.19, color: w },
  ], 8, 'gateLamp');
}

/**
 * A course buoy: witch-hat float with a foam stripe at the waterline.
 *
 * Same correction as the pylons. A 2.4 m-wide, 3 m-tall cone is half a boat and
 * reads as a channel marker for shipping; this is 1.3 m across and stands 1.7 m
 * out of the water, which is a racing mark a hull can brush.
 */
function buildBuoyGeometry(): THREE.BufferGeometry {
  return buildLathe([
    { y: -0.82, r: 0.20, color: PALETTE.hullDark },
    { y: -0.38, r: 0.51, color: PALETTE.hullDark },
    { y: -0.07, r: 0.65, color: PALETTE.foam },
    { y: 0.19, r: 0.62, color: PALETTE.foam },
    { y: 0.46, r: 0.53, color: PALETTE.hullTrim },
    { y: 0.79, r: 0.37, color: PALETTE.hullTrim },
    { y: 1.70, r: 0.07, color: PALETTE.gateIdle },
  ], 8, 'courseBuoy');
}

/**
 * The banner, in unit space: 1 wide, 1 tall, 1 thick, scaled per instance.
 *
 * `uv` is re-derived from the undeformed position so every face of the slab
 * shares one planar mapping - the box's own per-face uv would run the rail
 * pattern sideways across the top and bottom edges. The sag is applied after,
 * so a wide gate and a narrow one both hang the same *shape*.
 */
function buildBannerGeometry(): THREE.BufferGeometry {
  // 40 segments along the span, not 16: the arch below is a parabola, and at 16
  // it was a visible chain of straight chords across the widest object in the
  // frame. The cost is 240 triangles on twelve instances.
  const g = new THREE.BoxGeometry(1, 1, 1, 40, 3, 1);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const uvAttr = g.getAttribute('uv') as THREE.BufferAttribute;
  // The rise is authored in metres and converted here, so changing the banner's
  // height does not silently change how far it arches.
  const rise = BANNER_RISE / BANNER_HEIGHT;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    uvAttr.setXY(i, x + 0.5, y + 0.5);
    // 1 - 4x^2 is 1 at the middle and 0 at both masts, so the span meets each
    // clamp exactly at its attachment point and bows up in between.
    pos.setY(i, y + rise * (1 - 4 * x * x));
  }
  pos.needsUpdate = true;
  uvAttr.needsUpdate = true;
  g.computeVertexNormals();
  g.name = 'gateBanner';
  return g;
}

/**
 * Ink shell for an InstancedMesh.
 *
 * `addOutline` in OutlineHull builds a plain Mesh, which would silently drop the
 * instancing and draw one shell at the origin. The shell shares the source
 * mesh's `instanceMatrix` *buffer*, so the per-frame bob is written once and
 * both meshes see it.
 */
function addInstancedOutline(mesh: THREE.InstancedMesh, opts: OutlineOptions = {}): THREE.InstancedMesh {
  computeSmoothNormals(mesh.geometry);
  const ink = new THREE.InstancedMesh(mesh.geometry, new OutlineMaterial(opts), mesh.count);
  ink.instanceMatrix = mesh.instanceMatrix;
  ink.name = mesh.name + '_ink';
  ink.frustumCulled = false;
  ink.matrixAutoUpdate = false;
  ink.renderOrder = mesh.renderOrder - 1;
  return ink;
}

// -------------------------------------------------------------- the Course ---

interface GateInternal {
  pub: Gate;
  /** Fixed world XZ of each pylon - the gates are moored, only y moves. */
  lx: number; lz: number;
  rx: number; rz: number;
}

export class Course {
  readonly curve: THREE.CatmullRomCurve3;
  readonly totalLength: number;
  readonly gates: Gate[] = [];

  private readonly group = new THREE.Group();

  // --- arc-length tables (all indexed 0..SAMPLES-1, uniform in arc length) ---
  private readonly sx = new Float32Array(SAMPLES);
  private readonly sz = new Float32Array(SAMPLES);
  private readonly tx = new Float32Array(SAMPLES);
  private readonly tz = new Float32Array(SAMPLES);
  /** Signed curvature, 1/m. Positive turns to the right of travel. */
  private readonly kappa = new Float32Array(SAMPLES);
  /** Course half-width, metres. */
  private readonly halfWidth = new Float32Array(SAMPLES);

  private readonly gateData: GateInternal[] = [];
  private readonly buoyX: number[] = [];
  private readonly buoyZ: number[] = [];

  private readonly pylons: THREE.InstancedMesh;
  private readonly pylonInk: THREE.InstancedMesh;
  private readonly lamps: THREE.InstancedMesh;
  private readonly banners: THREE.InstancedMesh;
  private readonly bannerInk: THREE.InstancedMesh;
  private readonly buoys: THREE.InstancedMesh;
  private readonly buoyInk: THREE.InstancedMesh;

  private readonly lampFlags: THREE.InstancedBufferAttribute;
  private readonly bannerFlags: THREE.InstancedBufferAttribute;
  private readonly lampTint: THREE.InstancedBufferAttribute;
  private readonly bannerTint: THREE.InstancedBufferAttribute;

  private readonly raceLine: THREE.Mesh;
  private readonly startStrip: THREE.Mesh;
  private readonly raceLineMat: THREE.ShaderMaterial;
  private readonly startStripMat: THREE.ShaderMaterial;
  private readonly bannerMat: THREE.ShaderMaterial;
  private readonly lampMat: THREE.ShaderMaterial;
  private readonly pylonMat: THREE.ShaderMaterial;
  private readonly buoyMat: THREE.ShaderMaterial;
  /** Every material that carries the shared fog uniforms. */
  private readonly fogged: THREE.ShaderMaterial[] = [];
  /** The two shared fog uniform *objects*, written once a frame by `syncFog`. */
  private readonly fogColorU: THREE.IUniform<THREE.Color>;
  private readonly fogRangeU: THREE.IUniform<THREE.Vector2>;
  private readonly lineFogRangeU: THREE.IUniform<THREE.Vector2>;

  private readonly scene: THREE.Scene;
  /** Last wave clock seen, so `gridSlots` can place boats on the sea as it is now. */
  private time = 0;

  private readonly projPool: Projection[] = [];
  private projCursor = 0;

  constructor(scene: THREE.Scene, rng: Rng) {
    this.scene = scene;
    this.group.name = 'course';
    this.group.matrixAutoUpdate = false;

    // --- spline + tables ----------------------------------------------------
    const count = CONTROL.length / 3;
    const points: THREE.Vector3[] = [];
    const cpWidth = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      points.push(new THREE.Vector3(CONTROL[i * 3]!, 0, CONTROL[i * 3 + 1]!));
      cpWidth[i] = CONTROL[i * 3 + 2]!;
    }
    // Centripetal, not uniform: the control points are deliberately unevenly
    // spaced (dense in the hairpin, sparse on the straights) and uniform
    // Catmull-Rom answers that with cusps and self-intersections.
    this.curve = new THREE.CatmullRomCurve3(points, true, 'centripetal');
    this.totalLength = this.buildTables(cpWidth, count);

    for (let i = 0; i < PROJECTION_POOL; i++) {
      this.projPool.push({ t: 0, point: new THREE.Vector3(), tangent: new THREE.Vector3(), lateral: 0 });
    }

    // --- shared fog uniform values -----------------------------------------
    // These two IUniform *objects* are handed to every material below, not
    // copied into them - so `syncFog` writes once a frame and all six agree by
    // construction. Six independent copies is exactly the sort of thing that
    // stays correct until someone changes the fog at runtime.
    const fogColor = { value: PALETTE.skyHorizon.clone() };
    const fogRange = { value: new THREE.Vector2(HAZE_NEAR, HAZE_FAR) };
    // The ribbon gets its own, much longer range. The furniture haze is tuned
    // for objects that *reduce to a speck* at distance - a pylon at 800 m is two
    // pixels and has to leave. The racing line does the opposite: it is a
    // continuous stroke whose whole job is to describe the shape of a 2.68 km
    // circuit, and a stroke stays legible at any length. Hazing it on the
    // pylons' schedule is what left the line as a stub near the boat.
    const lineFogRange = { value: new THREE.Vector2(LINE_HAZE_NEAR, LINE_HAZE_FAR) };
    this.fogColorU = fogColor;
    this.fogRangeU = fogRange;
    this.lineFogRangeU = lineFogRange;

    // --- racing line + start strip ------------------------------------------
    const src = buildRaceLineShaders(MID_WAVE_COUNT, FAR_WAVE_COUNT);
    const periods = Math.max(1, Math.round(this.totalLength / CHEVRON_TARGET));
    const chevronPeriod = this.totalLength / periods;

    const lineUniforms = (mode: number, half: number): Record<string, THREE.IUniform> => ({
      uTime: { value: 0 },
      uChopFade: { value: new THREE.Vector2(CHOP_FADE_START, CHOP_FADE_END) },
      uSwellFade: { value: new THREE.Vector2(SWELL_FADE_START, SWELL_FADE_END) },
      uLift: { value: RIBBON_LIFT },
      uLiftSlope: { value: RIBBON_LIFT_SLOPE },
      // The racing line is green, and it is the palette's own raceLine green.
      //
      // The visor cyan was tried, on the argument that a hue nothing else uses
      // cannot be confused with a gate state or a livery. It is the wrong
      // argument, because the sea is already cyan: waterShallow, waterCrest and
      // foamShade sit within a few degrees of hue of it, so a translucent cyan
      // stroke over water is a value difference and nothing else, and a value
      // difference is exactly what the swell shading, the foam and the haze all
      // eat. The line came out as a white wisp - a scratch on the water.
      //
      // Green separates from every band of the sea by hue, which survives all
      // three. The collision with gateLit is real and is handled where it
      // matters: the gates are pink except for the single lit one, and the lit
      // gate is a small hard-edged object on a mast while the line is a
      // continuous stroke lying flat on the water. Nobody confuses a road sign
      // with the road because they share a colour.
      uLine: { value: PALETTE.raceLine.clone() },
      uHot: { value: PALETTE.raceLineHot.clone() },
      uInk: { value: PALETTE.ink.clone() },
      uSun: { value: SUN_DIR.clone() },
      // Core / body / sheath / alpha zero, across |side|. The first three are
      // hard steps; the last is where the soft outer ramp finishes, and it runs
      // well inside the geometry so the strip never shows its own edge.
      uBands: { value: new THREE.Vector4(0.20, 0.58, 0.80, 1.0) },
      /**
       * What counts as edge-on, measured on the *water's* view-space normal.
       *
       * The camera rigs put the sea's normal at roughly 0.15 of view Z from the
       * chase and low-water cameras and roughly 0.6 from the aerial one, so this
       * window is 1 in the two views where the ribbon is a filament and ~0.1 in
       * the one where it is already a legible circuit. That asymmetry is the
       * whole safety argument for the boosts below: the ribbon covers fewest
       * pixels exactly when it is edge-on, so a grazing-keyed boost cannot
       * reproduce the green slab this line has been once - from altitude it is
       * simply not switched on.
       */
      uGrazeEdges: { value: new THREE.Vector2(0.22, 0.70) },
      /**
       * x = core band scale, y = body band scale, z = added *body* gain,
       * w = alpha multiplier - all at full grazing, all zero-weighted from above.
       *
       * The band scales move the *bright fraction* of the ribbon, not its
       * silhouette. The core scale goes the other way from the body's, and that
       * is deliberate: the core is `raceLineHot`, a near-white mint, and it is
       * the right accent on a ribbon seen face-on - a thin filament in a wide
       * green field - and the wrong one edge-on, where at 1.30 it was a quarter
       * of the few pixel rows the ribbon owns. 0.75 shrinks it to a spine while
       * the body grows to 76% of the half-width, so the pixels that are there
       * are green.
       *
       * The body gain is 0.22, down from 0.58, and the reduction is the point.
       * `raceLine` is (0.107, 1.00, 0.337) in linear - its green is already at
       * the ceiling, so gain past that moves red and blue and nothing else: 1.70
       * composites to (117,255,212) against 1.34's (107,255,197), ten counts.
       * What the extra gain really bought was luma 1.30 against the composer's
       * 0.85 bright pass - a wide halo with no line inside it, which is the pale
       * smear the chase frame showed. At 1.34 the body sits at luma 1.02: still
       * over the threshold, so the line still glows and still glows *green*, but
       * as a rim on a drawn stroke rather than as the stroke's replacement. The
       * contrast now comes from `uContour` instead.
       *
       * 1.45 on the alpha, with the ramp tightened by `uContour.z`, is what
       * makes those rows opaque line rather than half-strength fade.
       */
      uGrazeGain: { value: new THREE.Vector4(0.75, 1.55, 0.22, 1.45) },
      /**
       * The drawn edge: x = width in *screen pixels*, y = its floor in |side|
       * units, z = how far the alpha ramp's inner edge slides toward the
       * silhouette at full grazing, w = the contour's darkness as a fraction of
       * `uLine`.
       *
       * x is a pixel count and not a width in metres, which is the whole fix.
       * The previous contour was 0.09 of half-width - 16 cm of water - so it was
       * a visible band from altitude and a hundredth of a pixel from the chase
       * camera, i.e. absent from the only view it was added for. Sized off
       * `fwidth(|side|)` it is 2 px at every range and every foreshortening.
       *
       * y = 0.055 (9.6 cm) keeps it from collapsing to nothing in the first few
       * metres, where the ribbon is wide on screen and the pixel width would put
       * the edge inside a single texel of the band it is meant to bound.
       *
       * w = 0.27 of `uLine` is linear (0.029, 0.27, 0.091) - a dark *green*.
       * Over foam that reads as the line's own shadow; the neutral dark that a
       * previous pass used here is what stained every whitecap it crossed grey,
       * and it is not coming back.
       */
      uContour: { value: new THREE.Vector4(2.0, 0.055, 0.45, 0.27) },
      uChevron: { value: new THREE.Vector2(1 / chevronPeriod, 0.42) },
      uScroll: { value: CHEVRON_SPEED },
      uOpacity: { value: RIBBON_OPACITY },
      uFade: { value: new THREE.Vector2(RIBBON_FADE_START, RIBBON_FADE_END) },
      uNearFade: { value: new THREE.Vector2(RIBBON_NEAR_GONE, RIBBON_NEAR_FULL) },
      uMode: { value: mode },
      uHalfWidth: { value: half },
      uCheck: { value: new THREE.Vector2(2.4, 2.8) },
      uCameraFar: { value: CAMERA_FAR },
      uFogColor: fogColor,
      uFogRange: lineFogRange,
    });

    // The checkered strip is the start *gate's* line on the water, so it takes
    // the gate's drawn span rather than the full 26 m course half-width - a
    // 60 m chequerboard under a 28 m gate reads as two unrelated objects, and
    // the strip is the one the eye measures the gate against.
    const startHalf = Math.min(GATE_DRAW_MAX_HALF,
      Math.max(GATE_DRAW_MIN_HALF, this.widthAt(0) * GATE_DRAW_RATIO)) * START_WIDEN;

    this.raceLineMat = new THREE.ShaderMaterial({
      name: 'CourseRaceLine',
      glslVersion: THREE.GLSL3,
      uniforms: lineUniforms(0, RIBBON_HALF),
      vertexShader: src.vertexShader,
      fragmentShader: src.fragmentShader,
      lights: false,
      fog: false,
      transparent: true,
      // The line must never occlude a boat or the spray over it, and it lies on
      // a surface it agrees with exactly - so it tests depth but does not write.
      depthWrite: false,
      depthTest: true,
      // The ribbon and the sea are the image of the same parameter space under
      // the same map, which makes them *coplanar*, not merely close. The 3.5 cm
      // lift in the vertex shader is a constant, and a constant is the wrong
      // shape for a depth buffer whose resolution falls off as the square of
      // distance; the offset is, so the two are added rather than one being
      // tuned to cover the other. Together they take the ribbon off the sea's
      // depth plane at every range without ever lifting it far enough to read
      // as hovering.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    this.startStripMat = this.raceLineMat.clone();
    this.startStripMat.name = 'CourseStartLine';
    this.startStripMat.uniforms = lineUniforms(1, startHalf);
    // The strip's checker is drawn in `uHot` against `uInk`; a start line is
    // white, not amber, so it takes the foam colour instead of the line's.
    (this.startStripMat.uniforms.uHot!.value as THREE.Color).copy(PALETTE.foam);
    // The start line is a mark on the course, not a hint about it: it is read
    // once, at speed, and it is allowed to be opaque.
    this.startStripMat.uniforms.uOpacity!.value = 0.92;
    // The strip is 6.5 m of course you drive over; a near fade on it would blank
    // the finish line at the exact moment it is crossed.
    (this.startStripMat.uniforms.uNearFade!.value as THREE.Vector2).set(0, 0.5);

    this.raceLine = new THREE.Mesh(this.buildRibbonGeometry(RIBBON_HALF, 0, this.totalLength), this.raceLineMat);
    this.raceLine.name = 'raceLine';
    // Ahead of the ocean (0), behind the wake foam (4) and the spray (6). The
    // ordering is what decides the art direction question - the foam wins, and
    // the line runs under the churn.
    this.raceLine.renderOrder = 2;
    this.raceLine.frustumCulled = false;
    this.raceLine.matrixAutoUpdate = false;
    this.group.add(this.raceLine);

    this.startStrip = new THREE.Mesh(this.buildStartStripGeometry(startHalf), this.startStripMat);
    this.startStrip.name = 'startLine';
    this.startStrip.renderOrder = 3;
    this.startStrip.frustumCulled = false;
    this.startStrip.matrixAutoUpdate = false;
    this.group.add(this.startStrip);

    // --- gate furniture ------------------------------------------------------
    this.buildGateData();
    const gn = this.gateData.length;

    this.pylonMat = makeCelMaterial({
      ...CEL_PRESETS.metal(PALETTE.neutral),
      name: 'CoursePylon',
      vertexColors: true,
      uniforms: { uFogColor: fogColor, uFogRange: fogRange },
      fragmentHead: 'uniform vec3 uFogColor;\nuniform vec2 uFogRange;',
      // CelMaterial has no fog of its own, but the sea and the sky both haze out
      // - a gate on the far side of the lap is a kilometre away and would sit on
      // top of the atmosphere without this. Tinting the albedo (rather than the
      // final colour) means the ramp still runs, so the fogged form keeps its
      // bands instead of flattening to a silhouette.
      fragmentBody: `
  float fogT = clamp((vViewDepth - uFogRange.x) / max(uFogRange.y - uFogRange.x, 1e-3), 0.0, 1.0);
  fogT = fogT * fogT * (3.0 - 2.0 * fogT);
  albedo = mix(albedo, uFogColor, fogT);
  edgeMask *= 1.0 - fogT;
`,
    });
    this.buoyMat = makeCelMaterial({
      ...CEL_PRESETS.hull(PALETTE.neutral),
      name: 'CourseBuoy',
      vertexColors: true,
      uniforms: { uFogColor: fogColor, uFogRange: fogRange },
      fragmentHead: 'uniform vec3 uFogColor;\nuniform vec2 uFogRange;',
      fragmentBody: `
  float fogT = clamp((vViewDepth - uFogRange.x) / max(uFogRange.y - uFogRange.x, 1e-3), 0.0, 1.0);
  fogT = fogT * fogT * (3.0 - 2.0 * fogT);
  albedo = mix(albedo, uFogColor, fogT);
  edgeMask *= 1.0 - fogT;
`,
    });

    this.pylons = new THREE.InstancedMesh(buildPylonGeometry(), this.pylonMat, gn * 2);
    this.pylons.name = 'gatePylons';
    // The instance matrices move every frame, so three's geometry-derived bounds
    // say nothing useful about where these are. Culling is not worth a per-frame
    // bounding-sphere rebuild for nine draw calls.
    this.pylons.frustumCulled = false;
    this.pylons.matrixAutoUpdate = false;
    this.pylons.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pylonInk = addInstancedOutline(this.pylons, { thickness: 2.4, worldPad: 0.01 });
    this.group.add(this.pylonInk, this.pylons);

    const lampTint = new Float32Array(gn * 2 * 3);
    const lampFlags = new Float32Array(gn * 2 * 2);
    const bannerTint = new Float32Array(gn * 3);
    const bannerFlags = new Float32Array(gn * 2);
    for (let i = 0; i < gn; i++) {
      bannerTint[i * 3 + 0] = PALETTE.gateIdle.r;
      bannerTint[i * 3 + 1] = PALETTE.gateIdle.g;
      bannerTint[i * 3 + 2] = PALETTE.gateIdle.b;
      bannerFlags[i * 2 + 0] = 0;
      bannerFlags[i * 2 + 1] = i === 0 ? 1 : 0;   // style: gate 0 is the start line
      for (let k = 0; k < 2; k++) {
        const j = i * 2 + k;
        lampTint[j * 3 + 0] = PALETTE.gateIdle.r;
        lampTint[j * 3 + 1] = PALETTE.gateIdle.g;
        lampTint[j * 3 + 2] = PALETTE.gateIdle.b;
        lampFlags[j * 2 + 0] = 0;
        lampFlags[j * 2 + 1] = 0;
      }
    }
    this.lampFlags = new THREE.InstancedBufferAttribute(lampFlags, 2);
    this.bannerFlags = new THREE.InstancedBufferAttribute(bannerFlags, 2);
    this.lampTint = new THREE.InstancedBufferAttribute(lampTint, 3);
    this.bannerTint = new THREE.InstancedBufferAttribute(bannerTint, 3);

    const glowUniforms = (): Record<string, THREE.IUniform> => ({
      uTime: { value: 0 },
      uFrame: { value: PALETTE.hullDark.clone() },
      uInk: { value: PALETTE.ink.clone() },
      uHot: { value: PALETTE.foam.clone() },
      uSun: { value: SUN_DIR.clone() },
      uArrow: { value: new THREE.Vector3(7, 0.42, 0.55) },
      uCheck: { value: new THREE.Vector2(40, 4) },
      // Idle gates glow enough to be found at range; the lit one adds a pulse on
      // top. Both push the colour past the post stack's 0.85 bloom threshold, so
      // the halo is the composite's, not a second piece of geometry.
      uEmissive: { value: new THREE.Vector2(0.32, 0.80) },
      uWobble: { value: new THREE.Vector3(0, 0, 0) },
      uCameraFar: { value: CAMERA_FAR },
      uFogColor: fogColor,
      uFogRange: fogRange,
    });

    this.bannerMat = new THREE.ShaderMaterial({
      name: 'CourseGateBanner',
      glslVersion: THREE.GLSL3,
      uniforms: glowUniforms(),
      vertexShader: GATE_BANNER_VERT,
      fragmentShader: GATE_BANNER_FRAG,
      lights: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    // Banner-specific overrides on the shared glow recipe.
    //
    // The emissive was 0.32 idle. Added on top of a tint that already sat at the
    // channel ceiling, that is what clipped the banner to a flat (0,254,97) with
    // white chevrons at 254 - the highest chroma and the highest value in the
    // picture, on the largest object in it, which made the road sign the subject
    // instead of the racer. 0.09 keeps the field reading as lit cloth; the lit
    // gate still gains 0.5 on the pulse and still clears the bloom threshold, so
    // "which gate is mine" is answered by the change rather than by shouting.
    (this.bannerMat.uniforms.uEmissive!.value as THREE.Vector2).set(0.08, 0.36);
    // 5 marks along the span, drifting slowly, with the chevron arms swept at
    // 0.9 of a cell. The count is a *density*, not a number: the span went from
    // ~50 m to ~21 m, and 9 marks on the short banner is a stripe pattern rather
    // than a row of signs. The drift is a tenth of the old scroll rate: this is
    // course furniture breathing, not an arrow telling the eye where to go.
    (this.bannerMat.uniforms.uArrow!.value as THREE.Vector3).set(5, 0.045, 0.9);
    // Checker cells on the start/finish banner: 36 along by 2 up is a 0.6 m
    // square on a 21 m by 1.15 m span. Squares, because a checker whose cells
    // are four times wider than they are tall reads as a barcode.
    (this.bannerMat.uniforms.uCheck!.value as THREE.Vector2).set(36, 2);
    // Twist amplitude, waves along the span, rate. Half a radian of twist over
    // three and a bit waves is enough to keep the cel bands moving along the
    // cloth without ever letting the banner look like it is flapping loose.
    // 19 waves was a wavelength of 2.6 m on a 50 m span; on a 21 m span the same
    // number is a 1.1 m ripple, which is corrugation, not cloth. 8 keeps the
    // wavelength where it was in metres.
    (this.bannerMat.uniforms.uWobble!.value as THREE.Vector3).set(0.42, 8.0, 0.55);
    this.lampMat = new THREE.ShaderMaterial({
      name: 'CourseGateLamp',
      glslVersion: THREE.GLSL3,
      uniforms: glowUniforms(),
      vertexShader: GATE_LAMP_VERT,
      fragmentShader: GATE_LAMP_FRAG,
      lights: false,
      fog: false,
    });
    // The lamp is a small object that has to be found at range, so it keeps most
    // of its gain - but at 0.32/0.80 it blew to flat white with a chroma halo
    // wider than the drum, which cost it its shape. This keeps the beacon and
    // gives the bands back.
    (this.lampMat.uniforms.uEmissive!.value as THREE.Vector2).set(0.20, 0.62);

    const bannerGeo = buildBannerGeometry();
    bannerGeo.setAttribute('aTint', this.bannerTint);
    bannerGeo.setAttribute('aFlags', this.bannerFlags);
    this.banners = new THREE.InstancedMesh(bannerGeo, this.bannerMat, gn);
    this.banners.name = 'gateBanners';
    this.banners.frustumCulled = false;
    this.banners.matrixAutoUpdate = false;
    this.banners.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // The banner's single contour, at the same weight the boats carry. It is the
    // only dark line the banner is allowed: the hem inside it is now a deep step
    // of the banner's own hue, not a second near-black band five times heavier
    // than every other line in the game.
    this.bannerInk = addInstancedOutline(this.banners, { thickness: 2.5, worldPad: 0.010 });
    this.group.add(this.bannerInk, this.banners);

    const lampGeo = buildLampGeometry();
    lampGeo.setAttribute('aTint', this.lampTint);
    lampGeo.setAttribute('aFlags', this.lampFlags);
    this.lamps = new THREE.InstancedMesh(lampGeo, this.lampMat, gn * 2);
    this.lamps.name = 'gateLamps';
    this.lamps.frustumCulled = false;
    this.lamps.matrixAutoUpdate = false;
    this.lamps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.lamps);

    // --- buoys ---------------------------------------------------------------
    this.placeBuoys(rng);
    const bn = Math.max(1, this.buoyX.length);
    this.buoys = new THREE.InstancedMesh(buildBuoyGeometry(), this.buoyMat, bn);
    this.buoys.name = 'courseBuoys';
    this.buoys.frustumCulled = false;
    this.buoys.matrixAutoUpdate = false;
    this.buoys.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.buoyInk = addInstancedOutline(this.buoys, { thickness: 2.1, worldPad: 0.01 });
    this.group.add(this.buoyInk, this.buoys);

    this.fogged.push(this.raceLineMat, this.startStripMat, this.bannerMat, this.lampMat,
      this.pylonMat, this.buoyMat);

    scene.add(this.group);

    // Place everything on the sea as it is at t = 0 so the first frame drawn is
    // already correct - a gate that pops a metre on frame two is a visible bug in
    // the harness's very first capture.
    this.update(0, 0);
  }

  // ------------------------------------------------------------- tables ------

  /**
   * Builds the arc-length parametrisation and everything derived from it.
   *
   * The curve is first walked at `RAW_SAMPLES` uniform *parameter* steps to get
   * a cumulative length map, then that map is inverted at `SAMPLES` uniform
   * *arc-length* steps. Everything the class exposes is indexed by arc length,
   * which is what makes `t` mean "how far round the lap" rather than "which
   * control point", and is why a boat's progress and an AI's lookahead can both
   * be plain arithmetic on it.
   */
  private buildTables(cpWidth: Float32Array, cpCount: number): number {
    const rawX = new Float64Array(RAW_SAMPLES + 1);
    const rawZ = new Float64Array(RAW_SAMPLES + 1);
    const cum = new Float64Array(RAW_SAMPLES + 1);
    const p = new THREE.Vector3();

    for (let i = 0; i <= RAW_SAMPLES; i++) {
      this.curve.getPoint(i / RAW_SAMPLES, p);
      rawX[i] = p.x;
      rawZ[i] = p.z;
    }
    for (let i = 1; i <= RAW_SAMPLES; i++) {
      cum[i] = cum[i - 1]! + Math.hypot(rawX[i]! - rawX[i - 1]!, rawZ[i]! - rawZ[i - 1]!);
    }
    const total = cum[RAW_SAMPLES]!;

    // Raw parameter at each arc sample, kept only long enough to map the
    // authored per-control-point widths onto the arc-length table.
    const su = new Float64Array(SAMPLES);
    for (let j = 0; j < SAMPLES; j++) {
      const s = (j / SAMPLES) * total;
      let lo = 0;
      let hi = RAW_SAMPLES;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid]! <= s) lo = mid; else hi = mid;
      }
      const span = cum[hi]! - cum[lo]!;
      const a = span > 1e-9 ? (s - cum[lo]!) / span : 0;
      this.sx[j] = rawX[lo]! + (rawX[hi]! - rawX[lo]!) * a;
      this.sz[j] = rawZ[lo]! + (rawZ[hi]! - rawZ[lo]!) * a;
      su[j] = (lo + a) / RAW_SAMPLES;
    }

    for (let j = 0; j < SAMPLES; j++) {
      const a = (j - 1 + SAMPLES) % SAMPLES;
      const b = (j + 1) % SAMPLES;
      const dx = this.sx[b] - this.sx[a];
      const dz = this.sz[b] - this.sz[a];
      const l = Math.hypot(dx, dz) || 1;
      this.tx[j] = dx / l;
      this.tz[j] = dz / l;
    }

    // Signed curvature from the turned angle per unit arc. Smoothed over ~20 m
    // because the raw per-sample value is a 2.2 m finite difference and picks up
    // the spline's own ripple; an AI braking on that would twitch.
    const ds = (2 * total) / SAMPLES;
    const raw = new Float32Array(SAMPLES);
    for (let j = 0; j < SAMPLES; j++) {
      const a = (j - 1 + SAMPLES) % SAMPLES;
      const b = (j + 1) % SAMPLES;
      // cross > 0 means the tangent swung toward the right of travel.
      const cross = this.tx[a] * this.tz[b] - this.tz[a] * this.tx[b];
      const dot = this.tx[a] * this.tx[b] + this.tz[a] * this.tz[b];
      raw[j] = Math.atan2(cross, dot) / ds;
    }
    boxBlur(raw, this.kappa, 9);

    // Width: the authored value lives on the control points, and for a closed
    // Catmull-Rom the raw parameter maps linearly onto control-point index, so
    // this is an exact lookup rather than a nearest-point search.
    const rawW = new Float32Array(SAMPLES);
    for (let j = 0; j < SAMPLES; j++) {
      const f = su[j]! * cpCount;
      const i0 = Math.floor(f) % cpCount;
      const frac = f - Math.floor(f);
      const i1 = (i0 + 1) % cpCount;
      rawW[j] = cpWidth[i0]! + (cpWidth[i1]! - cpWidth[i0]!) * frac;
    }
    // ~45 m of blur: wide enough that the course narrows into the chicane over a
    // couple of boat lengths rather than stepping at one control point.
    boxBlur(rawW, this.halfWidth, 20);

    return total;
  }

  // ---------------------------------------------------------- spline API -----

  /**
   * World point at arc-length parameter `t` (0..1, wrapped). y is always 0.
   *
   * `out` is optional only so the signature satisfies the race director's
   * `CourseGeometry`; every hot-path caller passes one, and the fallback
   * allocates rather than sharing a scratch vector, because a shared return
   * value would alias between two callers on the same frame.
   */
  pointAt(t: number, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    const f = wrap01(t) * SAMPLES;
    const i = Math.floor(f) % SAMPLES;
    const a = f - Math.floor(f);
    const j = (i + 1) % SAMPLES;
    return out.set(
      this.sx[i] + (this.sx[j] - this.sx[i]) * a,
      0,
      this.sz[i] + (this.sz[j] - this.sz[i]) * a
    );
  }

  /** Unit direction of travel at `t`. Horizontal. */
  tangentAt(t: number, out: THREE.Vector3): THREE.Vector3 {
    const f = wrap01(t) * SAMPLES;
    const i = Math.floor(f) % SAMPLES;
    const a = f - Math.floor(f);
    const j = (i + 1) % SAMPLES;
    const x = this.tx[i] + (this.tx[j] - this.tx[i]) * a;
    const z = this.tz[i] + (this.tz[j] - this.tz[i]) * a;
    const l = Math.hypot(x, z) || 1;
    return out.set(x / l, 0, z / l);
  }

  /**
   * Curvature magnitude at `t`, in 1/metres - so 0.04 is a 25 m radius. Always
   * positive; ask `tangentAt` at two nearby parameters if you need the corner's
   * handedness, because a signed value here would make every `k > threshold`
   * test silently ignore half the circuit.
   */
  curvatureAt(t: number): number {
    const f = wrap01(t) * SAMPLES;
    const i = Math.floor(f) % SAMPLES;
    const a = f - Math.floor(f);
    const j = (i + 1) % SAMPLES;
    return Math.abs(this.kappa[i] + (this.kappa[j] - this.kappa[i]) * a);
  }

  /** Half the course width at `t`, in metres. */
  widthAt(t: number): number {
    const f = wrap01(t) * SAMPLES;
    const i = Math.floor(f) % SAMPLES;
    const a = f - Math.floor(f);
    const j = (i + 1) % SAMPLES;
    return this.halfWidth[i] + (this.halfWidth[j] - this.halfWidth[i]) * a;
  }

  /**
   * Closest point on the racing line.
   *
   * Pass the caller's previous `t` as `hint` and this costs a 91-sample window
   * scan plus two segment projections - a few hundred nanoseconds, and it is
   * called for every racer every frame. Without a hint (or when the hint turns
   * out to be more than 140 m off, which is what a respawn or a first frame
   * looks like) it falls back to a strided scan of the whole table and then
   * refines, so it is never wrong, only occasionally slower.
   *
   * The returned object belongs to the Course and is recycled after
   * `PROJECTION_POOL` further calls - which is what keeps a 60 Hz query API from
   * allocating. Read what you need from it; do not store it.
   */
  project(p: THREE.Vector3, hint?: number): Projection {
    let best = -1;
    let bestD2 = Infinity;

    if (hint !== undefined && Number.isFinite(hint)) {
      const c = Math.floor(wrap01(hint) * SAMPLES) % SAMPLES;
      for (let k = -PROJECT_WINDOW; k <= PROJECT_WINDOW; k++) {
        const i = (c + k + SAMPLES) % SAMPLES;
        const dx = p.x - this.sx[i];
        const dz = p.z - this.sz[i];
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      if (bestD2 > PROJECT_FALLBACK_D2) best = -1;
    }

    if (best < 0) {
      bestD2 = Infinity;
      for (let i = 0; i < SAMPLES; i += PROJECT_STRIDE) {
        const dx = p.x - this.sx[i];
        const dz = p.z - this.sz[i];
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      const c = best;
      for (let k = -PROJECT_STRIDE; k <= PROJECT_STRIDE; k++) {
        const i = (c + k + SAMPLES) % SAMPLES;
        const dx = p.x - this.sx[i];
        const dz = p.z - this.sz[i];
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
    }

    // Refine onto the two segments meeting at the winning sample. Projecting
    // onto the segment rather than snapping to the sample matters: the table is
    // 2.2 m coarse, and a lateral offset quantised to 2.2 m would make the HUD's
    // off-line readout step visibly.
    let segI = best;
    let segT = 0;
    let segD2 = Infinity;
    let px = 0;
    let pz = 0;
    for (let k = -1; k <= 0; k++) {
      const i0 = (best + k + SAMPLES) % SAMPLES;
      const i1 = (i0 + 1) % SAMPLES;
      const ax = this.sx[i0];
      const az = this.sz[i0];
      const bx = this.sx[i1] - ax;
      const bz = this.sz[i1] - az;
      const ll = bx * bx + bz * bz;
      let u = ll > 1e-9 ? ((p.x - ax) * bx + (p.z - az) * bz) / ll : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const cx = ax + bx * u;
      const cz = az + bz * u;
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < segD2) { segD2 = d2; segI = i0; segT = u; px = cx; pz = cz; }
    }

    const j = (segI + 1) % SAMPLES;
    let dirX = this.tx[segI] + (this.tx[j] - this.tx[segI]) * segT;
    let dirZ = this.tz[segI] + (this.tz[j] - this.tz[segI]) * segT;
    const l = Math.hypot(dirX, dirZ) || 1;
    dirX /= l;
    dirZ /= l;

    const out = this.projPool[this.projCursor]!;
    this.projCursor = (this.projCursor + 1) % PROJECTION_POOL;
    out.t = (segI + segT) / SAMPLES;
    out.point.set(px, 0, pz);
    out.tangent.set(dirX, 0, dirZ);
    // Right of travel, with Y up, is (-dir.z, 0, dir.x): face +Z and your right
    // hand points at -X.
    out.lateral = (p.x - px) * -dirZ + (p.z - pz) * dirX;
    return out;
  }

  // ------------------------------------------------------------- ribbons -----

  /**
   * The racing line, as a dense strip in *parameter* space.
   *
   * The positions written here are the spline's own world XZ, but the vertex
   * shader treats them as the Gerstner map's input, exactly as the ocean treats
   * its disc vertices. That is what guarantees the line lands on the water: it
   * is the image of a curve under the same map, not a curve fitted to the
   * result. The visible consequence is that the drawn line breathes up to about
   * 1.2 m sideways as the swell passes - roughly a twentieth of the course
   * width - which reads as paint on moving water and is exactly right.
   */
  private buildRibbonGeometry(half: number, tStart: number, length: number): THREE.BufferGeometry {
    const rows = Math.max(8, Math.round(length / RIBBON_STEP)) + 1;
    const pos = new Float32Array(rows * 2 * 3);
    const side = new Float32Array(rows * 2);
    const dist = new Float32Array(rows * 2);
    const idx = new Uint32Array((rows - 1) * 6);

    const c = new THREE.Vector3();
    const d = new THREE.Vector3();
    for (let r = 0; r < rows; r++) {
      const s = (r / (rows - 1)) * length;
      const t = tStart + s / this.totalLength;
      this.pointAt(t, c);
      this.tangentAt(t, d);
      const rx = -d.z;
      const rz = d.x;
      for (let k = 0; k < 2; k++) {
        const sgn = k === 0 ? -1 : 1;
        const v = (r * 2 + k) * 3;
        pos[v] = c.x + rx * half * sgn;
        pos[v + 1] = 0;
        pos[v + 2] = c.z + rz * half * sgn;
        side[r * 2 + k] = sgn;
        dist[r * 2 + k] = s;
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      const a = r * 2;
      const o = r * 6;
      idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 3;
      idx[o + 3] = a; idx[o + 4] = a + 3; idx[o + 5] = a + 2;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setAttribute('aDist', new THREE.BufferAttribute(dist, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.name = 'raceLineRibbon';
    return g;
  }

  /**
   * The start/finish line: a strip laid across the full course width. Same
   * shader, same wave displacement, so it hugs the swell like the racing line -
   * a flat quad here would be the one place in the frame where something clearly
   * sits *on top of* the sea.
   */
  private buildStartStripGeometry(half: number): THREE.BufferGeometry {
    const ALONG = 4;
    const ACROSS = 26;
    const verts = (ALONG + 1) * (ACROSS + 1);
    const pos = new Float32Array(verts * 3);
    const side = new Float32Array(verts);
    const dist = new Float32Array(verts);
    const idx = new Uint32Array(ALONG * ACROSS * 6);

    const c = new THREE.Vector3();
    const d = new THREE.Vector3();
    let vi = 0;
    for (let a = 0; a <= ALONG; a++) {
      const s = (a / ALONG - 0.5) * START_STRIP_LENGTH;
      this.pointAt(s / this.totalLength, c);
      this.tangentAt(s / this.totalLength, d);
      const rx = -d.z;
      const rz = d.x;
      for (let b = 0; b <= ACROSS; b++) {
        const f = (b / ACROSS) * 2 - 1;
        pos[vi * 3] = c.x + rx * half * f;
        pos[vi * 3 + 1] = 0;
        pos[vi * 3 + 2] = c.z + rz * half * f;
        side[vi] = f;
        dist[vi] = s;
        vi++;
      }
    }
    let o = 0;
    for (let a = 0; a < ALONG; a++) {
      for (let b = 0; b < ACROSS; b++) {
        const i0 = a * (ACROSS + 1) + b;
        const i1 = i0 + 1;
        const i2 = i0 + (ACROSS + 1);
        const i3 = i2 + 1;
        idx[o++] = i0; idx[o++] = i2; idx[o++] = i3;
        idx[o++] = i0; idx[o++] = i3; idx[o++] = i1;
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setAttribute('aDist', new THREE.BufferAttribute(dist, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.name = 'startLineStrip';
    return g;
  }

  // --------------------------------------------------------------- gates -----

  private buildGateData(): void {
    const c = new THREE.Vector3();
    const d = new THREE.Vector3();
    for (let i = 0; i < GATE_COUNT; i++) {
      const t = i / GATE_COUNT;
      this.pointAt(t, c);
      this.tangentAt(t, d);
      const courseHalf = this.widthAt(t);
      // The checkpoint plane is the course; the drawn marker is a size the eye
      // can judge. See GATE_DRAW_MIN_HALF.
      const halfW = courseHalf * (i === 0 ? START_WIDEN : 1);
      const drawHalf = Math.min(GATE_DRAW_MAX_HALF,
        Math.max(GATE_DRAW_MIN_HALF, courseHalf * GATE_DRAW_RATIO)) * (i === 0 ? START_WIDEN : 1);
      const rx = -d.z;
      const rz = d.x;
      const center = new THREE.Vector3(c.x, 0, c.z);
      const pub: Gate = {
        index: i,
        center,
        position: center,
        normal: new THREE.Vector3(d.x, 0, d.z),
        halfWidth: halfW,
        t,
      };
      this.gates.push(pub);
      this.gateData.push({
        pub,
        lx: c.x - rx * drawHalf, lz: c.z - rz * drawHalf,
        rx: c.x + rx * drawHalf, rz: c.z + rz * drawHalf,
      });
    }
  }

  /**
   * Buoys down the *outside* of every corner tighter than `BUOY_MAX_RADIUS`,
   * spaced in proportion to the radius so the hairpin gets a dense wall and the
   * long sweepers get an occasional marker. The outside of a corner is the side
   * the curvature turns away from, which is what a driver running wide actually
   * meets - buoys on the inside would just be apex markers nobody reads.
   */
  private placeBuoys(rng: Rng): void {
    const c = new THREE.Vector3();
    let sinceLast = Infinity;
    const step = this.totalLength / SAMPLES;

    for (let j = 0; j < SAMPLES; j++) {
      sinceLast += step;
      const k = this.kappa[j];
      const radius = Math.abs(k) > 1e-6 ? 1 / Math.abs(k) : Infinity;
      if (radius > BUOY_MAX_RADIUS) continue;

      const spacing = Math.min(BUOY_SPACING_MAX, Math.max(BUOY_SPACING_MIN, radius * 0.34));
      if (sinceLast < spacing) continue;

      const t = j / SAMPLES;
      // Never crowd a gate: a buoy inside the pylons reads as a second gate.
      let nearGate = false;
      for (let g = 0; g < this.gateData.length; g++) {
        let dt = Math.abs(t - this.gates[g]!.t);
        if (dt > 0.5) dt = 1 - dt;
        if (dt * this.totalLength < BUOY_GATE_CLEARANCE) { nearGate = true; break; }
      }
      if (nearGate) continue;

      this.pointAt(t, c);
      // Outside = away from the turn. kappa > 0 turns right, so the outside is
      // the left-hand side, i.e. -right.
      const sgn = k > 0 ? -1 : 1;
      const rx = -this.tz[j];
      const rz = this.tx[j];
      const off = this.halfWidth[j] + BUOY_MARGIN + rng.range(0, 1.4);
      this.buoyX.push(c.x + rx * off * sgn);
      this.buoyZ.push(c.z + rz * off * sgn);
      sinceLast = 0;
      if (this.buoyX.length >= BUOY_MAX) break;
    }
  }

  /**
   * Lights (or clears) a gate. The race director calls this with the player's
   * next checkpoint; out-of-range indices are ignored so a director that has run
   * past the last gate does not have to special-case the wrap.
   */
  setGateLit(index: number, lit: boolean): void {
    if (!Number.isFinite(index)) return;
    const i = Math.floor(index);
    if (i < 0 || i >= this.gateData.length) return;
    const v = lit ? 1 : 0;
    // Early out on a no-op: the director calls this every frame for the same
    // gate, and re-flagging the attribute would re-upload two buffers per frame
    // for nothing.
    if (this.bannerFlags.getX(i) === v) return;

    // Two cues, not one. The hue carries the state at any distance - lit gates
    // are the green the racing line is drawn in, idle ones the pink - and the
    // flag drives the pulse and the extra emissive on top of it. Brightness
    // alone would be invisible against a bright sea, and hue alone would be
    // easy to miss in peripheral vision.
    const c = lit ? PALETTE.gateLit : PALETTE.gateIdle;
    this.bannerTint.setXYZ(i, c.r, c.g, c.b);
    this.bannerTint.needsUpdate = true;
    this.lampTint.setXYZ(i * 2, c.r, c.g, c.b);
    this.lampTint.setXYZ(i * 2 + 1, c.r, c.g, c.b);
    this.lampTint.needsUpdate = true;

    this.bannerFlags.setX(i, v);
    this.bannerFlags.needsUpdate = true;
    this.lampFlags.setX(i * 2, v);
    this.lampFlags.setX(i * 2 + 1, v);
    this.lampFlags.needsUpdate = true;
  }

  // ---------------------------------------------------------------- grid -----

  /**
   * A staggered 2 x 2 grid behind the start line, facing along the spline.
   *
   * Slots alternate side and step back by half a row each time, so nobody is
   * directly in the wash of the boat in front and the pole slot has a clear run
   * at the line. Heights come from the sea as it is *now*, because this is also
   * what a mid-race restart calls.
   */
  gridSlots(n: number): GridSlot[] {
    const slots: GridSlot[] = [];
    const c = new THREE.Vector3();
    const d = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const row = i >> 1;
      const col = i & 1;
      const back = GRID_FIRST + row * GRID_ROW + col * GRID_STAGGER;
      const t = wrap01(-back / this.totalLength);
      this.pointAt(t, c);
      this.tangentAt(t, d);
      const lat = (col === 0 ? -1 : 1) * GRID_LATERAL;
      const x = c.x + -d.z * lat;
      const z = c.z + d.x * lat;
      slots.push({
        position: new THREE.Vector3(x, sampleHeight(x, z, this.time), z),
        // BoatState.heading is a yaw with 0 = +Z, so it is atan2(x, z).
        heading: Math.atan2(d.x, d.z),
      });
    }
    return slots;
  }

  // ---------------------------------------------------------------- tick -----

  /**
   * Bobs every moored object on the real surface and advances the shader clocks.
   *
   * Cost is two `sampleSurface` calls per gate plus one per buoy - about 70 a
   * frame, each an inverse solve of the horizontal displacement. That is cheap
   * enough to do exactly rather than approximately, and doing it exactly is the
   * whole reason the gates sit *in* the water instead of hovering over it.
   */
  update(_dt: number, elapsed: number): void {
    this.time = elapsed;
    this.syncFog();
    for (let i = 0; i < this.fogged.length; i++) {
      const u = this.fogged[i]!.uniforms.uTime;
      if (u) u.value = elapsed;
    }

    const gn = this.gateData.length;
    for (let i = 0; i < gn; i++) {
      const g = this.gateData[i]!;
      sampleSurface(g.lx, g.lz, elapsed, _sampleA);
      sampleSurface(g.rx, g.rz, elapsed, _sampleB);

      // Each pylon leans with the water under it, damped so it reads as a float
      // with draught rather than a stick balanced on the surface.
      _nrmL.copy(_up).lerp(_sampleA.normal, TILT).normalize();
      _nrmR.copy(_up).lerp(_sampleB.normal, TILT).normalize();

      _v0.set(g.lx, _sampleA.height, g.lz);
      _quat.setFromUnitVectors(_up, _nrmL);
      _mat.compose(_v0, _quat, _one);
      this.pylons.setMatrixAt(i * 2, _mat);
      _v1.copy(_v0).addScaledVector(_nrmL, LAMP_Y);
      _mat.compose(_v1, _quat, _one);
      this.lamps.setMatrixAt(i * 2, _mat);
      // Banner attachment point on the left mast.
      _axX.copy(_v0).addScaledVector(_nrmL, BANNER_Y);

      _v0.set(g.rx, _sampleB.height, g.rz);
      _quat.setFromUnitVectors(_up, _nrmR);
      _mat.compose(_v0, _quat, _one);
      this.pylons.setMatrixAt(i * 2 + 1, _mat);
      _v1.copy(_v0).addScaledVector(_nrmR, LAMP_Y);
      _mat.compose(_v1, _quat, _one);
      this.lamps.setMatrixAt(i * 2 + 1, _mat);
      _axZ.copy(_v0).addScaledVector(_nrmR, BANNER_Y);

      // The banner is built from its two attachment points, not from the gate's
      // centre - so when one mast is on a crest and the other in a trough the
      // banner rolls between them, which is the single cue that sells a gate as
      // floating rather than as scenery.
      _v1.addVectors(_axX, _axZ).multiplyScalar(0.5);
      const span = _axX.distanceTo(_axZ);
      _axY.subVectors(_axZ, _axX).divideScalar(span || 1);   // +x across the gate
      _fwd.copy(g.pub.normal);
      // Local +y from the width axis and the direction of travel; local +z falls
      // out of the cross so the basis stays orthonormal under any roll.
      _v0.crossVectors(_axY, _fwd).normalize();
      _axX.crossVectors(_axY, _v0).normalize();
      _mat.makeBasis(
        _axY.multiplyScalar(span),
        _v0.multiplyScalar(BANNER_HEIGHT),
        _axX.multiplyScalar(BANNER_THICKNESS)
      );
      _mat.setPosition(_v1);
      this.banners.setMatrixAt(i, _mat);

      // Publish the live gate midpoint. x/z never move (the gate is moored); the
      // height is the mean of its two legs, which is what a plane crossing test
      // wants.
      g.pub.center.set((g.lx + g.rx) * 0.5, (_sampleA.height + _sampleB.height) * 0.5, (g.lz + g.rz) * 0.5);
    }
    this.pylons.instanceMatrix.needsUpdate = true;
    this.lamps.instanceMatrix.needsUpdate = true;
    this.banners.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < this.buoyX.length; i++) {
      const x = this.buoyX[i]!;
      const z = this.buoyZ[i]!;
      sampleSurface(x, z, elapsed, _sampleA);
      _nrmL.copy(_up).lerp(_sampleA.normal, TILT).normalize();
      _v0.set(x, _sampleA.height, z);
      _quat.setFromUnitVectors(_up, _nrmL);
      _mat.compose(_v0, _quat, _one);
      this.buoys.setMatrixAt(i, _mat);
    }
    this.buoys.instanceMatrix.needsUpdate = true;
  }

  /**
   * Mirrors `scene.fog` so the course hazes out with the sea and the sky.
   * One write reaches every course material - see the note in the constructor.
   */
  private syncFog(): void {
    const fog = this.scene.fog;
    if (!(fog instanceof THREE.Fog)) return;
    // The *colour* is the scene's, always - the course has to arrive at the same
    // horizon everything else does. The ranges are the course's own, and are not
    // read from the scene: see HAZE_NEAR and LINE_HAZE_NEAR. Two uniform objects
    // now, because the ribbon hazes on a much longer schedule than the pylons.
    this.fogColorU.value.copy(fog.color);
    this.fogRangeU.value.set(Math.min(HAZE_NEAR, fog.far), Math.min(HAZE_FAR, fog.far));
    this.lineFogRangeU.value.set(
      Math.min(LINE_HAZE_NEAR, fog.far), Math.min(LINE_HAZE_FAR, fog.far));
  }

  /** Global dimmer for the racing line - for the results screen or a cinematic. */
  setLineOpacity(v: number): void {
    this.raceLineMat.uniforms.uOpacity!.value = v;
    this.startStripMat.uniforms.uOpacity!.value = v;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.raceLine.geometry.dispose();
    this.startStrip.geometry.dispose();
    this.pylons.geometry.dispose();
    this.lamps.geometry.dispose();
    this.banners.geometry.dispose();
    this.buoys.geometry.dispose();
    this.pylons.dispose();
    this.pylonInk.dispose();
    this.lamps.dispose();
    this.banners.dispose();
    this.bannerInk.dispose();
    this.buoys.dispose();
    this.buoyInk.dispose();
    this.raceLineMat.dispose();
    this.startStripMat.dispose();
    this.bannerMat.dispose();
    this.lampMat.dispose();
    this.pylonMat.dispose();
    this.buoyMat.dispose();
    (this.pylonInk.material as THREE.Material).dispose();
    (this.bannerInk.material as THREE.Material).dispose();
    (this.buoyInk.material as THREE.Material).dispose();
  }
}

/** Circular box blur over an arc-length table. `half` is in samples. */
function boxBlur(src: Float32Array, dst: Float32Array, half: number): void {
  const n = src.length;
  const w = half * 2 + 1;
  let acc = 0;
  for (let k = -half; k <= half; k++) acc += src[(k + n) % n]!;
  for (let i = 0; i < n; i++) {
    dst[i] = acc / w;
    acc += src[(i + half + 1) % n]! - src[(i - half + n) % n]!;
  }
}
