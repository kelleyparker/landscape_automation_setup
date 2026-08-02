import * as THREE from 'three';
import { PALETTE } from '../core/Palette';
import { CEL_PRESETS, makeCelMaterial, CelMaterial } from '../render/CelMaterial';
import { addOutlineRecursive } from '../render/OutlineHull';

/**
 * The boat, built entirely in code.
 *
 * A single-seat racing hydroplane: 4.2 m on the keel, 1.6 m across the beam, a
 * lofted rounded-V hull that flattens aft into a planing pad, sponsons either
 * side, a raised forward cowling with a wraparound screen, an engine cowl with
 * twin stacks, a bow spoiler and a dorsal fin.
 *
 * ## How it is put together
 *
 * Everything is a *loft*: a list of cross-section rings skinned with quads. Ten
 * stations along the keel define the hull; five define each cowl; a generic tube
 * builder covers the stacks, the yoke and the boost flame. Nothing is imported,
 * nothing is subdivided, and the whole boat is about 1450 triangles.
 *
 * Winding is not left to chance. Throughout this file a loft's rings advance
 * along `dv` and its profile advances along `du`, and every profile is ordered so
 * that `cross(du, dv)` points *out* of the surface. Get that backwards and the
 * inverted-hull ink shell turns inside out - the boat gets a solid indigo coat
 * and the error is obvious, but only after a render, so the ordering is spelled
 * out at each call site instead.
 *
 * ## Hard creases
 *
 * A hull needs a knife-sharp chine and smooth everything else. Both come out of
 * one mechanism: the profile carries the chine point *twice*, and the quad
 * between the two copies is skipped. `computeVertexNormals` then averages the
 * topside faces into one copy and the bottom faces into the other, so the crease
 * is exact while the rest of the hull stays round. Position-merged smoothing in
 * `OutlineHull` re-welds them for the ink shell, so the silhouette is still
 * watertight.
 *
 * ## Sharing
 *
 * Four boats, one set of geometry. The hull, cowls, stacks, yoke and flame are
 * module-level singletons; only the `trim` group - spoiler, fin and number plate -
 * is built per racer slot, because that is where the silhouette differences live.
 * Materials follow the same rule: every boat shares the trim/dark/metal materials
 * and owns only its hull colour and its flame.
 *
 * ## Palette without a material per colour
 *
 * `CelMaterial` multiplies `uColor` by a per-vertex colour. Setting `uColor` to
 * white makes that attribute the albedo outright, so one mesh can carry several
 * palette entries - the cowls are `hullDark` and the screen is `visor` in the
 * same draw call, and the number plate's cream backing and dark digits ride along
 * with the trim. The white is an identity multiplier, not a colour choice; every
 * actual colour in this file comes from `PALETTE`.
 */

// --------------------------------------------------------------- geometry ----

/** Identity multiplier for the vertex-colour groups. Not a colour choice. */
const NEUTRAL = new THREE.Color(1, 1, 1);

/**
 * Ten stations from transom to stem. Spacing tightens forward, where the section
 * changes fastest - an even spread puts the same number of rings under the flat
 * planing pad, which needs almost none, as under the entry, which needs them all.
 */
const ST_Z: readonly number[] =     [-2.10, -1.62, -1.10, -0.55, 0.00, 0.52, 1.00, 1.42, 1.78, 2.10];
/** Chine half-width. Max beam sits just forward of the transom, as it does on a real hull. */
const ST_HB: readonly number[] =    [ 0.72,  0.78,  0.80,  0.80, 0.78, 0.72, 0.62, 0.47, 0.28, 0.05];
/** Keel line. y = 0 is the design waterline, so these are draughts. */
const ST_KEEL: readonly number[] =  [-0.30, -0.34, -0.36, -0.36,-0.34,-0.30,-0.24,-0.15,-0.04, 0.12];
/** Chine line. (chine - keel) is the deadrise: 0.10 m aft, 0.27 m forward. */
const ST_CHINE: readonly number[] = [-0.20, -0.21, -0.20, -0.17,-0.12,-0.05, 0.03, 0.12, 0.22, 0.32];
/** Sheer line, rising toward the bow so the boat has a lifted nose in profile. */
const ST_DECK: readonly number[] =  [ 0.30,  0.32,  0.34,  0.36, 0.38, 0.40, 0.43, 0.46, 0.49, 0.52];
/**
 * Bottom-section exponent. `y = keel + deadrise * t^p` across the half-beam:
 * p = 1 is a straight V, and the larger p gets the flatter the middle of the
 * section runs before it turns up to the chine. 2.6 at the transom is the planing
 * pad; 1.15 at the stem is a fine entry that slices instead of slapping.
 */
const ST_VEE: readonly number[] =   [ 2.60,  2.50,  2.35,  2.15, 1.95, 1.75, 1.55, 1.38, 1.24, 1.15];
/** Topside flare: how far the sheer stands outboard of the chine. */
const ST_FLARE: readonly number[] = [ 1.00,  1.01,  1.02,  1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.06];

/** Bottom sample parameters, chine (1) to keel (0). Four segments per half. */
const BOTTOM_T: readonly number[] = [1.0, 0.72, 0.44, 0.20, 0.0];

/** Profile length: 7 points per side plus the shared keel point. */
const HULL_PROFILE_N = 15;
/** Profile segments spanning the duplicated chine point; skipped by the loft. */
const HULL_SKIP: readonly boolean[] = (() => {
  const s = new Array<boolean>(HULL_PROFILE_N - 1).fill(false);
  s[2] = true;   // port chine: topside copy -> bottom copy
  s[11] = true;  // starboard chine
  return s;
})();

/** Deck crown at the centreline, tapering to zero at the sheer. */
const DECK_CROWN = 0.05;
/** Cockpit footwell: an elliptical depression the rider sits down inside. */
const WELL_Z = 0.10;
const WELL_HALF_L = 0.80;
const WELL_HALF_U = 0.62;
const WELL_DEPTH = 0.21;

/** Deck cross-section sampling, dense in the middle where the footwell is. */
const DECK_U: readonly number[] = [1, 0.78, 0.60, 0.44, 0.28, 0.14, 0, -0.14, -0.28, -0.44, -0.60, -0.78, -1];

/** Where the rider's hips land, on the floor of the footwell. */
export const SEAT_LOCAL = new THREE.Vector3(0, 0.235, -0.02);
/** Steering column pivot; the yoke geometry is built relative to this. */
export const YOKE_PIVOT_LOCAL = new THREE.Vector3(0, 0.50, 0.84);
/** Grip centres, in yoke-pivot space. */
const HANDLE_LOCAL_X = 0.27;
const HANDLE_LOCAL_Y = 0.22;
const HANDLE_LOCAL_Z = -0.14;

/**
 * Per-slot silhouette. Four boats in the same class have to be told apart at a
 * hundred metres, where the racer colour is two or three pixels wide - so the
 * differences that matter are the ones that change the *outline*.
 */
const FIN_HEIGHT: readonly number[] = [0.34, 0.52, 0.24, 0.43];
const FIN_SWEEP: readonly number[] = [0.16, 0.32, 0.05, 0.24];
/** [halfSpan, chord, tipRise, anhedral, tipSweep] for the bow spoiler. */
const SPOILER: readonly (readonly number[])[] = [
  [0.46, 0.30, 0.055, 0.000, 0.05], // P1 broad straight blade
  [0.38, 0.42, 0.150, 0.020, 0.16], // P2 narrow swept delta, tips up
  [0.54, 0.24, 0.000, 0.070, 0.02], // P3 wide anhedral plank
  [0.43, 0.34, 0.105, -0.045, 0.10], // P4 gulled mid-span
];

// ---------------------------------------------------------------- helpers ----

function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/**
 * Accumulates one material group's geometry.
 *
 * Normals are never written by hand - the builder emits positions, colours and
 * indices, and `computeVertexNormals` does the rest. That is only correct because
 * every hard crease in this file is expressed as duplicated vertices, which is
 * cheaper to reason about than a normal per face and keeps the smooth surfaces
 * genuinely smooth.
 */
class Mesher {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  vertex(x: number, y: number, z: number, c: THREE.Color): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** a,b are ring r at profile i,i+1; c,d are ring r+1 at the same. */
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, b, d, c);
  }

  /**
   * Skins a run of rings. `rings[r]` is a flat xyz list of the same length for
   * every ring. Returns each ring's first vertex index so callers can cap the
   * ends without re-emitting the boundary.
   */
  loft(
    rings: readonly number[][],
    color: THREE.Color,
    closed = false,
    skip: readonly boolean[] | null = null,
  ): number[] {
    const n = rings[0]!.length / 3;
    const base: number[] = [];
    for (const ring of rings) {
      base.push(this.pos.length / 3);
      for (let i = 0; i < n; i++) {
        this.vertex(ring[i * 3]!, ring[i * 3 + 1]!, ring[i * 3 + 2]!, color);
      }
    }
    const segs = closed ? n : n - 1;
    for (let r = 0; r + 1 < rings.length; r++) {
      const b0 = base[r]!;
      const b1 = base[r + 1]!;
      for (let i = 0; i < segs; i++) {
        if (skip && skip[i]) continue;
        const j = (i + 1) % n;
        this.quad(b0 + i, b0 + j, b1 + i, b1 + j);
      }
    }
    return base;
  }

  /**
   * Closes a ring with a centroid fan. `flip` reverses the winding for the end of
   * a run, where the surface normal points the other way.
   */
  fan(ring: readonly number[], color: THREE.Color, flip: boolean): void {
    const n = ring.length / 3;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += ring[i * 3]!; cy += ring[i * 3 + 1]!; cz += ring[i * 3 + 2]!; }
    const c = this.vertex(cx / n, cy / n, cz / n, color);
    const first = this.pos.length / 3;
    for (let i = 0; i < n; i++) {
      this.vertex(ring[i * 3]!, ring[i * 3 + 1]!, ring[i * 3 + 2]!, color);
    }
    for (let i = 0; i < n; i++) {
      const a = first + i;
      const b = first + ((i + 1) % n);
      if (flip) this.tri(c, b, a); else this.tri(c, a, b);
    }
  }

  /**
   * A swept circular tube. The frame is rebuilt per path point from the local
   * tangent; with `theta` increasing and a right-handed (normal, binormal,
   * tangent) basis the outward winding comes out for free - see the class notes.
   */
  tube(
    path: readonly number[][],
    radii: readonly number[],
    sides: number,
    color: THREE.Color,
    capStart = true,
    capEnd = true,
  ): void {
    const rings: number[][] = [];
    const tx = new THREE.Vector3();
    const nx = new THREE.Vector3();
    const bx = new THREE.Vector3();
    const up = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();

    for (let p = 0; p < path.length; p++) {
      const prev = path[Math.max(0, p - 1)]!;
      const next = path[Math.min(path.length - 1, p + 1)]!;
      a.set(prev[0]!, prev[1]!, prev[2]!);
      b.set(next[0]!, next[1]!, next[2]!);
      tx.subVectors(b, a);
      if (tx.lengthSq() < 1e-12) tx.set(0, 0, 1);
      tx.normalize();
      // Any reference that is not parallel to the tangent works; the swap keeps
      // a vertical tube (the yoke stem) from degenerating.
      up.set(0, 1, 0);
      if (Math.abs(tx.y) > 0.9) up.set(1, 0, 0);
      nx.crossVectors(up, tx).normalize();
      bx.crossVectors(tx, nx);

      const c = path[p]!;
      const r = radii[p]!;
      const ring: number[] = [];
      for (let s = 0; s < sides; s++) {
        const th = (s / sides) * Math.PI * 2;
        const ct = Math.cos(th) * r;
        const st = Math.sin(th) * r;
        ring.push(
          c[0]! + nx.x * ct + bx.x * st,
          c[1]! + nx.y * ct + bx.y * st,
          c[2]! + nx.z * ct + bx.z * st,
        );
      }
      rings.push(ring);
    }

    this.loft(rings, color, true);
    if (capStart) this.fan(rings[0]!, color, true);
    if (capEnd) this.fan(rings[rings.length - 1]!, color, false);
  }

  /** A flat panel. The face normal is `u x v`. */
  panel(
    ox: number, oy: number, oz: number,
    ux: number, uy: number, uz: number,
    vx: number, vy: number, vz: number,
    hw: number, hh: number,
    color: THREE.Color,
  ): void {
    const a = this.vertex(ox - ux * hw - vx * hh, oy - uy * hw - vy * hh, oz - uz * hw - vz * hh, color);
    const b = this.vertex(ox + ux * hw - vx * hh, oy + uy * hw - vy * hh, oz + uz * hw - vz * hh, color);
    const c = this.vertex(ox + ux * hw + vx * hh, oy + uy * hw + vy * hh, oz + uz * hw + vz * hh, color);
    const d = this.vertex(ox - ux * hw + vx * hh, oy - uy * hw + vy * hh, oz - uz * hw + vz * hh, color);
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  toGeometry(name: string, withColor: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    if (withColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.name = name;
    return g;
  }

  get triangleCount(): number { return this.idx.length / 3; }
}

// ------------------------------------------------------------- hull parts ----

/**
 * One hull cross-section, port sheer -> keel -> starboard sheer.
 *
 * The chine point appears twice (indices 2/3 and 11/12) so the loft can leave a
 * hard edge there; see HULL_SKIP.
 */
function hullProfile(s: number): number[] {
  const z = ST_Z[s]!;
  const hb = ST_HB[s]!;
  const keel = ST_KEEL[s]!;
  const chine = ST_CHINE[s]!;
  const deck = ST_DECK[s]!;
  const vee = ST_VEE[s]!;
  const flare = ST_FLARE[s]!;
  const dead = chine - keel;
  const out: number[] = [];

  const side = (sgn: number, down: boolean): void => {
    const pts: number[][] = [];
    // Topside: chine out and up to the sheer, with a slight outward belly.
    pts.push([sgn * hb * flare, deck]);
    pts.push([sgn * hb * (1 + (flare - 1) * 0.55) * 1.012, chine + (deck - chine) * 0.52]);
    pts.push([sgn * hb, chine]);              // chine, topside copy
    pts.push([sgn * hb, chine]);              // chine, bottom copy (hard crease)
    for (let i = 1; i < BOTTOM_T.length - 1; i++) {
      const t = BOTTOM_T[i]!;
      pts.push([sgn * hb * t, keel + dead * Math.pow(t, vee)]);
    }
    if (!down) pts.reverse();
    for (const p of pts) out.push(p[0]!, p[1]!, z);
  };

  side(-1, true);                 // port, sheer -> keel
  out.push(0, keel, z);           // shared keel point
  side(1, false);                 // starboard, keel -> sheer
  return out;
}

/** One deck cross-section, starboard -> port so the crown faces +Y. */
function deckProfile(s: number): number[] {
  const z = ST_Z[s]!;
  const hb = ST_HB[s]!* ST_FLARE[s]!;
  const base = ST_DECK[s]!;
  const out: number[] = [];
  for (const u of DECK_U) {
    out.push(u * hb, base + DECK_CROWN * (1 - u * u) - wellDepth(z, u), z);
  }
  return out;
}

/** Elliptical footwell, zero outside its ellipse so the sheer is untouched. */
function wellDepth(z: number, u: number): number {
  const dz = (z - WELL_Z) / WELL_HALF_L;
  const du = u / WELL_HALF_U;
  const rr = dz * dz + du * du;
  if (rr >= 1) return 0;
  return WELL_DEPTH * smooth01(1 - rr);
}

/** Deck surface height at (station, u) - used by the livery stripes. */
function deckY(s: number, u: number): number {
  return ST_DECK[s]! + DECK_CROWN * (1 - u * u) - wellDepth(ST_Z[s]!, u);
}

function buildHullGroup(): THREE.BufferGeometry {
  const m = new Mesher();
  const c = NEUTRAL;

  const hullRings: number[][] = [];
  const deckRings: number[][] = [];
  for (let s = 0; s < ST_Z.length; s++) {
    hullRings.push(hullProfile(s));
    deckRings.push(deckProfile(s));
  }

  // Rings run stern -> bow (dv = +Z), profile runs port -> starboard (du = +X on
  // the bottom), so cross(du, dv) = -Y: outward, because the bottom faces down.
  m.loft(hullRings, c, false, HULL_SKIP);
  // Deck profile runs starboard -> port, flipping du so the crown faces up.
  m.loft(deckRings, c, false);

  // Transom and stem caps close the solid. Both faces are planar (all points
  // share the station's z), so a centroid fan is exact rather than approximate.
  //
  // The outline is listed port-sheer -> keel -> starboard-sheer -> back across
  // the deck. Seen from astern that traversal runs clockwise, so the transom's
  // fan has to be reversed to face -Z; seen from ahead the same list runs
  // counter-clockwise and the stem's fan does not. Getting this backwards leaves
  // the boat with a hole where the chase camera spends the entire race looking.
  m.fan(capOutline(hullRings[0]!, deckRings[0]!), c, true);
  const last = ST_Z.length - 1;
  m.fan(capOutline(hullRings[last]!, deckRings[last]!), c, false);

  buildSponsons(m, c);
  return m.toGeometry('boatHull', false);
}

/**
 * Stitches a hull section and its deck section into one closed outline: down the
 * port topside, round the keel, up the starboard topside, then back across the
 * deck. Duplicate chine points are dropped - they would only add slivers.
 */
function capOutline(hull: number[], deck: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < HULL_PROFILE_N; i++) {
    if (i === 3 || i === 12) continue; // second copy of each chine point
    out.push(hull[i * 3]!, hull[i * 3 + 1]!, hull[i * 3 + 2]!);
  }
  // Deck runs starboard -> port; the hull ended at starboard, so walk it forward
  // skipping both endpoints, which the hull already contributed.
  const n = DECK_U.length;
  for (let i = 1; i < n - 1; i++) {
    out.push(deck[i * 3]!, deck[i * 3 + 1]!, deck[i * 3 + 2]!);
  }
  return out;
}

/** Sponson stations: z, outer x, inner x, top y, bottom y. */
const SPON_Z: readonly number[] =     [0.15, 0.55, 0.95, 1.30, 1.62];
const SPON_OUT: readonly number[] =   [0.86, 0.94, 0.96, 0.90, 0.74];
const SPON_IN: readonly number[] =    [0.70, 0.74, 0.72, 0.64, 0.52];
const SPON_TOP: readonly number[] =   [0.02, 0.06, 0.11, 0.18, 0.27];
const SPON_BOT: readonly number[] =   [-0.16, -0.14, -0.10, -0.02, 0.11];

/**
 * The two outboard pods. Their outer edges carry the boat when it leans, and
 * they are most of what the eye reads as "hydroplane" from the bow.
 *
 * Profile order is counter-clockwise about +X for the starboard pod (rings
 * advance +Z), mirrored for port - the mirror flips the handedness, so the port
 * ring list is reversed to put the winding back.
 */
function buildSponsons(m: Mesher, c: THREE.Color): void {
  for (const sgn of [1, -1]) {
    const rings: number[][] = [];
    for (let i = 0; i < SPON_Z.length; i++) {
      const z = SPON_Z[i]!;
      const o = SPON_OUT[i]!;
      const inn = SPON_IN[i]!;
      const top = SPON_TOP[i]!;
      const bot = SPON_BOT[i]!;
      const mid = (top + bot) * 0.5;
      const loop: number[][] = [
        [o, mid],                       // outboard edge
        [o * 0.95, top],                // outboard shoulder
        [inn, top + 0.02],              // inboard top, tucked against the hull
        [inn, bot + 0.05],              // inboard bottom
        [o * 0.95, bot],                // outboard chine
      ];
      if (sgn < 0) loop.reverse();
      const ring: number[] = [];
      for (const p of loop) ring.push(sgn * p[0]!, p[1]!, z);
      rings.push(ring);
    }
    m.loft(rings, c, true);
    m.fan(rings[0]!, c, sgn > 0);
    m.fan(rings[rings.length - 1]!, c, sgn < 0);
  }
}

// -------------------------------------------------------------- dark group ---

/** Rounded-shell station: z, half width, base y, top y. */
interface ShellStation { z: number; hw: number; base: number; top: number; }

/**
 * A cowl section: a superelliptical arch from the port base, over the top, to
 * the starboard base. The 0.55 exponent keeps the shoulders full, so the shape
 * reads as a moulded cowl rather than as half a cylinder.
 *
 * Ordered starboard -> port so that with rings advancing +Z the top faces up.
 */
function shellRing(st: ShellStation, n = 9): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const phi = (i / (n - 1)) * Math.PI;             // 0 = starboard, pi = port
    out.push(
      st.hw * Math.cos(phi),
      st.base + (st.top - st.base) * Math.pow(Math.sin(phi), 0.55),
      st.z,
    );
  }
  return out;
}

const FORE_COWL: readonly ShellStation[] = [
  { z: 0.86, hw: 0.40, base: 0.41, top: 0.80 },
  { z: 1.16, hw: 0.40, base: 0.43, top: 0.82 },
  { z: 1.46, hw: 0.36, base: 0.45, top: 0.79 },
  { z: 1.72, hw: 0.28, base: 0.47, top: 0.71 },
  { z: 1.92, hw: 0.15, base: 0.50, top: 0.58 },
];

const AFT_COWL: readonly ShellStation[] = [
  { z: -1.98, hw: 0.34, base: 0.300, top: 0.56 },
  { z: -1.62, hw: 0.42, base: 0.315, top: 0.66 },
  { z: -1.20, hw: 0.46, base: 0.335, top: 0.70 },
  { z: -0.86, hw: 0.44, base: 0.355, top: 0.68 },
  { z: -0.62, hw: 0.40, base: 0.375, top: 0.62 },
];

/** Windscreen rows, bottom to top. The tips sweep aft so the screen wraps. */
const SCREEN_HW: readonly number[] = [0.36, 0.34, 0.30];
const SCREEN_Y: readonly number[] = [0.72, 0.845, 0.94];
const SCREEN_Z: readonly number[] = [0.90, 0.845, 0.78];
const SCREEN_WRAP: readonly number[] = [0.18, 0.20, 0.22];
const SCREEN_COLS = 11;

function buildDarkGroup(): THREE.BufferGeometry {
  const m = new Mesher();
  const dark = PALETTE.hullDark;

  for (const cowl of [FORE_COWL, AFT_COWL]) {
    const rings = cowl.map((st) => shellRing(st));
    m.loft(rings, dark, false);
    // The arch is open along its bottom edge, so the end caps are closed against
    // the deck by the chord between the two base points; a centroid fan over the
    // arch alone is convex and does exactly that.
    m.fan(rings[0]!, dark, true);
    m.fan(rings[rings.length - 1]!, dark, false);
  }

  // Wraparound screen. Rows run bottom -> top (dv points up and aft) and columns
  // run port -> starboard, so cross(du, dv) faces forward, out of the cockpit.
  const rows: number[][] = [];
  for (let r = 0; r < 3; r++) {
    const ring: number[] = [];
    for (let i = 0; i < SCREEN_COLS; i++) {
      const u = (i / (SCREEN_COLS - 1)) * 2 - 1;
      ring.push(SCREEN_HW[r]! * u, SCREEN_Y[r]!, SCREEN_Z[r]! - SCREEN_WRAP[r]! * u * u);
    }
    rows.push(ring);
  }
  m.loft(rows, PALETTE.visor, false);

  return m.toGeometry('boatDark', true);
}

// ------------------------------------------------------------- metal group ---

function buildMetalGroup(): THREE.BufferGeometry {
  const m = new Mesher();
  const c = NEUTRAL;
  // Twin stacks rising off the engine cowl and kicking aft. The outlet flares,
  // which is the whole silhouette of an exhaust at this scale.
  for (const sgn of [-1, 1]) {
    m.tube(
      [
        [sgn * 0.17, 0.60, -1.30],
        [sgn * 0.18, 0.72, -1.50],
        [sgn * 0.20, 0.84, -1.74],
        [sgn * 0.21, 0.88, -1.84],
      ],
      [0.052, 0.055, 0.058, 0.072],
      8, c,
    );
  }
  return m.toGeometry('boatMetal', false);
}

/**
 * The steering yoke, built in pivot-local space so the whole assembly can be
 * rotated by the steering input without touching a vertex.
 */
function buildYokeGeometry(): THREE.BufferGeometry {
  const m = new Mesher();
  const c = NEUTRAL;
  const y = HANDLE_LOCAL_Y;
  const z = HANDLE_LOCAL_Z;
  // Column: up and aft out of the cowl.
  m.tube([[0, -0.02, 0.04], [0, 0.10, -0.02], [0, y, z + 0.03]], [0.045, 0.038, 0.032], 6, c);
  // Crossbar, then a fatter grip on each end.
  m.tube([[-0.20, y, z], [0, y + 0.015, z + 0.02], [0.20, y, z]], [0.026, 0.028, 0.026], 6, c);
  for (const sgn of [-1, 1]) {
    m.tube([[sgn * 0.19, y, z], [sgn * 0.345, y - 0.01, z - 0.012]], [0.043, 0.040], 6, c);
  }
  return m.toGeometry('boatYoke', false);
}

// -------------------------------------------------------------- trim group ---

/** Seven-segment strokes in a unit box, so the plate can be any size. */
const SEGMENTS: readonly (readonly number[])[] = [
  [-0.24, 0.37, 0.24, 0.50],    // a top
  [0.17, 0.06, 0.30, 0.50],     // b upper right
  [0.17, -0.50, 0.30, -0.06],   // c lower right
  [-0.24, -0.50, 0.24, -0.37],  // d bottom
  [-0.30, -0.50, -0.17, -0.06], // e lower left
  [-0.30, 0.06, -0.17, 0.50],   // f upper left
  [-0.24, -0.065, 0.24, 0.065], // g middle
];
/** Which strokes light for racing numbers 1..4. */
const DIGIT_SEGMENTS: readonly (readonly number[])[] = [
  [1, 2],             // 1
  [0, 1, 6, 4, 3],    // 2
  [0, 1, 6, 2, 3],    // 3
  [5, 6, 1, 2],       // 4
];

/**
 * A number plate: a cream backing panel with dark strokes standing proud of it.
 * `u` is the plate's right in view, `v` its up; the face normal is `u x v`, so
 * each call site picks the pair that makes the digit read the right way round
 * from the side it is meant to be seen from.
 */
function addPlate(
  m: Mesher, digit: number,
  ox: number, oy: number, oz: number,
  ux: number, uy: number, uz: number,
  vx: number, vy: number, vz: number,
  hw: number, hh: number,
): void {
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  m.panel(ox, oy, oz, ux, uy, uz, vx, vy, vz, hw, hh, PALETTE.hullLight);

  const segs = DIGIT_SEGMENTS[digit]!;
  // "1" only lights the two right-hand strokes, so it is nudged back to centre.
  const shift = digit === 0 ? -0.115 : 0;
  const lift = 0.006;
  for (const s of segs) {
    const r = SEGMENTS[s]!;
    const cx = (r[0]! + r[2]!) * 0.5 + shift;
    const cy = (r[1]! + r[3]!) * 0.5;
    const sw = (r[2]! - r[0]!) * 0.5;
    const sh = (r[3]! - r[1]!) * 0.5;
    // Digits occupy 0.72 of the plate height and are keyed to it, not to the
    // width, so a wide plate gets margins rather than stretched numerals.
    const scale = hh * 1.44;
    m.panel(
      ox + ux * cx * scale + vx * cy * scale + nx * lift,
      oy + uy * cx * scale + vy * cy * scale + ny * lift,
      oz + uz * cx * scale + vz * cy * scale + nz * lift,
      ux, uy, uz, vx, vy, vz,
      sw * scale, sh * scale,
      PALETTE.hullDark,
    );
  }
}

function buildTrimGroup(index: number): THREE.BufferGeometry {
  const m = new Mesher();
  const trim = PALETTE.hullTrim;
  const slot = index & 3;

  // --- livery stripes ------------------------------------------------------
  // Laid on the deck rather than modelled into it: two rows of quads offset 1 cm
  // along +Y, which is ~600x the depth-buffer resolution at racing distance and
  // therefore cannot z-fight, while costing 32 triangles.
  for (const sgn of [-1, 1]) {
    const uA = sgn * 0.42;
    const uB = sgn * 0.60;
    const rows: number[][] = [];
    for (let s = 1; s < ST_Z.length - 1; s++) {
      const z = ST_Z[s]!;
      const hb = ST_HB[s]! * ST_FLARE[s]!;
      // Ordered so cross(du, dv) is +Y on both sides: du must be -X, and the
      // stripe rings advance +Z, so the port stripe lists its outer edge first.
      const first = sgn > 0 ? uB : uA;
      const second = sgn > 0 ? uA : uB;
      rows.push([
        first * hb, deckY(s, first) + 0.010, z,
        second * hb, deckY(s, second) + 0.010, z,
      ]);
    }
    m.loft(rows, trim, false);
  }

  // --- dorsal fin ----------------------------------------------------------
  // Rings advance +Y; the profile is ordered counter-clockwise about +Y
  // (lead -> starboard -> trail -> port) so the faces point outward.
  const h = FIN_HEIGHT[slot]!;
  const sweep = FIN_SWEEP[slot]!;
  const finRings: number[][] = [];
  const finSteps = 4;
  for (let i = 0; i <= finSteps; i++) {
    const v = i / finSteps;
    const y = 0.66 + h * v;
    const zc = -1.42 - sweep * v;
    const hc = 0.34 * (1 - 0.58 * v);
    const ht = 0.030 * (1 - 0.72 * v);
    finRings.push([
      0, y, zc + hc,
      ht, y, zc,
      0, y, zc - hc,
      -ht, y, zc,
    ]);
  }
  m.loft(finRings, trim, true);
  m.fan(finRings[0]!, trim, true);
  m.fan(finRings[finSteps]!, trim, false);

  // --- bow spoiler ---------------------------------------------------------
  // Rings advance +X along the span; the profile is a four-point aerofoil loop
  // ordered counter-clockwise about +X (top -> leading -> bottom -> trailing).
  const sp = SPOILER[slot]!;
  const halfSpan = sp[0]!;
  const chord = sp[1]!;
  const tipRise = sp[2]!;
  const anhedral = sp[3]!;
  const tipSweep = sp[4]!;
  const wingRings: number[][] = [];
  const spanSteps = 6;
  for (let i = 0; i <= spanSteps; i++) {
    const u = (i / spanSteps) * 2 - 1;
    const x = u * halfSpan;
    const y = 0.93 + tipRise * u * u - anhedral * Math.abs(u);
    const zc = 1.66 - tipSweep * u * u;
    const hc = (chord * 0.5) * (1 - 0.24 * u * u);
    const ht = 0.020;
    wingRings.push([
      x, y + ht, zc,
      x, y, zc + hc,
      x, y - ht, zc,
      x, y, zc - hc,
    ]);
  }
  m.loft(wingRings, trim, true);
  m.fan(wingRings[0]!, trim, true);
  m.fan(wingRings[spanSteps]!, trim, false);
  // Two struts down onto the cowling, so the wing is carried rather than floating.
  for (const sgn of [-1, 1]) {
    m.tube([[sgn * 0.20, 0.78, 1.60], [sgn * 0.20, 0.93, 1.66]], [0.030, 0.026], 5, trim);
  }

  // --- number plates -------------------------------------------------------
  // Aft face of the engine cowl: the one the chase camera stares at all race.
  addPlate(m, slot, 0, 0.44, -1.995, -1, 0, 0, 0, 1, 0, 0.15, 0.13);
  // Both flanks, for the pack and overtake angles.
  addPlate(m, slot, 0.462, 0.53, -1.32, 0, 0, -1, 0, 1, 0, 0.15, 0.13);
  addPlate(m, slot, -0.462, 0.53, -1.32, 0, 0, 1, 0, 1, 0, 0.15, 0.13);

  return m.toGeometry('boatTrim', true);
}

// ------------------------------------------------------------------ flame ----

/**
 * The boost plume: one main jet off the transom and two smaller ones at the
 * stack outlets. Built pointing aft along -Z at unit scale so the whole thing
 * animates by scaling a single Object3D.
 */
function buildFlameGeometry(): THREE.BufferGeometry {
  const m = new Mesher();
  const hot = PALETTE.boostFlameHot;
  const cool = PALETTE.boostFlame;

  const jet = (x: number, y: number, z: number, r: number, len: number): void => {
    // Radii bulge just aft of the nozzle then taper - a plume, not a cone.
    const steps: readonly number[] = [0.00, 0.18, 0.42, 0.72, 1.00];
    const widths: readonly number[] = [1.00, 1.28, 1.05, 0.62, 0.10];
    const rings: number[][] = [];
    const sides = 8;
    for (let i = 0; i < steps.length; i++) {
      const t = steps[i]!;
      const rr = r * widths[i]!;
      const ring: number[] = [];
      for (let s = 0; s < sides; s++) {
        const th = (s / sides) * Math.PI * 2;
        // Ordered counter-clockwise about -Z, which is the plume's axis.
        ring.push(x + Math.cos(th) * rr, y + Math.sin(th) * rr, z - len * t);
      }
      rings.push(ring);
    }
    // Colour runs hot at the nozzle to cool at the tip; the ramp is per-ring, so
    // the steps land on geometry edges and stay hard.
    const tmp = new THREE.Color();
    for (let i = 0; i < rings.length; i++) {
      tmp.copy(hot).lerp(cool, i / (rings.length - 1));
      const base = m.pos.length / 3;
      const ring = rings[i]!;
      for (let s = 0; s < ring.length / 3; s++) {
        m.vertex(ring[s * 3]!, ring[s * 3 + 1]!, ring[s * 3 + 2]!, tmp);
      }
      if (i > 0) {
        const prev = base - ring.length / 3;
        for (let s = 0; s < sides; s++) {
          const j = (s + 1) % sides;
          // Rings advance -Z, so the quad order is reversed relative to a +Z loft.
          m.quad(base + s, base + j, prev + s, prev + j);
        }
      }
    }
    m.fan(rings[rings.length - 1]!, cool, true);
  };

  jet(0, -0.14, -2.06, 0.20, 1.35);
  jet(-0.21, 0.88, -1.86, 0.075, 0.52);
  jet(0.21, 0.88, -1.86, 0.075, 0.52);

  return m.toGeometry('boatFlame', true);
}

// ------------------------------------------------------------------ cache ----

/**
 * Shared geometry. Built on first use and never rebuilt: four boats and four ink
 * shells all point at these same buffers.
 */
let _hullGeo: THREE.BufferGeometry | null = null;
let _darkGeo: THREE.BufferGeometry | null = null;
let _metalGeo: THREE.BufferGeometry | null = null;
let _yokeGeo: THREE.BufferGeometry | null = null;
let _flameGeo: THREE.BufferGeometry | null = null;
const _trimGeo = new Map<number, THREE.BufferGeometry>();

/** Shared materials for every group whose colour does not vary by racer. */
let _trimMat: CelMaterial | null = null;
let _darkMat: CelMaterial | null = null;
let _metalMat: CelMaterial | null = null;

function trimMaterial(): CelMaterial {
  return (_trimMat ??= makeCelMaterial({
    ...CEL_PRESETS.hull(NEUTRAL),
    vertexColors: true,
    name: 'BoatTrim',
  }));
}

function darkMaterial(): CelMaterial {
  return (_darkMat ??= makeCelMaterial({
    ...CEL_PRESETS.hull(NEUTRAL),
    vertexColors: true,
    // The windscreen is a single open surface sharing this material with two
    // closed cowls, so both faces have to draw. On the cowls the back faces are
    // depth-rejected and cost nothing.
    side: THREE.DoubleSide,
    matcapStrength: 0.34,
    specPower: 80,
    name: 'BoatDark',
  }));
}

function metalMaterial(): CelMaterial {
  return (_metalMat ??= makeCelMaterial({ ...CEL_PRESETS.metal(PALETTE.metal), name: 'BoatMetal' }));
}

// ------------------------------------------------------------------- API -----

export interface BoatVisual {
  /** Root of the whole assembly; the caller positions this. */
  readonly root: THREE.Group;
  /** Where a rider rig parents itself. */
  readonly riderMount: THREE.Object3D;
  /** Steering column; rotated by `setSteer`. */
  readonly yokePivot: THREE.Object3D;
  /** Grip centres, for the rider's hand IK. Named `yokeHandleL` / `yokeHandleR`. */
  readonly handleLeft: THREE.Object3D;
  readonly handleRight: THREE.Object3D;
  /** Racer-coloured hull material. Owned per boat, so it is safe to modulate. */
  readonly hullMaterial: CelMaterial;
  /** Source triangle count, for the harness. */
  readonly triangles: number;

  setSteer(steer: number): void;
  /** Emissive kick on a collision, 0..1. Makes a bump read at a glance. */
  setHitFlash(v: number): void;
  /** `intensity` 0..1 ramps the plume in and out; 0 hides it entirely. */
  setBoost(intensity: number, elapsed: number): void;
  dispose(): void;
}

/**
 * Assembles one boat. Geometry comes from the shared cache, so the per-boat cost
 * is five meshes, five ink shells and two materials.
 */
export function buildBoatVisual(index: number, color: THREE.Color): BoatVisual {
  _hullGeo ??= buildHullGroup();
  _darkGeo ??= buildDarkGroup();
  _metalGeo ??= buildMetalGroup();
  _yokeGeo ??= buildYokeGeometry();
  _flameGeo ??= buildFlameGeometry();

  const slot = index & 3;
  let trimGeo = _trimGeo.get(slot);
  if (!trimGeo) { trimGeo = buildTrimGroup(slot); _trimGeo.set(slot, trimGeo); }

  const root = new THREE.Group();
  root.name = `boat${index}`;
  // Pitch about local X after yaw about Y, roll last: the vehicle convention.
  root.rotation.order = 'YXZ';

  const hullMaterial = makeCelMaterial({ ...CEL_PRESETS.hull(color), name: `BoatHull${index}` });

  const hull = new THREE.Mesh(_hullGeo, hullMaterial);
  hull.name = 'hull';
  const trim = new THREE.Mesh(trimGeo, trimMaterial());
  trim.name = 'trim';
  const dark = new THREE.Mesh(_darkGeo, darkMaterial());
  dark.name = 'dark';
  const metal = new THREE.Mesh(_metalGeo, metalMaterial());
  metal.name = 'metal';
  root.add(hull, trim, dark, metal);

  const yokePivot = new THREE.Object3D();
  yokePivot.name = 'yokePivot';
  yokePivot.position.copy(YOKE_PIVOT_LOCAL);
  root.add(yokePivot);

  const yoke = new THREE.Mesh(_yokeGeo, metalMaterial());
  yoke.name = 'yoke';
  yokePivot.add(yoke);

  // Grip targets for the rider's hand IK. Tagged as well as named: a name match
  // is a convention, and `userData.riderGrip` is a contract.
  const handleLeft = new THREE.Object3D();
  handleLeft.name = 'yokeHandleL';
  handleLeft.userData.riderGrip = 'left';
  handleLeft.position.set(-HANDLE_LOCAL_X, HANDLE_LOCAL_Y, HANDLE_LOCAL_Z);
  const handleRight = new THREE.Object3D();
  handleRight.name = 'yokeHandleR';
  handleRight.userData.riderGrip = 'right';
  handleRight.position.set(HANDLE_LOCAL_X, HANDLE_LOCAL_Y, HANDLE_LOCAL_Z);
  yokePivot.add(handleLeft, handleRight);

  const riderMount = new THREE.Object3D();
  riderMount.name = 'riderMount';
  riderMount.position.copy(SEAT_LOCAL);
  root.add(riderMount);

  // Ink before the flame is attached: the plume is a glow, and an outline round
  // it would read as a hole punched in the light.
  addOutlineRecursive(root, { thickness: 2.6 });

  const flameMaterial = makeCelMaterial({
    ...CEL_PRESETS.glow(NEUTRAL, 1.15),
    vertexColors: true,
    name: `BoatFlame${index}`,
  });
  const flame = new THREE.Mesh(_flameGeo, flameMaterial);
  flame.name = 'boostFlame';
  flame.userData.noOutline = true;
  flame.visible = false;
  flame.renderOrder = 2;
  root.add(flame);

  const triangles =
    (_hullGeo.getIndex()?.count ?? 0) / 3 +
    (trimGeo.getIndex()?.count ?? 0) / 3 +
    (_darkGeo.getIndex()?.count ?? 0) / 3 +
    (_metalGeo.getIndex()?.count ?? 0) / 3 +
    (_yokeGeo.getIndex()?.count ?? 0) / 3 +
    (_flameGeo.getIndex()?.count ?? 0) / 3;

  return {
    root,
    riderMount,
    yokePivot,
    handleLeft,
    handleRight,
    hullMaterial,
    triangles,

    setHitFlash(v: number): void {
      // Straight into the hull's own emissive term, so the flash is the racer's
      // colour going hot rather than a white wash that loses whose boat it is.
      hullMaterial.uniforms.uEmissive!.value = v * 0.55;
    },

    setSteer(steer: number): void {
      // The column yaws (right grip back on a right turn) and banks slightly with
      // it, which is what a rider's hands actually do on a jet-ski bar.
      yokePivot.rotation.y = steer * 0.30;
      yokePivot.rotation.z = -steer * 0.16;
    },

    setBoost(intensity: number, elapsed: number): void {
      if (intensity <= 0.01) { flame.visible = false; return; }
      flame.visible = true;
      // Two incommensurable rates beat against each other, so the plume never
      // settles into a visible loop. Deterministic: a pure function of elapsed.
      const flick = 0.80 + 0.20 * Math.sin(elapsed * 47.3) * Math.sin(elapsed * 29.1 + 1.7);
      const puff = 0.90 + 0.10 * Math.sin(elapsed * 71.0 + 0.6);
      flame.scale.set(
        (0.72 + 0.36 * intensity) * puff,
        (0.72 + 0.36 * intensity) * puff,
        (0.45 + 0.80 * intensity) * flick,
      );
    },

    dispose(): void {
      hullMaterial.dispose();
      flameMaterial.dispose();
    },
  };
}

/** Frees the shared caches. Only the harness needs this. */
export function disposeBoatGeometry(): void {
  for (const g of [_hullGeo, _darkGeo, _metalGeo, _yokeGeo, _flameGeo]) g?.dispose();
  for (const g of _trimGeo.values()) g.dispose();
  _trimGeo.clear();
  _hullGeo = _darkGeo = _metalGeo = _yokeGeo = _flameGeo = null;
  _trimMat?.dispose(); _darkMat?.dispose(); _metalMat?.dispose();
  _trimMat = _darkMat = _metalMat = null;
}
