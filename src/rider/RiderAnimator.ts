import * as THREE from 'three';
import type { BoatState } from '../core/types';
import type { Rng } from '../core/Rng';
import { restHeadOf, type RiderRig } from './RiderRig';

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
        fx: side * 0.205, fy: 0.975, fz: 0.345,
      });
      this.legs.push({ thigh: b[`thigh${S}`]!, shin: b[`shin${S}`]!, foot: b[`foot${S}`]!, side });
    }

    for (const n of ['scarf0', 'scarf1', 'scarf2', 'scarf3']) this.scarfBones.push(b[n]!);
    // Four free points: the heads of scarf1..3 plus the tail of scarf3.
    const chain = ['scarf1', 'scarf2', 'scarf3'];
    let prev = restHeadOf('scarf0');
    for (const n of chain) {
      const p = restHeadOf(n);
      this.sLen.push(p.distanceTo(prev));
      this.sCur.push(p.clone());
      this.sPrev.push(p.clone());
      prev = p;
    }
    const tailEnd = restHeadOf('scarf3').clone().add(_tmp.set(0, 0, -0.15));
    this.sLen.push(tailEnd.distanceTo(prev));
    this.sCur.push(tailEnd.clone());
    this.sPrev.push(tailEnd.clone());

    this.flutterPhase = rng.range(0, Math.PI * 2) + index * 1.7;
    this.bias = rng.range(-1, 1);
  }

  /** Explicit wiring, if the integration layer would rather not rely on names. */
  setYoke(left: THREE.Object3D | null, right: THREE.Object3D | null): void {
    for (const a of this.arms) a.handle = a.side > 0 ? right : left;
    this.searchTries = 999;
  }

  // ------------------------------------------------------------- the tick --

  update(dt: number, elapsed: number, state: BoatState, phase: string): void {
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
    // Base stance deepens with speed, coils on the start line, and *rises*
    // while airborne (knees come up, body extends). The landing spring is added
    // on top so a slam always compresses from wherever the pose already was.
    let crouchT = 0.30 + 0.30 * speed01 + 0.26 * drift + 0.24 * boost;
    if (preRace) crouchT += 0.30;
    crouchT -= 0.42 * air;
    crouchT -= 0.30 * celeb;
    const crouch = clamp(this.sCrouch.step(crouchT, h, 9, 0.85) + this.sLand.value, -0.15, 1.5);

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
    const leanT =
      (0.30 + 0.20 * drift) * turn * (0.45 + 0.55 * speed01)
      + 0.30 * state.roll
      + 0.09 * clamp(this.rollRateLp, -4, 4);
    const lean = this.sLean.step(clamp(leanT, -0.65, 0.65), h, 10, 0.72);

    // Torso opens slightly out of the corner while the arms stay on the yoke.
    const twist = this.sTwist.step(-turn * 0.15, h, 9, 0.8);

    // Weight shift. Positive rotation.x pitches the chest forward, so we lean
    // *back* under acceleration and fold forward under braking. The state.pitch
    // term is the counter-rotation against the hull: the rider's mass does not
    // want to follow the bow up a wave face.
    const idleBreath = (1 - speed01) * 0.020 * Math.sin(elapsed * 1.7 + this.bias * 3);
    const pitchT =
      0.20 + 0.34 * speed01
      - 0.34 * accelN
      + 0.30 * crouch
      + 0.26 * boost
      - 0.42 * state.pitch
      - 0.55 * celebBody
      + idleBreath;
    const pitchLean = this.sPitch.step(clamp(pitchT, -0.55, 0.95), h, 8.5, 0.7);

    // Vertical absorption: when the hull is thrown up, the rider sinks into the
    // legs, and vice versa. Driven by heave, not by a free sine, so it stays
    // locked to the water the boat is actually on.
    const heaveDip = this.sHeave.step(clamp(state.heave, -7, 7) * 0.017, h, 14, 0.8);

    // Kept small on purpose: a big shrug plus a forward lean swallows the head.
    const shrug = this.sShrug.step(0.02 + 0.13 * crouch + 0.42 * celebBody + 0.08 * air, h, 11, 0.8);

    // Pelvis: the crouch lives here, plus the heave absorption and a small
    // rearward shift so a deep crouch does not push the rider through the yoke.
    const pelvisRest = restHeadOf('pelvis');
    this.pelvis.position.set(
      pelvisRest.x,
      pelvisRest.y - crouch * 0.135 - heaveDip + celebBody * 0.035,
      pelvisRest.z - crouch * 0.055,
    );
    // The lean/twist/pitch is spread down the spine so the back reads as a
    // curve rather than as one hinge at the hips.
    const W = [0.30, 0.22, 0.24, 0.24];
    this.pelvis.rotation.set(pitchLean * W[0]!, twist * W[0]!, -lean * W[0]!);
    for (let i = 0; i < 3; i++) {
      const w = W[i + 1]!;
      this.spine[i]!.rotation.set(pitchLean * w, twist * w, -lean * w);
    }

    // ------------------------------------------------------------- head -----
    // Eyes on the apex: the head yaw is specified in *body* space and the spine
    // twist is subtracted back out, so however the torso is wound up the gaze
    // still lands where the boat is going.
    // 16 rad/s and slightly underdamped: the head leads the body into a corner
    // and settles with a small overshoot, which is what reads as "looking".
    const headYaw = this.sHeadYaw.step(clamp(turn * 0.62, -0.8, 0.8), h, 16, 0.75);
    const headPitchT =
      -0.05 + 0.16 * speed01
      + 0.14 * boost
      - 0.30 * air
      - 0.45 * celebBody
      + 0.25 * clamp01(-accelN);
    const headPitch = this.sHeadPitch.step(headPitchT, h, 13, 0.7);

    // Neck takes 40% so the head is a two-bone curve, not a swivel on a stick.
    this.neck.rotation.set(
      (headPitch - pitchLean * 0.55) * 0.4,
      (headYaw - twist) * 0.4,
      lean * 0.30 * 0.4,
    );
    this.head.rotation.set(
      (headPitch - pitchLean * 0.55) * 0.6,
      (headYaw - twist) * 0.6,
      lean * 0.30 * 0.6,
    );

    // ------------------------------------------------------------- legs -----
    const tuck = air;
    for (let i = 0; i < this.legs.length; i++) {
      const L = this.legs[i]!;
      // Drift: the *outside* leg braces straight, the inside knee folds under.
      const extend = drift * clamp01(-L.side * turn);
      const fold = drift * clamp01(L.side * turn);
      const bend = (0.42 + 0.80 * crouch) * (1 - 0.50 * extend) + 0.30 * fold;
      L.thigh.rotation.set(
        -bend * 0.55 - tuck * 0.62 + extend * 0.22,
        -L.side * 0.05,
        L.side * (0.07 + 0.13 * extend),
      );
      L.shin.rotation.set(bend * 1.15 + tuck * 0.55 - extend * 0.30, 0, 0);
      // Keep the sole roughly on the deck whatever the knees are doing.
      L.foot.rotation.set(
        -(L.thigh.rotation.x + L.shin.rotation.x) * 0.82 - tuck * 0.25,
        0,
        -L.side * (0.05 + 0.10 * extend),
      );
    }

    // Clavicles: shoulders lift with the shrug and roll forward toward the yoke.
    for (const a of this.arms) {
      a.clav.rotation.set(0, -a.side * (0.11 - 0.16 * celeb), a.side * (shrug - 0.02));
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
      const airArm = a.side < 0 ? air * 0.55 * (1 - drift) * (1 - celeb) : 0;
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
    _pole.set(a.side * (0.55 + 0.75 * celeb), -1 + 0.85 * celeb * pump, -0.55 + 0.35 * celeb);
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
    const DRAG = 3.4;       // 1/s, how hard the air pulls the cloth to its speed
    const DAMP = 0.985;

    for (let i = 0; i < this.sCur.length; i++) {
      const cur = this.sCur[i]!;
      const prev = this.sPrev[i]!;
      // Verlet velocity.
      _tmp.copy(cur).sub(prev).multiplyScalar(DAMP);
      const invH = 1 / h;
      // a = gravity + drag toward the local air velocity + edge flutter.
      const flut = Math.sin(elapsed * (9.0 + i * 1.6) + this.flutterPhase) * (0.6 + 3.2 * speed01) * (0.35 + 0.25 * i);
      _tmp2.copy(_wind).addScaledVector(_tmp, -invH).multiplyScalar(DRAG);
      _tmp2.y += GRAV + flut * 0.30;
      _tmp2.x += flut * 0.42;
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
