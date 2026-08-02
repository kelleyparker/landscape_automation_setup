import * as THREE from 'three';
import { sampleSurface, sampleFlow, type SurfaceSample } from '../ocean/GerstnerCPU';

/**
 * Multi-point hull buoyancy.
 *
 * Six probes on the hull are sampled against the *real* Gerstner surface every
 * substep - the same evaluator the water shader is generated from, so the boat
 * floats on exactly the sea you can see. Each submerged probe pushes up in
 * proportion to how deep it is and resists the speed at which it is being pushed
 * through the water; the sum is a heave force, and the imbalance between fore and
 * aft, port and starboard, is a pitch and a roll torque.
 *
 * That imbalance is the entire point. A single height sample under the centre of
 * mass gives a boat that slides along the surface like a decal. Six give a boat
 * whose bow drops into a trough half a second before its transom does, which is
 * what the whole "fighting water" brief comes down to.
 *
 * ## Why six, and why these six
 *
 * Three points fix a plane, so three is the minimum that can produce pitch *and*
 * roll. Six is what it takes for the plane to be the *hull's*: a bow probe for
 * entry, a pair at the shoulders and a pair aft for the planing surface, and one
 * at the transom, which is the difference between a boat that squats under power
 * and one that does not. Past six the extra probes only refine a shape the eye
 * cannot read, and each one costs an inverse-map solve.
 *
 * ## Units
 *
 * Everything here is mass-normalised: forces come out as accelerations and
 * torques as angular accelerations times inertia, so the physics never carries a
 * mass term. `share` is the fraction of the hull's displacement each probe
 * carries and sums to exactly 1, which is what makes `BUOYANCY` a directly
 * meaningful number (the upward acceleration at full submersion).
 */

/** A displacement probe in hull-local space. */
interface Probe {
  x: number;
  y: number;
  z: number;
  /** Fraction of total displacement. The six sum to 1. */
  share: number;
}

/**
 * Probe layout. y values sit on the hull bottom at each station, so "depth" is
 * measured from the surface the water actually touches.
 */
const PROBES: readonly Probe[] = [
  { x: 0.00, y: -0.05, z: 1.72, share: 0.16 },   // 0 bow / entry
  { x: -0.62, y: -0.24, z: 0.30, share: 0.17 },  // 1 port shoulder
  { x: 0.62, y: -0.24, z: 0.30, share: 0.17 },   // 2 starboard shoulder
  { x: -0.66, y: -0.30, z: -1.05, share: 0.18 }, // 3 port planing pad
  { x: 0.66, y: -0.30, z: -1.05, share: 0.18 },  // 4 starboard planing pad
  { x: 0.00, y: -0.28, z: -2.02, share: 0.14 },  // 5 transom
];

export const PROBE_COUNT = PROBES.length;
export const BOW_PROBE = 0;
export const TRANSOM_PROBE = 5;

/**
 * Depth at which a probe is considered fully immersed, in metres.
 *
 * This is the hull's reserve buoyancy, not its draught: it sets how far the boat
 * can be pushed under before the restoring force stops growing. 0.40 m is a
 * little over the freeboard, so a bow that buries in a trough saturates rather
 * than being fired back out like a cork.
 */
const DRAFT = 0.40;

/**
 * Upward acceleration a fully-immersed hull generates, m/s^2.
 *
 * With `GRAVITY = 19` this settles the hull at a weighted mean immersion of
 * 19/42 = 0.45, i.e. 0.18 m - about 0.3 m of draught measured at the keel, which
 * is where the geometry in BoatMesh puts the waterline stripe. The stiffness that
 * falls out of it (`BUOYANCY / DRAFT` = 105 s^-2) gives a heave period of 0.61 s
 * and a pitch period of 0.63 s: fast enough to answer chop, slow enough that the
 * swell visibly carries the boat rather than the boat tracking the swell.
 */
const BUOYANCY = 42.0;

/**
 * Damping against the probe's vertical speed *relative to the water*.
 *
 * 9.0 puts heave at about 44% of critical and pitch at 66% (the pitch dampers sit
 * on long lever arms, so they contribute far more to that mode). Underdamped on
 * purpose: a boat that stops dead after one bob reads as a physics demo, and a
 * couple of overshoots is what makes a landing feel like a landing.
 */
const DAMP = 9.0;

/** Immersion is allowed past 1 so a deeply buried bow still gains a little push. */
const MAX_IMMERSION = 1.25;

// --------------------------------------------------------------- scratch -----
// Module scope. Nothing in `sample()` allocates.

const _surf: SurfaceSample = { height: 0, normal: new THREE.Vector3(0, 1, 0), jacobian: 1 };
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _quat = new THREE.Quaternion();
const _quatInv = new THREE.Quaternion();
const _lever = new THREE.Vector3();
const _omegaW = new THREE.Vector3();
const _bodyUp = new THREE.Vector3();
const _pointVel = new THREE.Vector3();

/** What one buoyancy evaluation tells the physics. */
export interface BuoyancyOutput {
  /** Net vertical acceleration from lift plus damping, world +Y. */
  lift: number;
  /** Body-frame torque about local X. Positive pitches the nose down. */
  pitchTorque: number;
  /** Body-frame torque about local Z. Positive lifts the starboard side. */
  rollTorque: number;
  /** How many probes are under water. Zero means airborne. */
  submerged: number;
  /** Share-weighted mean immersion, 0..1. Drives water resistance. */
  submersion: number;
  /** Immersion at the transom, 0..1. The jet makes no thrust out of the water. */
  sternWet: number;
  /** Deepest of the three aft probes, 0..1. What the jet actually feeds off. */
  aftWet: number;
  /** Immersion at the bow, 0..1. Above ~0.85 the bow is punching through. */
  bowWet: number;
  /** Surface height under the hull origin. */
  waterY: number;
  /** Water velocity under the hull origin, for the drift push. */
  flow: THREE.Vector3;
}

export function makeBuoyancyOutput(): BuoyancyOutput {
  return {
    lift: 0, pitchTorque: 0, rollTorque: 0,
    submerged: 0, submersion: 0, sternWet: 0, aftWet: 0, bowWet: 0,
    waterY: 0, flow: new THREE.Vector3(),
  };
}

/**
 * Samples the hull against the sea.
 *
 * The probes' world positions and immersions are kept on the instance so the
 * caller can hang spray emitters off them without paying for a second solve -
 * `sampleSurface` is the expensive call in the whole boat and there are six of
 * them per substep per boat.
 */
export class Buoyancy {
  /** Probe world positions, filled by `sample()`. */
  readonly worldX = new Float64Array(PROBE_COUNT);
  readonly worldY = new Float64Array(PROBE_COUNT);
  readonly worldZ = new Float64Array(PROBE_COUNT);
  /** Clamped immersion per probe, 0 when clear of the water. */
  readonly immersion = new Float64Array(PROBE_COUNT);
  /** Surface height above each probe. */
  readonly surfaceY = new Float64Array(PROBE_COUNT);

  /** Hull-local probe positions, so callers can transform them themselves. */
  static probeLocal(i: number, out: THREE.Vector3): THREE.Vector3 {
    const p = PROBES[i]!;
    return out.set(p.x, p.y, p.z);
  }

  /**
   * @param position hull origin in world space
   * @param heading  yaw, 0 = +Z
   * @param pitch    nose-down positive
   * @param roll     starboard-up positive
   * @param velocity world linear velocity of the hull origin
   * @param pitchRate/yawRate/rollRate body-frame angular rates
   * @param t        `engine.elapsed`, the wave clock
   */
  sample(
    position: THREE.Vector3,
    heading: number,
    pitch: number,
    roll: number,
    velocity: THREE.Vector3,
    pitchRate: number,
    yawRate: number,
    rollRate: number,
    t: number,
    out: BuoyancyOutput,
  ): BuoyancyOutput {
    _euler.set(pitch, heading, roll, 'YXZ');
    _quat.setFromEuler(_euler);

    // The lift acts along world +Y; expressed in the body frame it is the third
    // row of R, which is what turns a set of vertical forces into body torques.
    _quatInv.copy(_quat).invert();
    _bodyUp.set(0, 1, 0).applyQuaternion(_quatInv);

    // Angular rates are authored in the body frame (pitch about local X, roll
    // about local Z); rotating them into the world lets one cross product give
    // every probe's velocity.
    _omegaW.set(pitchRate, yawRate, rollRate).applyQuaternion(_quat);

    // One flow sample at the hull origin. Sampling it per probe would triple the
    // inverse-map cost for a term whose whole job is a gentle sideways nudge.
    sampleFlow(position.x, position.z, t, out.flow);

    let lift = 0;
    let pitchTorque = 0;
    let rollTorque = 0;
    let submerged = 0;
    let submersion = 0;
    let waterY = 0;

    for (let i = 0; i < PROBE_COUNT; i++) {
      const p = PROBES[i]!;
      _lever.set(p.x, p.y, p.z).applyQuaternion(_quat);
      const wx = position.x + _lever.x;
      const wy = position.y + _lever.y;
      const wz = position.z + _lever.z;
      this.worldX[i] = wx;
      this.worldY[i] = wy;
      this.worldZ[i] = wz;

      sampleSurface(wx, wz, t, _surf);
      this.surfaceY[i] = _surf.height;
      // Share-weighted mean of the six samples, which is a better "the sea under
      // this boat" than any one probe and costs nothing extra.
      waterY += p.share * _surf.height;

      const depth = _surf.height - wy;
      if (depth <= 0) {
        this.immersion[i] = 0;
        continue;
      }
      submerged++;
      let imm = depth / DRAFT;
      if (imm > MAX_IMMERSION) imm = MAX_IMMERSION;
      this.immersion[i] = imm > 1 ? 1 : imm;
      submersion += p.share * this.immersion[i]!;

      // v_probe = v_com + omega x r. The vertical component is all that matters:
      // the probe is a vertical spring-damper, not a full contact model.
      _pointVel.crossVectors(_omegaW, _lever);
      const vy = velocity.y + _pointVel.y - out.flow.y;

      // Lift saturates with depth; damping is gated by immersion so a probe that
      // is barely wet cannot brake the hull. Both are share-weighted, so moving a
      // probe changes where the force acts without changing how much there is.
      let f = p.share * (BUOYANCY * imm - DAMP * vy * this.immersion[i]!);
      // A probe may pull down when it is rising fast, but never more than its
      // own weight - otherwise a hard landing can suck the hull under.
      const floor = -p.share * BUOYANCY * 0.5;
      if (f < floor) f = floor;

      lift += f;

      // tau = r_body x (R^T * up) * f. Body pitch is x, body roll is z.
      pitchTorque += f * (p.y * _bodyUp.z - p.z * _bodyUp.y);
      rollTorque += f * (p.x * _bodyUp.y - p.y * _bodyUp.x);
    }

    out.lift = lift;
    out.pitchTorque = pitchTorque;
    out.rollTorque = rollTorque;
    out.submerged = submerged;
    out.submersion = submersion;
    out.sternWet = this.immersion[TRANSOM_PROBE]!;
    // The jet intake sits under the planing pad, not on the transom face, so it
    // keeps feeding as long as *any* of the aft third of the hull is wet. Gating
    // thrust on the transom probe alone starves a boat that is trimmed bow-down
    // in a trough, which is precisely when it needs the push.
    out.aftWet = Math.max(this.immersion[3]!, this.immersion[4]!, out.sternWet);
    out.bowWet = this.immersion[BOW_PROBE]!;
    out.waterY = waterY;
    return out;
  }
}
