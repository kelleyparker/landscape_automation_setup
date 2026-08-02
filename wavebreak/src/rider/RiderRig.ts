import * as THREE from 'three';
import { PALETTE } from '../core/Palette';
import { CEL_PRESETS, makeCelMaterial } from '../render/CelMaterial';

/**
 * The rider's skeleton and body, generated entirely in code.
 *
 * SPACE CONTRACT
 *   Local +Y up, +Z forward (the boat's heading is +Z at yaw 0), so the rider's
 *   right hand side is +X (right = up x forward). The origin sits *between the
 *   feet* at deck level: parent this root to `boat.riderMount` and the rider
 *   stands on it. Nothing here reads world state - the whole rig is built at the
 *   origin and bound there, so the boat can move it freely afterwards.
 *
 * WHY A REAL SKELETON
 *   A segmented rider is cheaper but the silhouette breaks at every joint the
 *   moment it crouches, and the ink line - which is generated from the *shape*,
 *   not from a texture - immediately shows the seams. One continuous skinned
 *   surface gives the inverted-hull outline a single closed loop to draw around
 *   the whole limb, which is the entire reason the character reads as drawn.
 *
 * WEIGHTS
 *   Computed here, by distance to bone *segments* (not bone origins - a point
 *   beside the middle of the thigh must belong to the thigh, not to whichever
 *   joint happens to be nearer). Each emitted patch of geometry declares the
 *   small set of bones that are allowed to influence it, which is what stops the
 *   left thigh from picking up the right thigh at the crotch. Inside that set
 *   the falloff is smooth, so joints bend without creasing.
 *
 * BUDGET
 *   ~1.3k triangles of body. The ink shell reuses the same geometry, so a rider
 *   costs roughly double that on screen. Six materials, six draw calls (twelve
 *   with ink) - the split is by lighting response, not by body part.
 */

// --------------------------------------------------------------- skeleton ---

export interface BoneSpec {
  name: string;
  parent: string | null;
  /** Rest offset from the parent bone, in parent space. All rest rotations are identity. */
  offset: readonly [number, number, number];
  /**
   * Where this bone's *segment* ends, in bone space. Skin weighting measures
   * distance to the head->tail segment, so this is the bone's "physical" extent
   * rather than just a point. Leaf bones need it most.
   */
  tail: readonly [number, number, number];
}

/**
 * 24 bones. Proportions are stylised-anime: ~6.4 heads tall at 1.58m, chunky
 * limbs, small hands and feet relative to a real figure. The rest pose is
 * upright with the arms hanging - the racing crouch is applied by the animator,
 * so the bind pose stays neutral and the skinning never starts from a deformed
 * state.
 */
export const RIDER_BONES: readonly BoneSpec[] = [
  { name: 'pelvis', parent: null, offset: [0, 0.86, 0], tail: [0, -0.09, 0] },
  { name: 'spine0', parent: 'pelvis', offset: [0, 0.10, 0], tail: [0, 0.115, 0] },
  { name: 'spine1', parent: 'spine0', offset: [0, 0.115, 0], tail: [0, 0.115, 0] },
  { name: 'spine2', parent: 'spine1', offset: [0, 0.115, 0], tail: [0, 0.10, 0] },
  // The neck is deliberately long. A short neck plus a shrug plus a forward
  // lean buries the chin in the collar, and the face is the only part of this
  // character anyone actually looks at.
  { name: 'neck', parent: 'spine2', offset: [0, 0.13, 0.005], tail: [0, 0.105, 0] },
  { name: 'head', parent: 'neck', offset: [0, 0.105, 0], tail: [0, 0.16, 0.01] },

  { name: 'clavR', parent: 'spine2', offset: [0.045, 0.075, 0.012], tail: [0.13, -0.02, 0] },
  { name: 'upperArmR', parent: 'clavR', offset: [0.135, -0.02, 0], tail: [0, -0.25, 0] },
  { name: 'foreArmR', parent: 'upperArmR', offset: [0, -0.25, 0], tail: [0, -0.243, 0] },
  { name: 'handR', parent: 'foreArmR', offset: [0, -0.243, 0], tail: [0, -0.085, 0.02] },

  { name: 'clavL', parent: 'spine2', offset: [-0.045, 0.075, 0.012], tail: [-0.13, -0.02, 0] },
  { name: 'upperArmL', parent: 'clavL', offset: [-0.135, -0.02, 0], tail: [0, -0.25, 0] },
  { name: 'foreArmL', parent: 'upperArmL', offset: [0, -0.25, 0], tail: [0, -0.243, 0] },
  { name: 'handL', parent: 'foreArmL', offset: [0, -0.243, 0], tail: [0, -0.085, 0.02] },

  { name: 'thighR', parent: 'pelvis', offset: [0.095, -0.03, 0], tail: [0, -0.42, 0] },
  { name: 'shinR', parent: 'thighR', offset: [0, -0.42, 0], tail: [0, -0.33, 0] },
  { name: 'footR', parent: 'shinR', offset: [0, -0.33, 0], tail: [0, -0.03, 0.14] },

  { name: 'thighL', parent: 'pelvis', offset: [-0.095, -0.03, 0], tail: [0, -0.42, 0] },
  { name: 'shinL', parent: 'thighL', offset: [0, -0.42, 0], tail: [0, -0.33, 0] },
  { name: 'footL', parent: 'shinL', offset: [0, -0.33, 0], tail: [0, -0.03, 0.14] },

  // Scarf: rest pose streams straight back, which is where it spends most of
  // its life at racing speed. Simulated by the animator, skinned like any limb.
  { name: 'scarf0', parent: 'neck', offset: [0, 0.02, -0.09], tail: [0, 0, -0.16] },
  { name: 'scarf1', parent: 'scarf0', offset: [0, 0, -0.16], tail: [0, 0, -0.16] },
  { name: 'scarf2', parent: 'scarf1', offset: [0, 0, -0.16], tail: [0, 0, -0.15] },
  { name: 'scarf3', parent: 'scarf2', offset: [0, 0, -0.15], tail: [0, 0, -0.15] },
] as const;

export const BONE_INDEX: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < RIDER_BONES.length; i++) m[RIDER_BONES[i]!.name] = i;
  return m;
})();

/** Rest-pose world positions of every bone head and tail (rest rotations are identity). */
const REST_HEAD: THREE.Vector3[] = [];
const REST_TAIL: THREE.Vector3[] = [];
(() => {
  for (let i = 0; i < RIDER_BONES.length; i++) {
    const b = RIDER_BONES[i]!;
    const parent = b.parent === null ? null : REST_HEAD[BONE_INDEX[b.parent]!]!;
    const head = new THREE.Vector3(b.offset[0], b.offset[1], b.offset[2]);
    if (parent) head.add(parent);
    REST_HEAD.push(head);
    REST_TAIL.push(new THREE.Vector3(b.tail[0], b.tail[1], b.tail[2]).add(head));
  }
})();

/** Rest world position of a named bone. Read-only - callers must not mutate. */
export function restHeadOf(name: string): THREE.Vector3 {
  return REST_HEAD[BONE_INDEX[name]!]!;
}

// ---------------------------------------------------------------- builder ---

const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();

/** Point-to-segment distance. Inlined maths - this runs once per vertex per bone. */
function segDist(px: number, py: number, pz: number, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = px - a.x, apy = py - a.y, apz = pz - a.z;
  const ab2 = abx * abx + aby * aby + abz * abz;
  let t = ab2 > 1e-9 ? (apx * abx + apy * aby + apz * abz) / ab2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Falloff radius in the weighting kernel, in metres.
 *
 * w = 1 / (d + EPS)^3. The cube is deliberate: it keeps mid-limb vertices
 * essentially rigid (no rubbery bend halfway down a shin) while still blending
 * 50/50 exactly at a joint, where both segments are equidistant. EPS sets how
 * wide the blend band is - 3.5cm gives roughly a 6cm crossfade around each
 * joint, which on a 25cm forearm is a believable amount of flesh.
 */
const WEIGHT_EPS = 0.035;

class SkinBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private idx: number[] = [];
  /** Per-vertex index into `sets` - the bones allowed to influence that vertex. */
  private cand: number[] = [];
  private sets: number[][] = [];
  private cur = 0;

  /** Declares which bones may influence everything emitted from here on. */
  use(names: readonly string[]): void {
    const set = names.map((n) => {
      const i = BONE_INDEX[n];
      if (i === undefined) throw new Error(`RiderRig: unknown bone ${n}`);
      return i;
    });
    this.sets.push(set);
    this.cur = this.sets.length - 1;
  }

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    const l = Math.hypot(nx, ny, nz) || 1;
    this.nrm.push(nx / l, ny / l, nz / l);
    this.cand.push(this.cur);
    return i;
  }

  private tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }
  private quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /**
   * Vertical loft: a stack of elliptical rings. Used for the torso, neck, belt
   * and collar - anything whose cross-section is an ellipse in XZ.
   */
  loft(
    rings: readonly { y: number; rx: number; rz: number; x?: number; z?: number }[],
    radial: number,
    capBottom: boolean,
    capTop: boolean,
  ): void {
    const base: number[] = [];
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i]!;
      // Ring normals need the loft's slope or the shoulders shade like a pipe.
      const prev = rings[Math.max(0, i - 1)]!;
      const next = rings[Math.min(rings.length - 1, i + 1)]!;
      const dy = next.y - prev.y;
      const slope = dy !== 0 ? (next.rx - prev.rx) / dy : 0;
      const start = this.pos.length / 3;
      for (let s = 0; s < radial; s++) {
        const a = (s / radial) * Math.PI * 2;
        const cs = Math.cos(a), sn = Math.sin(a);
        this.vert(
          (r.x ?? 0) + cs * r.rx, r.y, (r.z ?? 0) + sn * r.rz,
          cs / r.rx, -slope, sn / r.rz,
        );
      }
      base.push(start);
    }
    // Winding note: loft rings run +X toward +Z (x=cos, z=sin), so the
    // outward-facing triangle order is (this ring, next ring up, ...).
    for (let i = 0; i < rings.length - 1; i++) {
      const a = base[i]!, b = base[i + 1]!;
      for (let s = 0; s < radial; s++) {
        const s1 = (s + 1) % radial;
        this.quad(a + s, b + s, b + s1, a + s1);
      }
    }
    if (capBottom) {
      const r = rings[0]!;
      const p = this.vert((r.x ?? 0), r.y - r.rz * 0.35, (r.z ?? 0), 0, -1, 0);
      const a = base[0]!;
      for (let s = 0; s < radial; s++) this.tri(a + s, a + ((s + 1) % radial), p);
    }
    if (capTop) {
      const r = rings[rings.length - 1]!;
      const p = this.vert((r.x ?? 0), r.y + r.rz * 0.35, (r.z ?? 0), 0, 1, 0);
      const a = base[rings.length - 1]!;
      for (let s = 0; s < radial; s++) this.tri(a + s, p, a + ((s + 1) % radial));
    }
  }

  /**
   * Swept tube through a polyline with per-point radii and rounded caps.
   * The ring basis is derived once from the overall direction and reused for
   * every ring, so a slightly bent limb never twists.
   */
  tube(
    points: readonly THREE.Vector3[],
    radii: readonly number[],
    radial: number,
    capStart: number,
    capEnd: number,
  ): void {
    const n = points.length;
    _d.copy(points[n - 1]!).sub(points[0]!).normalize();
    // Reference axis must not be parallel to the sweep or the basis collapses.
    _u.set(0, 1, 0);
    if (Math.abs(_d.y) > 0.9) _u.set(0, 0, 1);
    _u.cross(_d).normalize();
    _v.copy(_d).cross(_u).normalize();

    const base: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = points[i]!;
      const r = radii[i]!;
      const iPrev = Math.max(0, i - 1), iNext = Math.min(n - 1, i + 1);
      const len = points[iNext]!.distanceTo(points[iPrev]!);
      const slope = len > 1e-6 ? (radii[iNext]! - radii[iPrev]!) / len : 0;
      const start = this.pos.length / 3;
      for (let s = 0; s < radial; s++) {
        const a = (s / radial) * Math.PI * 2;
        const cs = Math.cos(a), sn = Math.sin(a);
        const rx = _u.x * cs + _v.x * sn, ry = _u.y * cs + _v.y * sn, rz = _u.z * cs + _v.z * sn;
        // Taper correction: the normal of a cone leans against the slope.
        this.vert(
          p.x + rx * r, p.y + ry * r, p.z + rz * r,
          rx - _d.x * slope, ry - _d.y * slope, rz - _d.z * slope,
        );
      }
      base.push(start);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base[i]!, b = base[i + 1]!;
      for (let s = 0; s < radial; s++) {
        const s1 = (s + 1) % radial;
        this.quad(a + s, a + s1, b + s1, b + s);
      }
    }
    if (capStart > 0) this.cap(points[0]!, radii[0]!, radial, -1, capStart, base[0]!);
    if (capEnd > 0) this.cap(points[n - 1]!, radii[n - 1]!, radial, 1, capEnd, base[n - 1]!);
  }

  /** Two-ring hemispherical cap. `squash` < 1 flattens it (shoulders, hips). */
  private cap(p: THREE.Vector3, r: number, radial: number, sign: number, squash: number, ring: number): void {
    const RINGS = 2;
    let prev = ring;
    for (let j = 1; j <= RINGS; j++) {
      const a = (j / (RINGS + 1)) * Math.PI * 0.5;
      const cr = Math.cos(a), sr = Math.sin(a);
      const start = this.pos.length / 3;
      for (let s = 0; s < radial; s++) {
        const th = (s / radial) * Math.PI * 2;
        const cs = Math.cos(th), sn = Math.sin(th);
        const rx = _u.x * cs + _v.x * sn, ry = _u.y * cs + _v.y * sn, rz = _u.z * cs + _v.z * sn;
        this.vert(
          p.x + rx * r * cr + _d.x * sign * r * sr * squash,
          p.y + ry * r * cr + _d.y * sign * r * sr * squash,
          p.z + rz * r * cr + _d.z * sign * r * sr * squash,
          rx * cr + _d.x * sign * sr, ry * cr + _d.y * sign * sr, rz * cr + _d.z * sign * sr,
        );
      }
      for (let s = 0; s < radial; s++) {
        const s1 = (s + 1) % radial;
        if (sign > 0) this.quad(prev + s, prev + s1, start + s1, start + s);
        else this.quad(prev + s, start + s, start + s1, prev + s1);
      }
      prev = start;
    }
    const pole = this.vert(
      p.x + _d.x * sign * r * squash, p.y + _d.y * sign * r * squash, p.z + _d.z * sign * r * squash,
      _d.x * sign, _d.y * sign, _d.z * sign,
    );
    for (let s = 0; s < radial; s++) {
      const s1 = (s + 1) % radial;
      if (sign > 0) this.tri(prev + s, prev + s1, pole);
      else this.tri(prev + s1, prev + s, pole);
    }
  }

  /**
   * Ellipsoid patch. `phi` runs 0 (+Y pole) to PI, `theta` runs from +Z toward
   * +X, so a theta range centred on 0 faces forward. Partial ranges give the
   * helmet its face opening and the visor its curved band without any CSG.
   */
  sphere(
    cx: number, cy: number, cz: number,
    rx: number, ry: number, rz: number,
    radial: number, ringCount: number,
    phi0 = 0, phi1 = Math.PI, th0 = 0, th1 = Math.PI * 2,
  ): void {
    const wrap = th1 - th0 >= Math.PI * 2 - 1e-6;
    const cols = wrap ? radial : radial + 1;
    const base: number[] = [];
    for (let i = 0; i <= ringCount; i++) {
      const phi = phi0 + (phi1 - phi0) * (i / ringCount);
      const sp = Math.sin(phi), cp = Math.cos(phi);
      const start = this.pos.length / 3;
      for (let s = 0; s < cols; s++) {
        const th = th0 + (th1 - th0) * (s / radial);
        const st = Math.sin(th), ct = Math.cos(th);
        this.vert(
          cx + rx * sp * st, cy + ry * cp, cz + rz * sp * ct,
          (sp * st) / rx, cp / ry, (sp * ct) / rz,
        );
      }
      base.push(start);
    }
    for (let i = 0; i < ringCount; i++) {
      const a = base[i]!, b = base[i + 1]!;
      for (let s = 0; s < radial; s++) {
        const s1 = wrap ? (s + 1) % radial : s + 1;
        // Collapse the degenerate band at a pole into triangles rather than
        // emitting zero-area quads that the smooth-normal pass has to guess at.
        if (i === 0 && Math.abs(phi0) < 1e-4) this.tri(a + s, b + s, b + s1);
        else if (i === ringCount - 1 && Math.abs(phi1 - Math.PI) < 1e-4) this.tri(a + s, b + s, a + s1);
        else this.quad(a + s, b + s, b + s1, a + s1);
      }
    }
  }

  /** Axis-aligned box with an optional front taper (boots, gloves, panels). */
  box(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    taperFront = 1, taperTop = 1,
  ): void {
    // 8 corners; front (+Z) face can be narrowed and the top scaled.
    const fx = hx * taperFront, fy = hy * taperFront;
    const c: number[][] = [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy * taperTop, -hz], [-hx, hy * taperTop, -hz],
      [-fx, -fy, hz], [fx, -fy, hz], [fx, fy * taperTop, hz], [-fx, fy * taperTop, hz],
    ];
    const faces: [number, number, number, number, number, number, number][] = [
      [4, 5, 6, 7, 0, 0, 1], [1, 0, 3, 2, 0, 0, -1],
      [5, 1, 2, 6, 1, 0, 0], [0, 4, 7, 3, -1, 0, 0],
      [3, 7, 6, 2, 0, 1, 0], [4, 0, 1, 5, 0, -1, 0],
    ];
    for (const f of faces) {
      const ids: number[] = [];
      for (let k = 0; k < 4; k++) {
        const p = c[f[k]!]!;
        ids.push(this.vert(cx + p[0]!, cy + p[1]!, cz + p[2]!, f[4]!, f[5]!, f[6]!));
      }
      this.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
    }
  }

  /**
   * Flat ribbon with thickness, swept along a polyline. The scarf. Width tapers
   * so the trailing end can flick without looking like a plank.
   */
  ribbon(
    points: readonly THREE.Vector3[],
    halfW: readonly number[],
    halfT: number,
    roll: readonly number[],
  ): void {
    const base: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const w = halfW[i]!;
      // Rolling the cross-section along the length is what stops a ribbon from
      // reading as a plank: with no twist it presents an edge from the side and
      // the scarf turns into a stick.
      const r = roll[i]!;
      const ux = Math.cos(r) * w, uy = Math.sin(r) * w;
      const vx = -Math.sin(r) * halfT, vy = Math.cos(r) * halfT;
      // Corner normals lean outward rather than straight along the thickness:
      // the ribbon is only 2cm thick, and a purely face-on normal would leave
      // the inverted hull nothing to push sideways - no ink on the long edges.
      const nx = Math.cos(r), ny = Math.sin(r);
      const mx = -Math.sin(r), my = Math.cos(r);
      const start = this.pos.length / 3;
      // Cross-section corners: left-top, right-top, right-bottom, left-bottom.
      this.vert(p.x - ux + vx, p.y - uy + vy, p.z, -0.5 * nx + 0.87 * mx, -0.5 * ny + 0.87 * my, 0);
      this.vert(p.x + ux + vx, p.y + uy + vy, p.z, 0.5 * nx + 0.87 * mx, 0.5 * ny + 0.87 * my, 0);
      this.vert(p.x + ux - vx, p.y + uy - vy, p.z, 0.5 * nx - 0.87 * mx, 0.5 * ny - 0.87 * my, 0);
      this.vert(p.x - ux - vx, p.y - uy - vy, p.z, -0.5 * nx - 0.87 * mx, -0.5 * ny - 0.87 * my, 0);
      base.push(start);
    }
    for (let i = 0; i < points.length - 1; i++) {
      const a = base[i]!, b = base[i + 1]!;
      for (let k = 0; k < 4; k++) {
        const k1 = (k + 1) % 4;
        this.quad(a + k, a + k1, b + k1, b + k);
      }
    }
    // Close both ends so the inverted hull has a solid to walk around.
    const f = base[0]!, l = base[points.length - 1]!;
    this.quad(f + 3, f + 2, f + 1, f);
    this.quad(l, l + 1, l + 2, l + 3);
  }

  /** Bakes positions, normals and the computed skin binding into a geometry. */
  build(name: string): THREE.BufferGeometry {
    const count = this.pos.length / 3;
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);

    const bi = [0, 0, 0, 0];
    const bw = [0, 0, 0, 0];
    for (let i = 0; i < count; i++) {
      const px = this.pos[i * 3]!, py = this.pos[i * 3 + 1]!, pz = this.pos[i * 3 + 2]!;
      const set = this.sets[this.cand[i]!]!;
      bi[0] = bi[1] = bi[2] = bi[3] = 0;
      bw[0] = bw[1] = bw[2] = bw[3] = 0;
      for (let k = 0; k < set.length; k++) {
        const b = set[k]!;
        const d = segDist(px, py, pz, REST_HEAD[b]!, REST_TAIL[b]!);
        const inv = 1 / (d + WEIGHT_EPS);
        const w = inv * inv * inv;
        // Insertion sort into the top-4 slots; 4 influences is the shader's limit.
        for (let s = 0; s < 4; s++) {
          if (w > bw[s]!) {
            for (let m = 3; m > s; m--) { bw[m] = bw[m - 1]!; bi[m] = bi[m - 1]!; }
            bw[s] = w; bi[s] = b;
            break;
          }
        }
      }
      const sum = bw[0]! + bw[1]! + bw[2]! + bw[3]!;
      const inv = sum > 0 ? 1 / sum : 0;
      for (let s = 0; s < 4; s++) {
        skinIndex[i * 4 + s] = bi[s]!;
        skinWeight[i * 4 + s] = bw[s]! * inv;
      }
    }

    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    // The bind pose is not the widest pose: a punched arm or a whipping scarf
    // leaves the bind-pose sphere. Inflate rather than disabling culling.
    if (g.boundingSphere) g.boundingSphere.radius *= 1.75;
    return g;
  }
}

// ------------------------------------------------------------- body parts ---

const R_LIMB = 8;   // radial segments on limbs - enough for a clean ink silhouette
const R_TORSO = 8;

function armPoints(side: number): THREE.Vector3[] {
  const sh = restHeadOf(side > 0 ? 'upperArmR' : 'upperArmL');
  const el = restHeadOf(side > 0 ? 'foreArmR' : 'foreArmL');
  const wr = restHeadOf(side > 0 ? 'handR' : 'handL');
  return [sh, el, wr];
}

function legPoints(side: number): THREE.Vector3[] {
  const hip = restHeadOf(side > 0 ? 'thighR' : 'thighL');
  const kn = restHeadOf(side > 0 ? 'shinR' : 'shinL');
  const an = restHeadOf(side > 0 ? 'footR' : 'footL');
  return [hip, kn, an];
}

/** Suit shell: torso, upper arms, thighs. Racer colour, matte cloth. */
function buildSuit(): THREE.BufferGeometry {
  const b = new SkinBuilder();

  b.use(['pelvis', 'spine0', 'spine1', 'spine2', 'neck', 'clavL', 'clavR']);
  b.loft(
    [
      { y: 0.795, rx: 0.126, rz: 0.096 }, // seat
      { y: 0.885, rx: 0.142, rz: 0.106 }, // hips
      { y: 0.985, rx: 0.122, rz: 0.093 }, // waist - pinched so the ink reads a shape
      { y: 1.090, rx: 0.150, rz: 0.109 }, // ribs
      { y: 1.185, rx: 0.170, rz: 0.114 }, // chest
      { y: 1.255, rx: 0.152, rz: 0.100 }, // shoulder yoke
      { y: 1.300, rx: 0.086, rz: 0.076 }, // neck base
    ],
    R_TORSO, true, true,
  );

  // Whole arm, shoulder to wrist, in the racer colour. The forearm was dark at
  // first and the arm merged with the glove into one black slab against the
  // sea - the suit needs to run all the way down so the ink can describe an
  // elbow.
  for (const side of [1, -1]) {
    const p = armPoints(side);
    const sh = p[0]!, el = p[1]!, wr = p[2]!;
    const S = side > 0 ? 'R' : 'L';
    b.use([`clav${S}`, `upperArm${S}`, `foreArm${S}`, 'spine2']);
    _t.copy(sh).lerp(el, 0.4);
    b.tube([sh, _t.clone(), el], [0.062, 0.066, 0.050], R_LIMB, 0.85, 0.5);
    b.use([`upperArm${S}`, `foreArm${S}`, `hand${S}`]);
    b.tube([el, wr], [0.049, 0.040], R_LIMB, 0.4, 0.35);
  }

  for (const side of [1, -1]) {
    const p = legPoints(side);
    const hip = p[0]!, kn = p[1]!;
    b.use(['pelvis', side > 0 ? 'thighR' : 'thighL', side > 0 ? 'shinR' : 'shinL']);
    _t.copy(hip).lerp(kn, 0.45);
    b.tube([hip, _t.clone(), kn], [0.104, 0.106, 0.080], R_LIMB, 0.6, 0.45);
  }

  return b.build('rider_suit');
}

/**
 * Dark gear: everything that is not the suit's field colour. Panels, sleeves,
 * gloves, boots, pads, and the hair - deep indigo hair sits in the same value
 * family as the gear, which is what keeps the head from reading as two objects.
 */
function buildGear(): THREE.BufferGeometry {
  const b = new SkinBuilder();

  // Belt, standing a little proud of the waist.
  b.use(['pelvis', 'spine0']);
  b.loft([{ y: 0.935, rx: 0.131, rz: 0.100 }, { y: 0.995, rx: 0.132, rz: 0.101 }], R_TORSO, false, false);

  // Chest panel - the suit's dark bib. A tall narrow strip rather than a wide
  // rectangle: a wide one reads as a hole punched in the chest.
  b.use(['spine1', 'spine2']);
  b.box(0, 1.150, 0.103, 0.055, 0.082, 0.018, 0.8, 0.85);

  // Collar.
  b.use(['neck', 'spine2']);
  b.loft([{ y: 1.283, rx: 0.093, rz: 0.083 }, { y: 1.345, rx: 0.084, rz: 0.075 }], R_TORSO, false, false);

  for (const side of [1, -1]) {
    const wr = armPoints(side)[2]!;
    const S = side > 0 ? 'R' : 'L';
    // Glove: a rounded mitt centred on the grip, not a brick hanging off the
    // wrist. The IK targets the wrist, so the ball has to sit where the hand
    // closes around the bar.
    b.use([`foreArm${S}`, `hand${S}`]);
    b.sphere(wr.x, wr.y - 0.040, wr.z + 0.012, 0.045, 0.052, 0.043, 6, 4);
  }

  for (const side of [1, -1]) {
    const p = legPoints(side);
    const kn = p[1]!, an = p[2]!;
    const S = side > 0 ? 'R' : 'L';
    b.use([`thigh${S}`, `shin${S}`, `foot${S}`]);
    b.tube([kn, an], [0.080, 0.058], R_LIMB, 0.5, 0.35);
    // Knee pad - reads as armour and gives the knee a hard highlight when bent.
    b.use([`thigh${S}`, `shin${S}`]);
    b.sphere(kn.x, kn.y, kn.z + 0.048, 0.060, 0.070, 0.048, 6, 3);
    // Boot.
    b.use([`shin${S}`, `foot${S}`]);
    b.box(an.x, an.y - 0.035, an.z + 0.032, 0.062, 0.046, 0.108, 0.72, 1);
  }

  // Hair: a nape mass under the helmet rim plus two short side locks. Enough to
  // stop the helmet reading as a bald sphere from behind.
  const hd = restHeadOf('head');
  b.use(['head']);
  b.sphere(hd.x, hd.y + 0.035, hd.z - 0.052, 0.098, 0.092, 0.080, 6, 3);
  for (const side of [1, -1]) {
    b.use(['head']);
    b.box(hd.x + side * 0.088, hd.y - 0.012, hd.z + 0.012, 0.022, 0.062, 0.058, 0.7, 0.8);
  }

  return b.build('rider_gear');
}

/** Skin: head and neck only - the hands are gloved and the arms are sleeved. */
function buildSkin(): THREE.BufferGeometry {
  const b = new SkinBuilder();
  const hd = restHeadOf('head');

  // Neck column, from inside the collar up into the jaw. Derived from the bone
  // positions so it cannot drift out of sync if the proportions are retuned.
  const nk = restHeadOf('neck');
  b.use(['neck', 'head', 'spine2']);
  b.loft([{ y: nk.y - 0.055, rx: 0.053, rz: 0.050 }, { y: hd.y - 0.020, rx: 0.050, rz: 0.047 }], 6, false, false);

  // Head: an egg, slightly narrowed at the chin. Anime skulls are wide at the
  // cranium and taper fast below the cheekbone, which is what the ry/rz scaling
  // and the extra ring density in the lower half are doing.
  b.use(['head', 'neck']);
  b.sphere(hd.x, hd.y + 0.062, hd.z + 0.008, 0.104, 0.124, 0.108, R_TORSO, 6);
  // Chin/jaw wedge: pushes the silhouette forward under the visor.
  b.use(['head']);
  b.box(hd.x, hd.y - 0.018, hd.z + 0.062, 0.048, 0.036, 0.036, 0.6, 0.9);

  return b.build('rider_skin');
}

/** Helmet: a shell with a face opening, built as two spherical patches. */
function buildHelmet(): THREE.BufferGeometry {
  const b = new SkinBuilder();
  const hd = restHeadOf('head');
  const cy = hd.y + 0.062;
  b.use(['head']);
  // Back and sides: everything except a 104 degree wedge at the front.
  b.sphere(hd.x, cy, hd.z + 0.004, 0.130, 0.144, 0.134, 8, 5,
    0, Math.PI * 0.63, THREE.MathUtils.degToRad(52), THREE.MathUtils.degToRad(308));
  // Brow: caps the front above the visor line.
  b.sphere(hd.x, cy, hd.z + 0.004, 0.130, 0.144, 0.134, 4, 2,
    0, Math.PI * 0.27, THREE.MathUtils.degToRad(-52), THREE.MathUtils.degToRad(52));
  // Crest fin - a hard shape along the crown so the head is not a smooth blob.
  b.box(hd.x, cy + 0.128, hd.z + 0.012, 0.016, 0.030, 0.090, 0.5, 0.7);
  return b.build('rider_helmet');
}

/** Visor: a curved band across the face opening. */
function buildVisor(): THREE.BufferGeometry {
  const b = new SkinBuilder();
  const hd = restHeadOf('head');
  b.use(['head']);
  b.sphere(hd.x, hd.y + 0.062, hd.z + 0.004, 0.134, 0.148, 0.138, 6, 3,
    Math.PI * 0.26, Math.PI * 0.60, THREE.MathUtils.degToRad(-54), THREE.MathUtils.degToRad(54));
  return b.build('rider_visor');
}

/** Scarf ribbon, skinned to the four scarf bones. */
function buildScarf(): THREE.BufferGeometry {
  const b = new SkinBuilder();
  b.use(['neck', 'scarf0', 'scarf1', 'scarf2', 'scarf3']);
  const pts: THREE.Vector3[] = [];
  const w: number[] = [];
  const roll: number[] = [];
  const chain = ['scarf0', 'scarf1', 'scarf2', 'scarf3'];
  // Start at the nape, then one ring per bone head, then the final tail. Width
  // tapers hard and the twist accumulates toward the tip, so the trailing end
  // catches light on a different plane from the root.
  const WIDTH = [0.062, 0.060, 0.053, 0.043, 0.030, 0.022];
  const ROLL = [0, 0.12, 0.42, 0.85, 1.25, 1.55];
  pts.push(new THREE.Vector3(0, restHeadOf('scarf0').y - 0.01, restHeadOf('scarf0').z + 0.055));
  for (const n of chain) pts.push(restHeadOf(n).clone());
  const last = restHeadOf('scarf3');
  pts.push(new THREE.Vector3(last.x, last.y, last.z - 0.15));
  for (let i = 0; i < pts.length; i++) { w.push(WIDTH[i]!); roll.push(ROLL[i]!); }
  b.ribbon(pts, w, 0.009, roll);
  return b.build('rider_scarf');
}

// ---------------------------------------------------------------- template --

interface RiderTemplate {
  suit: THREE.BufferGeometry;
  gear: THREE.BufferGeometry;
  skin: THREE.BufferGeometry;
  helmet: THREE.BufferGeometry;
  visor: THREE.BufferGeometry;
  scarf: THREE.BufferGeometry;
  triangles: number;
}

let TEMPLATE: RiderTemplate | null = null;

/**
 * Builds the shared geometry once. Four riders reference the same six
 * BufferGeometries - only the skeleton and the materials are per-rider.
 */
export function riderTemplate(): RiderTemplate {
  if (TEMPLATE) return TEMPLATE;
  const suit = buildSuit();
  const gear = buildGear();
  const skin = buildSkin();
  const helmet = buildHelmet();
  const visor = buildVisor();
  const scarf = buildScarf();
  let tris = 0;
  for (const g of [suit, gear, skin, helmet, visor, scarf]) tris += (g.getIndex()?.count ?? 0) / 3;
  TEMPLATE = { suit, gear, skin, helmet, visor, scarf, triangles: tris };
  return TEMPLATE;
}

// -------------------------------------------------------------- instancing --

export interface RiderRigOptions {
  /** Field colour of the suit and (usually) the helmet. */
  suitColor: THREE.Color;
  helmetColor: THREE.Color;
  skinTone: THREE.Color;
  scarfColor: THREE.Color;
}

export interface RiderRig {
  root: THREE.Object3D;
  bones: THREE.Bone[];
  byName: Record<string, THREE.Bone>;
  skeleton: THREE.Skeleton;
  meshes: THREE.SkinnedMesh[];
  materials: THREE.Material[];
  triangles: number;
}

/**
 * Clones the bone hierarchy, binds the shared geometry to it and returns a
 * ready-to-animate rig. The caller parents `root` wherever the rider belongs.
 */
export function buildRiderRig(opts: RiderRigOptions): RiderRig {
  const root = new THREE.Object3D();
  root.name = 'rider';

  const bones: THREE.Bone[] = [];
  const byName: Record<string, THREE.Bone> = {};
  for (const spec of RIDER_BONES) {
    const bone = new THREE.Bone();
    bone.name = spec.name;
    bone.position.set(spec.offset[0], spec.offset[1], spec.offset[2]);
    bones.push(bone);
    byName[spec.name] = bone;
    if (spec.parent === null) root.add(bone);
    else byName[spec.parent]!.add(bone);
  }

  const tpl = riderTemplate();
  const materials: THREE.Material[] = [];
  const meshes: THREE.SkinnedMesh[] = [];

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string): void => {
    const m = new THREE.SkinnedMesh(geo, mat);
    m.name = name;
    m.castShadow = false;
    m.receiveShadow = false;
    root.add(m);
    meshes.push(m);
    materials.push(mat);
  };

  add(tpl.suit, makeCelMaterial({ ...CEL_PRESETS.cloth(opts.suitColor), name: 'RiderSuit' }), 'rider_suit');
  add(tpl.gear, makeCelMaterial({ ...CEL_PRESETS.cloth(PALETTE.suitDark), name: 'RiderGear' }), 'rider_gear');
  add(tpl.skin, makeCelMaterial({ ...CEL_PRESETS.skin(opts.skinTone), name: 'RiderSkin' }), 'rider_skin');
  add(tpl.helmet, makeCelMaterial({ ...CEL_PRESETS.hull(opts.helmetColor), name: 'RiderHelmet' }), 'rider_helmet');
  add(tpl.visor, makeCelMaterial({ ...CEL_PRESETS.glow(PALETTE.visor, 0.35), name: 'RiderVisor' }), 'rider_visor');
  add(tpl.scarf, makeCelMaterial({ ...CEL_PRESETS.cloth(opts.scarfColor), name: 'RiderScarf' }), 'rider_scarf');

  // Bind at the origin: the root is not parented yet, so every bind matrix is
  // identity and the rig can be attached to a moving boat afterwards without
  // the skinning picking up the boat's transform twice.
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  for (const m of meshes) m.bind(skeleton);

  return { root, bones, byName, skeleton, meshes, materials, triangles: tpl.triangles };
}
