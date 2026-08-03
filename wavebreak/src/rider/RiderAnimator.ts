import * as THREE from 'three';
import type { BoatState } from '../core/types';
import type { Rng } from '../core/Rng';
import { restHeadOf, SCARF_BONES, SCARF_TAIL, type RiderRig } from './RiderRig';

/**
 * Procedural rider animation. There is not a single keyframe in here - every
 * pose is derived from the boat's published state, and every transition goes
 * through a damped spring so nothing ever snaps.
 *
 * The design rule throughout: the rider is a *mass* sitting on top of a machine
 * that is being thrown around. Whenever the boat does something, the rider does
 * slightly less of it, slightly later, and then overshoots on the way back. That
 * lag is the whole difference between a character and a prop bolted to the deck.
 *
 * Reads (all from `BoatState`): heave, pitch, roll, speed, speed01, slip,
 * drifting, airborne, airTime, landingImpact, heading. `steer` is used when the
 * boat publishes it and is otherwise reconstructed from the yaw rate, so this
 * file has no hard dependency on anything outside the shared interface.
 */

// --------------------------------------------------------------- helpers ----

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Shortest signed angular difference, radians. */
function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Damped spring, integrated implicitly so it is unconditionally stable at any
 * frame time - an explicit spring at 15Hz would explode on a hitching frame,
 * and this rig runs several dozen of them.
 *
 * `freq` is the undamped angular frequency (rad/s): ~8 is a lazy body sway,
 * ~20 is a snappy head turn. `damp` 1.0 is critical (no overshoot); below 1
 * gives the follow-through that sells weight.
 */
class Spring {
  value: number;
  vel = 0;

  constructor(v = 0) { this.value = v; }

  step(target: number, dt: number, freq: number, damp = 1): number {
    const w = freq;
    const denom = 1 + 2 * damp * dt * w + w * w * dt * dt;
    this.vel = (this.vel - w * w * dt * (this.value - target)) / denom;
    this.value += this.vel * dt;
    return this.value;
  }

  /** Velocity impulse - used for impacts, which are events, not targets. */
  kick(v: number): void { this.vel += v; }

  reset(v: number): void { this.value = v; this.vel = 0; }
}

/**
 * One fist-pump cycle, 0..1 in, 0..1 out.
 *
 * Timed like an animator would key it: 120ms of snap out (ease-out, so the
 * fastest part is the start), a fifth of a second held at the top with a small
 * settle wobble, a slower ease-in fall, then a beat of nothing before the next
 * one. Equal-length phases are what make procedural loops read as robotic.
 */
function pumpCurve(u: number): number {
  if (u < 0.12) { const k = u / 0.12; return 1 - (1 - k) * (1 - k); }
  if (u < 0.34) { const k = (u - 0.12) / 0.22; return 1 + 0.055 * Math.sin(k * Math.PI * 3) * (1 - k); }
  if (u < 0.60) { const k = (u - 0.34) / 0.26; return 1 - k * k; }
  return 0;
}

// ------------------------------------------------------------- scratch ------
// Module scope: update() must not allocate.

const _sh = new THREE.Vector3();
const _tg = new THREE.Vector3();
const _dv = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _wrist = new THREE.Vector3();
const _fore = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _grip = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _axis = new THREE.Vector3(0, 0.93, -0.37).normalize();
const _qp = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _qu = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _qroot = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _restUp = new THREE.Vector3(0, -1, 0);
const _restBack = new THREE.Vector3(0, 0, -1);

interface ArmChain {
  clav: THREE.Bone;
  upper: THREE.Bone;
  fore: THREE.Bone;
  hand: THREE.Bone;
  l1: number;
  l2: number;
  /** +1 right, -1 left. */
  side: number;
  /** Yoke handle found on the boat, or null while we fall back. */
  handle: THREE.Object3D | null;
  /** Rider-local grip position used when the boat exposes no yoke. */
  fx: number; fy: number; fz: number;
}

interface LegChain {
  thigh: THREE.Bone;
  shin: THREE.Bone;
  foot: THREE.Bone;
  side: number;
}

// ------------------------------------------------------- stance constants ---
// Bone lengths the pelvis solve needs. Mirrored from RIDER_BONES; read off the
// rig at construction so they can never drift apart.
const HIP_DROP = 0.03;

/**
 * How the torso fold is shared out: pelvis, then the three spine bones. The
 * pelvis share is needed by the leg solve as well as by the spine, so it lives
 * here rather than inside update().
 */
const SPINE_W: readonly number[] = [0.30, 0.22, 0.24, 0.24];

/**
 * Where the ankle bone sits when the boot sole is on the deck. The boot box
 * hangs 0.038 + 0.048 below the ankle, plus a couple of millimetres of ink.
 */
const FOOT_PLANE_Y = 0.088;
/** Feet planted a little behind the rig origin, so the hips can sit back over them. */
const FOOT_PLANE_Z = -0.015;

/**
 * THE ASYMMETRY BUDGET.
 *
 * A rider seen from behind, standing square, is a prop - it does not matter how
 * good the crouch is. These are *constant* offsets applied on top of everything
 * the physics drives, because the physics is near zero on a straight and that is
 * exactly where the frames were being captured. One shoulder down, spine wound a
 * few degrees off axis, head turned toward the next corner. Mirrored per racer
 * so the grid does not all lean the same way.
 */
const STANCE_TWIST = 0.15;    // rad of constant spine wind
const STANCE_LEAN = 0.075;    // rad of constant body roll
const STANCE_DROP = 0.105;    // rad of shoulder-line tilt
const STANCE_LOOK = 0.30;     // rad of constant head yaw off the boat's axis

export class RiderAnimator {
  private readonly rig: RiderRig;
  private readonly arms: ArmChain[] = [];
  private readonly legs: LegChain[] = [];

  private readonly pelvis: THREE.Bone;
  private readonly spine: THREE.Bone[] = [];
  private readonly neck: THREE.Bone;
  private readonly head: THREE.Bone;
  private readonly scarfBones: THREE.Bone[] = [];

  // --- pose springs --------------------------------------------------------
  private readonly sSteer = new Spring();
  private readonly sLean = new Spring();
  private readonly sTwist = new Spring();
  private readonly sPitch = new Spring();
  private readonly sCrouch = new Spring(0.35);
  private readonly sLand = new Spring();
  private readonly sAir = new Spring();
  private readonly sDrift = new Spring();
  private readonly sHeadYaw = new Spring();
  private readonly sHeadPitch = new Spring();
  private readonly sHeave = new Spring();
  private readonly sCeleb = new Spring();
  private readonly sCelebBody = new Spring();
  private readonly sShrug = new Spring();
  private readonly sBoost = new Spring();

  // --- differentiated signals ---------------------------------------------
  private prevHeading = 0;
  private prevSpeed = 0;
  private prevRoll = 0;
  private accelLp = 0;
  private rollRateLp = 0;
  private started = false;

  // --- celebration ---------------------------------------------------------
  private celebT = 0;

  // --- scarf verlet --------------------------------------------------------
  private readonly sCur: THREE.Vector3[] = [];
  private readonly sPrev: THREE.Vector3[] = [];
  private readonly sLen: number[] = [];
  private scarfReady = false;
  private readonly flutterPhase: number;

  // --- yoke discovery ------------------------------------------------------
  private searchCooldown = 0;
  private searchTries = 0;

  /** Small per-rider offsets so four riders never move in lockstep. */
  private readonly bias: number;
  /** Which way this rider's stance is broken: +1 or -1. Deterministic per slot. */
  private readonly stance: number;
  /** Thigh and shin lengths, read off the rig so the pelvis solve cannot disagree. */
  private readonly thighLen: number;
  private readonly shinLen: number;

  constructor(rig: RiderRig, rng: Rng, index: number) {
    this.rig = rig;
    const b = rig.byName;
    this.pelvis = b['pelvis']!;
    this.spine.push(b['spine0']!, b['spine1']!, b['spine2']!);
    this.neck = b['neck']!;
    this.head = b['head']!;

    for (const side of [1, -1]) {
      const S = side > 0 ? 'R' : 'L';
      const upper = b[`upperArm${S}`]!;
      const fore = b[`foreArm${S}`]!;
      const hand = b[`hand${S}`]!;
      this.arms.push({
        clav: b[`clav${S}`]!,
        upper, fore, hand,
        // Segment lengths come straight off the rest offsets - the IK can never
        // disagree with the geometry it is driving.
        l1: fore.position.length(),
        l2: hand.position.length(),
        side,
        handle: null,
        // Fallback bar, in rig-local space, for a boat that exposes no yoke.
        // These are the shipped hull's grips measured from `riderMount`:
        // BoatMesh puts them at (+/-0.26, 1.02, 0.56) in boat space with the
        // mount at (0, 0.21, 0.06), and the rig root sits on the mount with no
        // offset of its own. Keep the three numbers in step with that block.
        fx: side * 0.26, fy: 0.81, fz: 0.50,
      });
      this.legs.push({ thigh: b[`thigh${S}`]!, shin: b[`shin${S}`]!, foot: b[`foot${S}`]!, side });
    }

    this.thighLen = this.legs[0]!.shin.position.length();
    this.shinLen = this.legs[0]!.foot.position.length();

    for (const n of SCARF_BONES) this.scarfBones.push(b[n]!);
    // One free point per link past the root, plus the tail tip.
    let prev = restHeadOf(SCARF_BONES[0]!);
    for (let i = 1; i < SCARF_BONES.length; i++) {
      const p = restHeadOf(SCARF_BONES[i]!);
      this.sLen.push(p.distanceTo(prev));
      this.sCur.push(p.clone());
      this.sPrev.push(p.clone());
      prev = p;
    }
    const tailEnd = restHeadOf(SCARF_BONES[SCARF_BONES.length - 1]!)
      .clone().add(_tmp.set(0, 0, -SCARF_TAIL));
    this.sLen.push(tailEnd.distanceTo(prev));
    this.sCur.push(tailEnd.clone());
    this.sPrev.push(tailEnd.clone());

    this.flutterPhase = rng.range(0, Math.PI * 2) + index * 1.7;
    this.bias = rng.range(-1, 1);
    this.stance = index % 2 === 0 ? 1 : -1;
  }

  /** Explicit wiring, if the integration layer would rather not rely on names. */
  setYoke(left: THREE.Object3D | null, right: THREE.Object3D | null): void {
    for (const a of this.arms) a.handle = a.side > 0 ? right : left;
    this.searchTries = 999;
  }

  // ------------------------------------------------------------- the tick --

  update(dt: number, elapsed: number, state: BoatState, phase: string): void {
    // dt === 0 means "redraw, do not advance time" - a paused frame, or the
    // harness's frozen mode. The clamp below has a lower bound for numerical
    // stability, so without this guard a zero-length frame still integrates a
    // full 1/240 step and the rider keeps moving while the world is stopped.
    //
    // That is exactly what tools/sequence.mjs --mode frozen caught: with the
    // sim halted and the camera pinned, the only pixels still changing in the
    // whole image were the riders' heads and scarves. It matters beyond the
    // assertion - on a paused game the scarf would carry on fluttering.
    // Returning early is correct: every bone keeps the transform it was last
    // posed with, which is what a frozen frame should show.
    if (dt <= 0) return;

    // Clamp before anything differentiates or integrates: one 250ms hitch must
    // not turn into a rider doing the splits.
    const h = clamp(dt, 1 / 240, 1 / 30);

    if (!this.started) {
      this.started = true;
      this.prevHeading = state.heading;
      this.prevSpeed = state.speed;
      this.prevRoll = state.roll;
    }

    // ------------------------------------------------------------ signals --
    const speed01 = clamp01(state.speed01);

    // Steer: use the boat's if it publishes one, else reconstruct it from the
    // yaw rate. Heading grows clockwise (forward = sin/cos), so a positive rate
    // is a right turn, matching a positive steer input.
    const withSteer = state as BoatState & { steer?: number };
    const yawRate = angleDelta(state.heading, this.prevHeading) / h;
    this.prevHeading = state.heading;
    const steerRaw = typeof withSteer.steer === 'number'
      ? withSteer.steer
      : clamp(yawRate * 0.75, -1, 1);
    const steer = this.sSteer.step(steerRaw, h, 13, 1);

    // Longitudinal acceleration, low-passed. Raw d(speed)/dt is far too spiky
    // to drive a torso with - this is the "does the rider feel pushed" signal.
    const rawAccel = (state.speed - this.prevSpeed) / h;
    this.prevSpeed = state.speed;
    this.accelLp += (rawAccel - this.accelLp) * clamp01(h * 9);
    const accelN = clamp(this.accelLp / 8, -1, 1);

    const slip01 = clamp(state.slip / 5.5, -1, 1);
    const air = this.sAir.step(state.airborne ? 1 : 0, h, 11, 0.9);
    const drift = this.sDrift.step(state.drifting ? 1 : 0, h, 9, 0.85);
    // Two vocabularies reach this argument: the race director's phase
    // ('countdown' / 'finished' / 'results') when the boat is forwarding an
    // override, and the boat's own derived pose ('idle' / 'ride' / 'drift' /
    // 'boost' / 'air' / 'land') otherwise. Accept both - everything the boat
    // vocabulary describes is also readable from BoatState, so the phase string
    // is only ever *additional* information, never the sole source.
    const celebrating = phase === 'finished' || phase === 'results' || phase === 'celebrate' || phase === 'win';
    const preRace = phase === 'countdown' || phase === 'intro' || phase === 'grid';
    const celeb = this.sCeleb.step(celebrating ? 1 : 0, h, 5.5, 0.85);
    // Boosting folds the rider down over the bars. Taken from the state rather
    // than the phase string so it works under either vocabulary.
    const boost = this.sBoost.step(state.boosting ? 1 : 0, h, 8, 0.7);

    // The turn signal the body actually leans on: steering plus the slide it
    // produced. During a drift the slide leads the steering, which is exactly
    // when a rider is leaning hardest.
    const turn = clamp(steer * (1 + 0.35 * drift) + slip01 * 0.45, -1.3, 1.3);

    // ----------------------------------------------------------- landings ---
    // One-frame event. A velocity kick (not a value jump) means the compression
    // ramps in over ~80ms and springs back out over ~0.45s with a little
    // overshoot - a set value would pop on the impact frame.
    if (state.landingImpact > 0.02) this.sLand.kick(-state.landingImpact * 7.0);
    if (state.hitImpact > 0.05) this.sLand.kick(-state.hitImpact * 2.4);
    this.sLand.step(0, h, 12, 0.62);

    // ------------------------------------------------------ celebration -----
    if (celeb > 0.02) this.celebT += dt; else this.celebT = 0;
    const CYCLE = 1.15;
    const uR = (this.celebT / CYCLE) % 1;
    const pumpR = pumpCurve(uR) * celeb;
    const pumpL = pumpCurve((uR + 0.5) % 1) * celeb;
    // Body follows the arms late and overshoots - the follow-through.
    const celebBody = this.sCelebBody.step((pumpR + pumpL) * 0.5, h, 9, 0.5);

    // ---------------------------------------------------------- crouch ------
    // Vertical absorption: when the hull is thrown up, the rider sinks into the
    // legs, and vice versa. Driven by heave, not by a free sine, so it stays
    // locked to the water the boat is actually on. It feeds the *crouch* and not
    // a translation of the hips, because the boots are on the deck: absorbing a
    // swell by sliding the whole body down lifts the feet off it.
    const heaveDip = this.sHeave.step(clamp(state.heave, -7, 7) * 0.017, h, 14, 0.8);

    // Base stance deepens with speed, coils on the start line, and *rises*
    // while airborne (knees come up, body extends). The landing spring is added
    // on top so a slam always compresses from wherever the pose already was.
    //
    // These came down by roughly a third. They were pushed that deep because the
    // boat's yoke used to sit 0.72m forward of the rider's feet and only 0.485m
    // above them, and only a rider folded almost double could reach it; the
    // frames showed the resulting crouch as a deformity rather than as a stance.
    // The grips are now at knuckle-forward chest height (see the SEAT_LOCAL
    // block in BoatMesh), so the fold only has to do what a fold is for: weight
    // over the bars, and a wedge rather than a vertical rectangle from behind.
    let crouchT = 0.30 + 0.34 * speed01 + 0.20 * drift + 0.18 * boost;
    if (preRace) crouchT += 0.24;
    // Chop keeps the airborne flag flickering on at racing speed; a full 0.42
    // of unweighting per unit of it stood the rider straight back up.
    crouchT -= 0.20 * air;
    crouchT -= 0.26 * celeb;
    const crouch = clamp(
      this.sCrouch.step(crouchT, h, 9, 0.85) + this.sLand.value + heaveDip * 2.6,
      -0.15, 1.5,
    );

    // ---------------------------------------------------------- body pose ---
    // Lean into the turn like a rider, then take some of the hull's bank back
    // out. Positive roll lifts the starboard side (BoatPhysics' convention), so
    // the parent transform is already tipping the rider's head to port by
    // `roll`; adding +k*roll locally leaves the shoulders closer to level than
    // the deck. The rate term is the mass: when the hull snaps into a bank the
    // rider's body lags behind it for a beat before catching up.
    const rollRate = (state.roll - this.prevRoll) / h;
    this.prevRoll = state.roll;
    this.rollRateLp += (rollRate - this.rollRateLp) * clamp01(h * 12);
    //
    // The stance term is the important one. On a straight, every physics-driven
    // input to this expression is within a few thousandths of zero, and the
    // result was a bilaterally symmetric figure - which is the difference
    // between a character and a mannequin, whatever else the rig is doing.
    const sway = Math.sin(elapsed * 0.83 + this.bias * 4.1);
    const leanT =
      (0.34 + 0.22 * drift) * turn * (0.45 + 0.55 * speed01)
      + 0.30 * state.roll
      + 0.09 * clamp(this.rollRateLp, -4, 4)
      + this.stance * STANCE_LEAN * (0.55 + 0.45 * speed01)
      + 0.030 * sway;
    const lean = this.sLean.step(clamp(leanT, -0.70, 0.70), h, 10, 0.72);

    // Torso opens out of the corner while the arms stay on the yoke, and carries
    // a permanent few degrees of wind so the shoulders are never square to the
    // hull's centreline.
    const twistT =
      -turn * 0.18
      + this.stance * STANCE_TWIST * (0.5 + 0.5 * speed01)
      + 0.035 * Math.sin(elapsed * 0.61 + this.bias * 2.3);
    const twist = this.sTwist.step(twistT, h, 9, 0.8);

    // Weight shift. Positive rotation.x pitches the chest forward, so we lean
    // *back* under acceleration and fold forward under braking. The state.pitch
    // term is the counter-rotation against the hull: the rider's mass does not
    // want to follow the bow up a wave face.
    const idleBreath = (1 - speed01) * 0.020 * Math.sin(elapsed * 1.7 + this.bias * 3);
    const pitchT =
      0.19 + 0.29 * speed01
      - 0.22 * accelN
      + 0.20 * crouch
      + 0.22 * boost
      - 0.38 * state.pitch
      - 0.62 * celebBody
      + idleBreath;
    // ~28 degrees of fold at racing speed, capped at 41. This is a two-sided
    // constraint, not a free dial. Too shallow and the shoulders stay too high
    // and too far back for the hands to find the bars at all. Too deep and the
    // back turns square-on to a chase camera that already looks slightly down,
    // which hands the frame one large flat plate of suit colour - the same slab
    // read the fold was supposed to break, arriving from the other direction.
    // It was 46 degrees rising to a 57 degree cap, which is a rider bent over
    // the bars of a boat whose bars were at knee height. They are not any more.
    const pitchLean = this.sPitch.step(clamp(pitchT, -0.45, 0.72), h, 8.5, 0.7);

    // Kept small on purpose: a big shrug plus a forward lean swallows the head.
    const shrug = this.sShrug.step(0.02 + 0.13 * crouch + 0.42 * celebBody + 0.08 * air, h, 11, 0.8);

    // ------------------------------------------------------------- legs -----
    // Solved before the pelvis, because the pelvis is placed *from* the legs.
    const pelvisPitch = pitchLean * SPINE_W[0]!;
    const tuck = air;
    let legY = 0;
    let legZ = 0;
    for (let i = 0; i < this.legs.length; i++) {
      const L = this.legs[i]!;
      // Drift: the *outside* leg braces straight, the inside knee folds under.
      const extend = drift * clamp01(-L.side * turn);
      const fold = drift * clamp01(L.side * turn);
      // A permanent stagger: one foot forward of the other. Two legs at matching
      // angles read as one column from behind however far apart they are.
      const stagger = L.side * this.stance * 0.16;
      const bend = (0.46 + 0.86 * crouch) * (1 - 0.50 * extend) + 0.30 * fold + 0.10 * stagger;
      L.thigh.rotation.set(
        -bend * 0.55 - tuck * 0.62 + extend * 0.22 - stagger * 0.20,
        -L.side * 0.05,
        // Knees driven outboard: the negative space between the thighs is what
        // stops the lower body reading as one tapering orange column.
        L.side * (0.15 + 0.13 * extend),
      );
      L.shin.rotation.set(bend * 1.15 + tuck * 0.55 - extend * 0.30, 0, 0);
      // Keep the sole roughly on the deck whatever the knees are doing.
      L.foot.rotation.set(
        -(L.thigh.rotation.x + L.shin.rotation.x) * 0.82 - tuck * 0.25,
        0,
        -L.side * (0.12 + 0.10 * extend),
      );
      // Angles measured in RIG space, not pelvis space: the pelvis is itself
      // pitched by its share of the fold, and at 0.33rad of it that omission put
      // the boots 5cm in the air and 18cm behind where they belong.
      const t1 = pelvisPitch + L.thigh.rotation.x;
      const t2 = t1 + L.shin.rotation.x;
      legY += this.thighLen * Math.cos(t1) + this.shinLen * Math.cos(t2);
      legZ += this.thighLen * Math.sin(t1) + this.shinLen * Math.sin(t2);
    }
    legY = legY / this.legs.length + HIP_DROP * Math.cos(pelvisPitch);
    legZ = legZ / this.legs.length + HIP_DROP * Math.sin(pelvisPitch);

    /*
     * Pelvis, solved from the legs rather than dropped by a fixed fraction of
     * the crouch. The legs are pure FK, so a "deeper crouch" that only bends the
     * knees lifts the feet clean off the deck; the old fixed drop and the leg
     * bend disagreed by several centimetres and the boots floated. Placing the
     * hips at (foot plane + leg chain) makes the two agree by construction, at
     * any crouch depth, which is what lets the crouch go as deep as the yoke
     * needs it to.
     */
    const pelvisRest = restHeadOf('pelvis');
    this.pelvis.position.set(
      pelvisRest.x,
      // The air tuck is the one case where the feet are *meant* to leave the
      // deck, so the height the folded legs would otherwise steal is handed
      // back: knees come up under a stationary body instead of the body
      // sinking onto stationary feet.
      FOOT_PLANE_Y + legY + air * 0.11 + celebBody * 0.035,
      FOOT_PLANE_Z + legZ,
    );
    // The lean/twist/pitch is spread down the spine so the back reads as a
    // curve rather than as one hinge at the hips.
    this.pelvis.rotation.set(pelvisPitch, twist * SPINE_W[0]!, -lean * SPINE_W[0]!);
    for (let i = 0; i < 3; i++) {
      const w = SPINE_W[i + 1]!;
      this.spine[i]!.rotation.set(pitchLean * w, twist * w, -lean * w);
    }

    // ------------------------------------------------------------- head -----
    // Eyes on the apex: the head yaw is specified in *body* space and the spine
    // twist is subtracted back out, so however the torso is wound up the gaze
    // still lands where the boat is going.
    // 16 rad/s and slightly underdamped: the head leads the body into a corner
    // and settles with a small overshoot, which is what reads as "looking".
    const headYawT =
      turn * 0.70
      // Looking somewhere. A head aligned dead on the boat's axis is the last
      // thing that has to go before a figure stops reading as cargo.
      + this.stance * STANCE_LOOK * (0.6 + 0.4 * speed01)
      + 0.06 * Math.sin(elapsed * 0.47 + this.bias * 5.5);
    const headYaw = this.sHeadYaw.step(clamp(headYawT, -0.9, 0.9), h, 16, 0.75);
    const headPitchT =
      // Chin carried up and eyes down the course, always. This is most of the
      // "attitude" in the pose: a head that tracks the spine reads as cargo, a
      // head held against it reads as someone driving.
      -0.14 + 0.12 * speed01
      + 0.12 * boost
      - 0.28 * air
      - 0.42 * celebBody
      + 0.22 * clamp01(-accelN)
      // Chin comes UP as the back goes down, or a folded rider stares at the
      // footwell and the camera gets the top of a helmet instead of a visor.
      - 0.34 * clamp01(pitchLean);
    const headPitch = this.sHeadPitch.step(headPitchT, h, 13, 0.7);

    // Neck takes 40% so the head is a two-bone curve, not a swivel on a stick.
    // The head counter-rolls: it stays closer to level than the shoulders, the
    // way a person's does, which also keeps the visor facing the camera.
    this.neck.rotation.set(
      (headPitch - pitchLean * 0.88) * 0.4,
      (headYaw - twist) * 0.4,
      -lean * 0.22 * 0.4,
    );
    this.head.rotation.set(
      (headPitch - pitchLean * 0.88) * 0.6,
      (headYaw - twist) * 0.6,
      -lean * 0.22 * 0.6,
    );

    /*
     * Clavicles. Three jobs:
     *   y - swings the arm root forward around the ribcage toward the yoke,
     *   z - the shrug, symmetric, plus a CONSTANT tilt of the whole shoulder
     *       line. The constant is not a shrug: it is applied with the same sign
     *       to both clavicles, so one shoulder rises as the other drops. That
     *       single term is the difference between a posed character and a
     *       coat-hanger, and it survives a dead-straight racing line.
     */
    const shoulderTilt = this.stance * STANCE_DROP * (1 - 0.7 * celeb);
    for (const a of this.arms) {
      a.clav.rotation.set(
        0,
        -a.side * (0.15 - 0.20 * celeb),
        a.side * (shrug - 0.02) + shoulderTilt,
      );
    }

    // Everything above is FK, so the world matrices have to be rebuilt before
    // the IK can ask where the shoulders ended up. `true, true` also refreshes
    // the boat's transform above us, so the shoulder and the yoke handle are
    // measured in the same frame - measuring them a frame apart is exactly how
    // hands end up floating off the bars at speed.
    this.rig.root.updateWorldMatrix(true, true);
    this.rig.root.getWorldQuaternion(_qroot);

    // ------------------------------------------------------------- arms -----
    this.resolveYoke(h);
    for (let i = 0; i < this.arms.length; i++) {
      const a = this.arms[i]!;
      const pump = a.side > 0 ? pumpR : pumpL;
      // One arm comes off the bars in the air - never both, and never while
      // drifting, when the rider needs the yoke.
      //
      // Gated hard above 0.55. Racing chop keeps the airborne flag flickering,
      // and the smoothed signal sits around 0.26 the whole way down a straight;
      // a linear response to that left the port hand permanently 18cm off the
      // bar, which measured as "hands not on the yoke" in every frame. Only a
      // real jump should take a hand off.
      const bigAir = clamp01((air - 0.55) / 0.45);
      const airArm = a.side < 0 ? bigAir * 0.80 * (1 - drift) * (1 - celeb) : 0;
      this.armTarget(a, steer, pump, celeb, airArm);
      this.solveArm(a, celeb, pump);
    }

    // ------------------------------------------------------------ scarf -----
    this.updateScarf(h, elapsed, state, speed01);
  }

  // ------------------------------------------------------------ yoke -------

  /**
   * Finds the boat's yoke handles by name. The rider is parented under the boat
   * by the integration layer, so we climb to the boat root and look for the
   * grips there. Until they turn up (or if the boat has none) the arms use a
   * plausible bar position in rider space that still rotates with the steering,
   * so the rider is never left holding nothing.
   */
  private resolveYoke(dt: number): void {
    if (this.searchTries > 40) return;
    if (this.arms[0]!.handle && this.arms[1]!.handle) return;
    this.searchCooldown -= dt;
    if (this.searchCooldown > 0) return;
    this.searchCooldown = 0.25;
    this.searchTries++;

    let node: THREE.Object3D | null = this.rig.root.parent;
    if (!node) return;
    while (node.parent && !(node.parent as THREE.Scene).isScene) node = node.parent;

    let left: THREE.Object3D | null = null;
    let right: THREE.Object3D | null = null;
    node.traverse((o) => {
      const ud = o.userData as { riderGrip?: string };
      const g = ud.riderGrip;
      if (g === 'left' || g === 'l') { left = o; return; }
      if (g === 'right' || g === 'r') { right = o; return; }
      const n = o.name.toLowerCase();
      if (!n.includes('grip') && !n.includes('handle')) return;
      if (n.includes('left') || n.endsWith('l')) left = o;
      else if (n.includes('right') || n.endsWith('r')) right = o;
    });
    if (left && right) {
      this.arms[0]!.handle = right;
      this.arms[1]!.handle = left;
    }
  }

  /**
   * Fills `_tg` with the world-space point this hand should reach.
   * Grip -> airborne raise -> celebration, blended in that order so a rider who
   * finishes mid-jump resolves to the celebration rather than fighting it.
   */
  private armTarget(a: ArmChain, steer: number, pump: number, celeb: number, airArm: number): void {
    if (a.handle) {
      a.handle.getWorldPosition(_tg);
      // The IK drives the *wrist*, and the fist sits about 4cm further down the
      // arm, so the wrist target is lifted by that much - otherwise every hand
      // hangs visibly below the bar it is supposed to be gripping.
      _tg.y += 0.042;
    } else {
      // Fallback bar: rotate the grip offset about a raked steering column, so
      // turning right pushes the right grip back and down like a real yoke.
      _grip.set(a.fx, 0, 0).applyAxisAngle(_axis, -steer * 0.42);
      _tg.set(_grip.x, a.fy + _grip.y, a.fz + _grip.z);
      this.rig.root.localToWorld(_tg);
    }

    if (airArm > 0.01) {
      _tmp.set(a.side * 0.42, 1.46, 0.06);
      this.rig.root.localToWorld(_tmp);
      _tg.lerp(_tmp, airArm);
    }

    if (celeb > 0.01) {
      // Coiled at the chest, extended overhead at the top of the pump. The top
      // of the reach lands just inside the arm's total length, so the elbow
      // never locks dead straight - a locked arm reads as a mannequin.
      const p = clamp01(pump / Math.max(celeb, 1e-3));
      _tmp.set(
        a.side * (0.28 + 0.07 * p),
        1.30 + 0.40 * p,
        0.17 - 0.07 * p,
      );
      this.rig.root.localToWorld(_tmp);
      _tg.lerp(_tmp, celeb);
    }
  }

  /**
   * Two-bone analytic IK. The elbow is placed on the circle of valid solutions
   * using a pole vector pointing down/outward/back, which is where a rider's
   * elbow actually goes when they are hanging off a set of bars.
   *
   * Bones are aimed rather than driven by a canonical axis convention: each one
   * rotates its own rest direction onto the solved direction, so the solver
   * cannot disagree with the rig's rest pose.
   */
  private solveArm(a: ArmChain, celeb: number, pump: number): void {
    _sh.setFromMatrixPosition(a.upper.matrixWorld);

    _dv.copy(_tg).sub(_sh);
    const reach = a.l1 + a.l2;
    let dist = _dv.length();
    if (dist < 1e-4) { _dv.set(0, -1, 0); dist = 1e-4; }
    _dir.copy(_dv).divideScalar(dist);
    // Never fully extend: 0.985 keeps a few degrees in the elbow.
    dist = clamp(dist, Math.abs(a.l1 - a.l2) + 0.04, reach * 0.985);

    // Pole in rider space, then into world. Elbows swing out and back on the
    // bars; when the arm is punching overhead they drop out to the side.
    //
    // The outboard term is heavy (1.05, was 0.55) for a staging reason rather
    // than an anatomical one: the elbow is the only part of the arm the chase
    // camera can see leave the body, and it is what opens the gap of daylight
    // between the upper arm and the ribcage. Tucked elbows weld the arms to the
    // torso and the whole figure closes into one blob.
    _pole.set(a.side * (1.05 + 0.75 * celeb), -1 + 0.85 * celeb * pump, -0.62 + 0.42 * celeb);
    _pole.applyQuaternion(_qroot).normalize();
    _pole.addScaledVector(_dir, -_pole.dot(_dir));
    if (_pole.lengthSq() < 1e-6) _pole.set(0, 1, 0).addScaledVector(_dir, -_dir.y);
    _pole.normalize();

    const cosA = clamp((a.l1 * a.l1 + dist * dist - a.l2 * a.l2) / (2 * a.l1 * dist), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    _elbow.copy(_sh).addScaledVector(_dir, a.l1 * cosA).addScaledVector(_pole, a.l1 * sinA);
    _wrist.copy(_sh).addScaledVector(_dir, dist);
    _fore.copy(_wrist).sub(_elbow).normalize();
    _tmp2.copy(_elbow).sub(_sh).normalize();

    // Upper arm: rotate its rest direction (straight down the bone) onto the
    // shoulder->elbow direction, expressed in the clavicle's space.
    _qp.setFromRotationMatrix(_m.extractRotation(a.clav.matrixWorld));
    _qi.copy(_qp).invert();
    _tmp.copy(_tmp2).applyQuaternion(_qi);
    a.upper.quaternion.setFromUnitVectors(_restUp, _tmp);

    // Forearm: same trick, one level down. Composing the parent's world
    // rotation by hand avoids a second full matrix rebuild here.
    _qu.copy(_qp).multiply(a.upper.quaternion);
    _qi.copy(_qu).invert();
    _tmp.copy(_fore).applyQuaternion(_qi);
    a.fore.quaternion.setFromUnitVectors(_restUp, _tmp);

    // Wrist: cocked back over the bar, opening into a raised fist as the arm
    // punches. Set through the Euler so it cannot fight the two quaternions.
    a.hand.rotation.set(-0.52 + 0.42 * celeb * (0.4 + 0.6 * pump), 0, -a.side * 0.16);
  }

  // ------------------------------------------------------------ scarf ------

  /**
   * Four-point verlet chain simulated in *world* space, then baked back into
   * the scarf bones. World space is the point: the anchor is dragged around by
   * the boat's yaw, so a hard turn whips the tail for free, with no special
   * case for turning anywhere in this code.
   */
  private updateScarf(h: number, elapsed: number, state: BoatState, speed01: number): void {
    const s0 = this.scarfBones[0]!;
    _anchor.setFromMatrixPosition(s0.matrixWorld);

    // First frame, or a teleport (race restart): drop the chain into its rest
    // shape behind the anchor instead of letting it stretch across the map.
    if (!this.scarfReady || _anchor.distanceToSquared(this.sCur[0]!) > 36) {
      this.scarfReady = true;
      _tmp.copy(_restBack).applyQuaternion(_qroot);
      let acc = 0;
      for (let i = 0; i < this.sCur.length; i++) {
        acc += this.sLen[i]!;
        this.sCur[i]!.copy(_anchor).addScaledVector(_tmp, acc);
        this.sPrev[i]!.copy(this.sCur[i]!);
      }
    }

    // Apparent wind: the air the boat is driving through, plus a little lift so
    // the scarf streams rather than hangs, plus a flutter that scales with
    // speed. The flutter is a sine because a scarf edge genuinely oscillates -
    // this is the one place a free-running oscillator is the honest answer.
    _wind.copy(state.velocity).multiplyScalar(-1.05);
    _wind.y += 0.35 + 1.1 * speed01;

    const GRAV = -8.4;      // light, but enough that the tail always falls away
    const DRAG = 2.9;       // 1/s, how hard the air pulls the cloth to its speed
    const DAMP = 0.985;

    for (let i = 0; i < this.sCur.length; i++) {
      const cur = this.sCur[i]!;
      const prev = this.sPrev[i]!;
      // Verlet velocity.
      _tmp.copy(cur).sub(prev).multiplyScalar(DAMP);
      const invH = 1 / h;
      // a = gravity + drag toward the local air velocity + edge flutter.
      // Two beat frequencies rather than one: a single sine down a five-link
      // chain drives every link in near-lockstep and the whole scarf waves as
      // one rigid board. The second, slower term at a different phase per link
      // is what makes it travel a wave along its own length.
      const ph = this.flutterPhase + i * 1.15;
      const amp = (0.9 + 4.6 * speed01) * (0.30 + 0.30 * i);
      const flut = Math.sin(elapsed * (9.0 + i * 1.6) + ph) * amp
        + Math.sin(elapsed * 3.7 - i * 0.9 + this.flutterPhase * 1.7) * amp * 0.55;
      _tmp2.copy(_wind).addScaledVector(_tmp, -invH).multiplyScalar(DRAG);
      _tmp2.y += GRAV + flut * 0.38;
      _tmp2.x += flut * 0.52;
      _tmp2.z += flut * 0.15;

      prev.copy(cur);
      cur.add(_tmp).addScaledVector(_tmp2, h * h);
    }

    // Distance constraints, walked outward from the pinned anchor. Two passes
    // is plenty when the parent of each link is already solved.
    for (let it = 0; it < 2; it++) {
      _tmp2.copy(_anchor);
      for (let i = 0; i < this.sCur.length; i++) {
        const cur = this.sCur[i]!;
        _tmp.copy(cur).sub(_tmp2);
        const len = _tmp.length();
        if (len > 1e-5) cur.copy(_tmp2).addScaledVector(_tmp, this.sLen[i]! / len);
        _tmp2.copy(cur);
      }
    }

    // Bake: each scarf bone aims its rest direction (straight back) at the
    // solved segment, composing world rotations down the chain by hand.
    _qp.setFromRotationMatrix(_m.extractRotation(this.neck.matrixWorld));
    _tmp2.copy(_anchor);
    for (let i = 0; i < this.scarfBones.length; i++) {
      const bone = this.scarfBones[i]!;
      _tmp.copy(this.sCur[i]!).sub(_tmp2);
      if (_tmp.lengthSq() < 1e-8) _tmp.copy(_restBack).applyQuaternion(_qp);
      _tmp.normalize();
      _qi.copy(_qp).invert();
      _tmp.applyQuaternion(_qi);
      bone.quaternion.setFromUnitVectors(_restBack, _tmp);
      _qc.copy(_qp).multiply(bone.quaternion);
      _qp.copy(_qc);
      _tmp2.copy(this.sCur[i]!);
    }
  }
}
