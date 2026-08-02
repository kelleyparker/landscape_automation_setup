import * as THREE from 'three';
import type { Boat } from '../boat/Boat';
import type { BoatInput, BoatState, RaceStatus } from '../core/types';
import type { Rng } from '../core/Rng';
import type { Course } from './Course';
import { deriveTuning, type DriverTuning, type Personality } from './Personalities';

/**
 * An AI driver.
 *
 * The hard rule this file is built around: **an AI never moves its boat.** It
 * produces a `BoatInput` - throttle, steer, drift, boost - and hands it to the
 * same `BoatPhysics` the player drives. Every constraint the player fights (the
 * grip breakaway, the drag that scales with immersion, the jet that stops
 * pushing when the stern lifts clear of a crest) applies to the AI identically,
 * which is what makes a pack of them look like drivers rather than like objects
 * on rails. It is also why an AI can spin, can get a landing wrong, and can be
 * shoved off line by contact - none of which is scripted anywhere below.
 *
 * The driving model is five layers, in the order a human does them:
 *
 *  1. **Where to point.** A lookahead point on the centreline, offset laterally
 *     toward the inside of whatever corner is coming, chased with a PD
 *     controller and a slew-rate limit on the stick.
 *  2. **How fast to arrive.** A braking-distance solve over several lookahead
 *     samples: for each, the speed the corner will hold, back-projected through
 *     the deceleration the driver believes it has. The minimum wins. This is
 *     what produces visible, repeatable brake points instead of a speed cap.
 *  3. **Whether to slide.** Drift engages when the corner is genuinely tight and
 *     the stick is genuinely loaded, held long enough to bank charge, released
 *     on the way out to cash it in - the same loop the player runs.
 *  4. **Where the others are.** A forward-projected cone test producing a
 *     lateral bias, low-passed so two boats do not sit there oscillating at each
 *     other, plus a blocking move for the drivers whose character includes one.
 *  5. **Being human.** A seeded mistake schedule, and a small rubber band.
 *
 * Everything that differs between Vex, Nori and Gus comes out of
 * `Personalities.deriveTuning()`. There is no `if (name === 'Vex')` in here.
 */

// -------------------------------------------------------------- constants ----

/**
 * Mirrors `TOP_SPEED` in `BoatPhysics`. Only used to cap the AI's *target*
 * speed - the AI's actual ceiling is the physics, which is the same code the
 * player runs, so no value here can make an AI faster than a boosting player.
 */
const TOP_SPEED = 34.0;

/**
 * Deceleration the driver plans around, m/s^2, before `brakeBias`. Roughly what
 * a closed throttle plus hull drag actually delivers at racing speed (drag at
 * 30 m/s is ~7.7 m/s^2 and climbs in the troughs), so a driver planning on this
 * arrives at the corner about right and one planning on 1.2x arrives hot.
 */
const BRAKE_ACCEL = 9.0;

/**
 * Curvature that counts as "a proper corner", 1/m. 0.020 is a 50 m radius -
 * tight enough on this circuit to need the brakes and the slide, so it is the
 * natural unit to measure everything else in.
 */
const CURV_REF = 0.020;
/**
 * Curvature that counts as "not a straight" when deciding whether to spend
 * boost, 1/m. Deliberately looser than CURV_REF (33 m radius): a hoarder should
 * be willing to spend through a fast kink, just not into a hairpin.
 */
const STRAIGHT_REF = 0.030;

/** Metres ahead the braking solver samples curvature at, before `brakeScan`. */
const BRAKE_SAMPLES = [8, 16, 28, 45, 70, 100] as const;
/** Samples at or inside this distance decide whether we are *in* a corner. */
const NEAR_SAMPLE_M = 30;

/**
 * Half-span of the pair of tangent samples used to read which way the course
 * bends, metres. `Course.curvatureAt` is a magnitude by design - it deliberately
 * refuses to encode handedness, because a signed value there makes every
 * `k > threshold` test in the game silently ignore half the circuit - so the
 * direction of a corner is recovered here from the cross product of two nearby
 * tangents instead.
 */
const AIM_SPAN = 6;

/** Fraction of the course half-width a driver will use. */
const LINE_MARGIN = 0.78;

/** Below this the hull cannot hold a slide at all (BoatPhysics.DRIFT_MIN_SPEED + margin). */
const DRIFT_MIN_SPEED = 8.0;
/** A slide is only worth starting if the corner is at least this bent. */
const DRIFT_MIN_BEND = 0.34;

/** How far ahead the avoidance test projects the other boat, seconds. */
const AVOID_PREDICT = 1.0;
/** Length and half-width of the cone ahead that is worth reacting to, metres. */
const AVOID_CONE = 26;
const AVOID_HALF = 5.5;
/** Lateral bias a maximally urgent conflict asks for, metres. */
const AVOID_PUSH = 4.0;
/** Response rate of the avoidance filter, 1/s. ~0.25 s - slow enough not to ring. */
const AVOID_LAG = 4.0;
/** Half-beam either boat needs when running side by side, metres. */
const ALONGSIDE_HALF = 3.2;

/** How far back a driver will bother covering, metres, and how far it moves. */
const BLOCK_RANGE = 16;
const BLOCK_PUSH = 3.0;
const BLOCK_LAG = 2.0;

/** Rubber band ceiling. +/-6% of target speed, and half that on steering gain. */
const BAND_MAX = 0.06;
/** Distance to the player, metres, at which the band saturates. */
const BAND_RANGE = 130;

/** Heading error past which the boat is facing the wrong way and must pivot. */
const PIVOT_ERR = 2.0;

/**
 * Target speed once this driver's race is over, m/s. A finisher keeps following
 * the course - it has a celebration pose to hold and the results camera orbits
 * the pack - but at a cruise, because a boat still qualifying for pole during
 * the results screen looks like nobody told it the race ended.
 */
const CRUISE_SPEED = 9.0;

/** Response rate of the apex filter, 1/s. The lag is what opens the corner exit. */
const APEX_LAG = 3.5;

const TAU = Math.PI * 2;

// --- mistake kinds -----------------------------------------------------------
const M_OVERSHOOT = 0;
const M_LATE_BRAKE = 1;
const M_LIFT = 2;
const M_TWITCH = 3;

// --------------------------------------------------------------- scratch -----
// Module scope: one point and two tangents per frame, reused by every controller.

const _aim = new THREE.Vector3();
const _d0 = new THREE.Vector3();
const _d1 = new THREE.Vector3();

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wrap a spline parameter into [0, 1). */
function wrap01(t: number): number {
  return t - Math.floor(t);
}

/** Wrap an angle into (-pi, pi]. */
function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= TAU;
  while (x < -Math.PI) x += TAU;
  return x;
}

export class AIController {
  readonly personality: Personality;
  private readonly boat: Boat;
  private readonly course: Course;
  private readonly tune: DriverTuning;
  private readonly rng: Rng;

  /**
   * The one input object this driver owns. `BoatPhysics` keeps the reference and
   * reads it during its substeps, so this must be per-controller and stable -
   * a shared module-scope object would have all three AI driving as one.
   */
  private readonly out: BoatInput = { throttle: 0, steer: 0, drift: false, boost: false };

  private readonly lapLength: number;

  // --- controller state ---------------------------------------------------
  private steerOut = 0;
  private prevHeading = 0;
  private yawRate = 0;
  private apexSmooth = 0;
  private avoidBias = 0;
  private blockBias = 0;

  private drifting = false;
  private driftTimer = 0;
  private boosting = false;
  private boostThreshold = 0.5;

  private readonly wanderPhase: number;

  private mistakeTimer = 0;
  private mistakeLeft = 0;
  private mistakeKind = M_LIFT;
  private mistakeMag = 0;
  private mistakeSign = 1;

  private reactionLeft = 0;
  private lastPhase: RaceStatus['phase'] = 'intro';
  private playerIndex = -1;

  constructor(boat: Boat, course: Course, personality: Personality, rng: Rng) {
    this.boat = boat;
    this.course = course;
    this.personality = personality;
    this.tune = deriveTuning(personality);
    this.rng = rng;

    // Every "N metres ahead" in this file is converted to a spline delta through
    // this, so the driver's horizon is expressed in metres rather than in an
    // arbitrary fraction of a circuit whose size it has no other way to see.
    this.lapLength = Math.max(1, course.totalLength);

    this.wanderPhase = rng.range(0, TAU);
    this.prevHeading = boat.state.heading;
    this.reset();
  }

  /**
   * Back to a clean slate for a new race. Not part of the required surface -
   * `update()` calls it itself when the phase machine returns to the grid, so a
   * restart cannot leave a driver mid-mistake or mid-slide.
   */
  reset(): void {
    this.steerOut = 0;
    this.yawRate = 0;
    this.prevHeading = this.boat.state.heading;
    this.apexSmooth = 0;
    this.avoidBias = 0;
    this.blockBias = 0;
    this.drifting = false;
    this.driftTimer = 0;
    this.boosting = false;
    this.rollBoostThreshold();
    this.mistakeLeft = 0;
    this.scheduleMistake();
    this.rollReaction();
    this.idle();
  }

  // ----------------------------------------------------------------- tick ----

  update(dt: number, elapsed: number, status: RaceStatus, all: Boat[]): void {
    const st = this.boat.state;

    // Yaw rate, differentiated from the heading. Physics does not publish it and
    // the D term of the steering controller is useless without it - a P-only
    // driver on a boat with an 8.5 rad/s yaw lag oscillates every corner.
    const dh = wrapPi(st.heading - this.prevHeading);
    this.prevHeading = st.heading;
    if (dt > 1e-5) {
      const inst = dh / dt;
      // Light smoothing only: chop shakes the hull, and an unfiltered rate would
      // put that shake straight back into the stick.
      this.yawRate += (inst - this.yawRate) * Math.min(1, 20 * dt);
    }

    const phase = status.phase;
    if (phase === 'intro' || phase === 'countdown') {
      if (this.lastPhase !== 'intro' && this.lastPhase !== 'countdown') this.reset();
      else if (phase === 'countdown' && this.lastPhase === 'intro') this.rollReaction();
      this.lastPhase = phase;
      this.idle();
      return;
    }
    this.lastPhase = phase;

    // Reaction time off the line. A tenth or two of variation across the grid is
    // the difference between four boats leaving as one object and four drivers.
    if (this.reactionLeft > 0) {
      this.reactionLeft -= dt;
      this.idle();
      return;
    }

    this.drive(dt, elapsed, status, all, st);
  }

  private idle(): void {
    const o = this.out;
    o.throttle = 0;
    o.steer = 0;
    o.drift = false;
    o.boost = false;
    this.boat.setInput(o);
  }

  // ---------------------------------------------------------------- drive ----

  private drive(
    dt: number,
    elapsed: number,
    status: RaceStatus,
    all: Boat[],
    st: BoatState,
  ): void {
    const tune = this.tune;
    const pr = this.boat.progress;
    const speed = Math.max(0, st.speed);
    // The director's projection, one frame stale. Reusing it keeps one authority
    // for "where on the course is this boat" and saves a nearest-point search
    // per driver per frame; 16 ms of lag on a value that moves at most half a
    // metre in that time is not a horizon this controller can feel.
    const t = pr.splineT;

    // This driver's race is over: its own flag has fallen, or everyone's has.
    const cruise = status.phase === 'results' || pr.finishTime !== null;

    // --- fallibility -------------------------------------------------------
    if (this.mistakeLeft > 0) this.mistakeLeft -= dt;
    if (!cruise && this.mistakeLeft <= 0 && !st.airborne) {
      this.mistakeTimer -= dt;
      if (this.mistakeTimer <= 0) this.startMistake();
    }
    const bad = this.mistakeLeft > 0 && !cruise;
    const mag = bad ? this.mistakeMag : 0;
    // A mistake is a temporary distortion of the *inputs to* the driving model,
    // never a direct shove on the boat. That is what keeps it recoverable: the
    // same controller that made the error is still running and still trying.
    const apexScale = bad && this.mistakeKind === M_OVERSHOOT ? -0.55 * mag : 1;
    const steerScale = bad && this.mistakeKind === M_OVERSHOOT ? 1 - 0.35 * mag : 1;
    const brakeScale = bad && this.mistakeKind === M_LATE_BRAKE ? 1 + 0.60 * mag : 1;
    const throttleCap = bad && this.mistakeKind === M_LIFT ? 0.35 : 1;
    const steerBias = bad && this.mistakeKind === M_TWITCH ? this.mistakeSign * 0.40 * mag : 0;

    // --- rubber band -------------------------------------------------------
    const band = this.rubberBand(all, pr.total);

    // --- where the course goes --------------------------------------------
    const lookM = tune.lookaheadBase + speed * tune.lookaheadPerSpeed;
    const tAim = wrap01(t + lookM / this.lapLength);
    const span = AIM_SPAN / this.lapLength;

    this.course.pointAt(tAim, _aim);
    this.course.tangentAt(wrap01(tAim - span), _d0);
    this.course.tangentAt(wrap01(tAim + span), _d1);

    let fx = _d0.x + _d1.x, fz = _d0.z + _d1.z;
    const flen = Math.sqrt(fx * fx + fz * fz);
    if (flen > 1e-5) { fx /= flen; fz /= flen; }
    else { fx = Math.sin(st.heading); fz = Math.cos(st.heading); }
    // Starboard of the course direction, in the same handedness `BoatPhysics`
    // uses for the hull frame: heading 0 faces +Z and starboard is +X. Every
    // lateral quantity in this file is measured on that axis.
    const rx = fz;
    const rz = -fx;

    // Which way the course bends here. See AIM_SPAN: the cross product of the
    // two tangents carries the handedness that `curvatureAt` deliberately does
    // not. Turning toward starboard makes this negative.
    const cross = _d0.x * _d1.z - _d0.z * _d1.x;
    const turnSign = cross < 0 ? 1 : cross > 0 ? -1 : 0; // +1 = the course turns right
    const bend = Math.min(1, this.course.curvatureAt(tAim) / CURV_REF);
    // The course pinches to 10 m of half-width through the chicane and opens to
    // 28 m on the sweeper, so the driver's line budget has to be read locally
    // rather than assumed - an apex cut that fits the sweeper is off the course
    // in the chicane.
    const trackHalf = this.course.widthAt(tAim) * LINE_MARGIN;

    // --- the racing line ---------------------------------------------------
    // Cut toward the inside of the corner. Filtered, and the filter is doing
    // real work: the lag holds the inside line a beat past the apex, which is
    // exactly the wide, late exit a driver takes on the way out of a corner.
    const apexTarget = turnSign * tune.apexCut * bend * apexScale;
    this.apexSmooth += (apexTarget - this.apexSmooth) * Math.min(1, APEX_LAG * dt);

    const wander = tune.wander * Math.sin(elapsed * (TAU / tune.wanderPeriod) + this.wanderPhase);

    this.updateAvoidance(dt, all, st, bend);

    const lateral = clamp(
      this.apexSmooth + wander + this.avoidBias + this.blockBias,
      -trackHalf,
      trackHalf,
    );

    // --- steering ----------------------------------------------------------
    const aimX = _aim.x + rx * lateral;
    const aimZ = _aim.z + rz * lateral;
    // Heading 0 faces +Z, so the bearing to a point is atan2(dx, dz).
    const err = wrapPi(Math.atan2(aimX - st.position.x, aimZ - st.position.z) - st.heading);

    let steerTarget = (tune.steerP * err - tune.steerD * this.yawRate) * steerScale;
    steerTarget *= 1 + band * 0.5;
    steerTarget = clamp(steerTarget + steerBias, -1, 1);

    // Rate-limited hands. This is most of what "smooth" and "snatchy" mean on
    // screen, and it also keeps the drift trigger below from chattering.
    const step = tune.steerSlew * dt;
    this.steerOut += clamp(steerTarget - this.steerOut, -step, step);

    // --- speed -------------------------------------------------------------
    const budget = tune.cornerBudget * (1 + band * 0.5);
    const brakeA = BRAKE_ACCEL * tune.brakeBias * brakeScale;
    let vLimit = TOP_SPEED * (1 + band);
    let maxK = 0;
    let nearK = 0;
    for (let s = 0; s < BRAKE_SAMPLES.length; s++) {
      const d = BRAKE_SAMPLES[s]! * tune.brakeScan;
      const k = this.course.curvatureAt(wrap01(t + d / this.lapLength));
      if (k > maxK) maxK = k;
      if (d <= NEAR_SAMPLE_M && k > nearK) nearK = k;
      if (k < 1e-4) continue;
      // Speed the corner itself will hold, then back-projected through the
      // braking the driver thinks it has: v^2 = vCorner^2 + 2*a*d.
      const vc2 = budget / k;
      const v = Math.sqrt(vc2 + 2 * brakeA * d);
      if (v < vLimit) vLimit = v;
    }
    if (cruise && vLimit > CRUISE_SPEED) vLimit = CRUISE_SPEED;

    let throttle: number;
    if (speed < vLimit - 0.5) {
      throttle = 1;
    } else {
      // Past the limit the lift deepens with the overspeed, and a driver with
      // `brakeDepth` at 1.0 goes all the way onto reverse thrust.
      throttle = 1 - tune.brakeDepth * Math.min(1.35, (speed - vLimit) / 3.5);
    }
    throttle = Math.min(throttle, throttleCap);
    // Facing the wrong way: back off so the hull can actually rotate. Fighting
    // a spin with full throttle is how an AI ends up driving into open water.
    if (Math.abs(err) > PIVOT_ERR && speed > 4) throttle = Math.min(throttle, 0.12);

    // --- slide -------------------------------------------------------------
    const steerMag = Math.abs(this.steerOut);
    const canSlide = speed > DRIFT_MIN_SPEED && !st.airborne && !cruise;
    if (this.drifting) {
      this.driftTimer += dt;
      // Held for at least `driftHold` so the slide always banks some charge -
      // a slide released early is worth almost nothing (TIER_PAYOUT is steeply
      // non-linear) and would read as the AI fumbling the mechanic.
      if (!canSlide || (steerMag < tune.driftExit && this.driftTimer > tune.driftHold)) {
        this.drifting = false;
      }
    } else if (canSlide && steerMag > tune.driftEnter && nearK > DRIFT_MIN_BEND * CURV_REF) {
      // Gated on the curvature the boat is *in*, not the one it is aiming at:
      // the lookahead point is already round the corner at speed, and sliding on
      // the strength of a bend that has not arrived yet is how an AI ends up
      // powersliding down a straight.
      this.drifting = true;
      this.driftTimer = 0;
    }

    // --- boost -------------------------------------------------------------
    const straight = 1 - Math.min(1, maxK / STRAIGHT_REF);
    if (this.boosting) {
      // Ride it to the floor. BoatPhysics cuts out at BOOST_MIN anyway, so
      // releasing early only wastes the meter.
      if (st.airborne || st.boostMeter <= 0.03) {
        this.boosting = false;
        this.rollBoostThreshold();
      }
    } else if (
      !st.airborne && !cruise &&
      st.boostMeter >= this.boostThreshold &&
      straight >= tune.boostStraightness
    ) {
      this.boosting = true;
    }

    // --- airborne ----------------------------------------------------------
    if (st.airborne) {
      // Throttle is pitch authority in the air (AIR_PITCH in BoatPhysics), and
      // holding it settles the hull nose-down - the entry that does not scrub.
      throttle = 1;
      this.drifting = false;
      this.boosting = false;
    }

    // --- commit ------------------------------------------------------------
    const o = this.out;
    o.throttle = clamp(throttle, -1, 1);
    o.steer = clamp(this.steerOut, -1, 1);
    o.drift = this.drifting;
    o.boost = this.boosting;
    this.boat.setInput(o);
  }

  // ------------------------------------------------------------ racecraft ----

  /**
   * Lateral bias from the rest of the pack.
   *
   * Two separate concerns, deliberately kept apart: avoidance only looks at
   * boats *ahead*, blocking only at boats *behind*, so they can never fight each
   * other over the same rival. Both go through a first-order filter - without it
   * two AI meeting head-on trade steering corrections at the frame rate and
   * shimmy down the straight.
   */
  private updateAvoidance(dt: number, all: Boat[], st: BoatState, bend: number): void {
    const fwx = Math.sin(st.heading);
    const fwz = Math.cos(st.heading);
    const sbx = Math.cos(st.heading);
    const sbz = -Math.sin(st.heading);

    let avoid = 0;
    let block = 0;
    const wantsBlock = this.tune.blockGain > 0;

    for (let i = 0; i < all.length; i++) {
      const other = all[i]!;
      if (other === this.boat) continue;
      const op = other.state.position;
      const dx = op.x - st.position.x;
      const dz = op.z - st.position.z;
      const f = dx * fwx + dz * fwz;
      const l = dx * sbx + dz * sbz;

      if (f > 1.0 && f < AVOID_CONE && Math.abs(l) < AVOID_HALF) {
        // Project a second ahead. Closing on a slower boat and being pulled away
        // from a faster one look identical at an instant and completely
        // different a second later, which is the only horizon that matters here.
        const ov = other.state.velocity;
        const rvx = ov.x - st.velocity.x;
        const rvz = ov.z - st.velocity.z;
        const f1 = f + (rvx * fwx + rvz * fwz) * AVOID_PREDICT;
        const l1 = l + (rvx * sbx + rvz * sbz) * AVOID_PREDICT;
        if (f1 > 0 && Math.abs(l1) < AVOID_HALF) {
          const urgency = (1 - f / AVOID_CONE) * (1 - Math.abs(l1) / AVOID_HALF);
          // Bias away from the side they are on. Mixing in the current offset
          // breaks the tie when the predicted one lands near zero.
          const ref = l1 + l * 0.25;
          avoid += (ref >= 0 ? -1 : 1) * AVOID_PUSH * urgency;
        }
      } else if (f > -5 && f <= 1.0 && Math.abs(l) < ALONGSIDE_HALF) {
        // Wheel to wheel. A gentler, purely lateral push so a pair running
        // side by side stops sanding each other's paint off down the straight.
        avoid += (l >= 0 ? -1 : 1) * AVOID_PUSH * 0.5 * (1 - Math.abs(l) / ALONGSIDE_HALF);
      } else if (wantsBlock && f < -1.5 && f > -BLOCK_RANGE && Math.abs(l) < 9) {
        // Someone is lining up a move. Drift across to the side they are coming
        // up, which is a lateral bias like any other and therefore inherits the
        // same clamp to the course width.
        const close = 1 - -f / BLOCK_RANGE;
        block += (l >= 0 ? 1 : -1) * BLOCK_PUSH * close;
      }
    }

    avoid *= this.tune.avoidGain;
    // Never throw a corner away to cover someone: mid-bend the block fades out.
    block *= this.tune.blockGain * (1 - bend * 0.7);

    this.avoidBias += (avoid - this.avoidBias) * Math.min(1, AVOID_LAG * dt);
    this.blockBias += (block - this.blockBias) * Math.min(1, BLOCK_LAG * dt);
  }

  /**
   * Mild rubber band: +/-6% on the *target* speed and half that on steering gain,
   * scaled by how far up or down the road the player is.
   *
   * It cannot make an AI faster than a boosting player, and not by tuning - by
   * construction. The band moves a speed the controller *aims* for; the speed it
   * *reaches* is decided by `BoatPhysics`, which is the same code the player's
   * boat runs. A fully-banded target of 34 * 1.06 = 36.0 m/s is still well
   * under the 41.5 m/s a boosting hull will do.
   */
  private rubberBand(all: Boat[], myTotal: number): number {
    if (this.playerIndex < 0) {
      for (let i = 0; i < all.length; i++) if (all[i]!.isPlayer) { this.playerIndex = i; break; }
      if (this.playerIndex < 0) return 0;
    }
    const player = all[this.playerIndex];
    if (!player) return 0;
    // Once anyone involved is across the line there is no race left to shape.
    if (player.progress.finishTime !== null || this.boat.progress.finishTime !== null) return 0;
    const metres = (player.progress.total - myTotal) * this.lapLength;
    return clamp(metres / BAND_RANGE, -1, 1) * BAND_MAX;
  }

  // ---------------------------------------------------------- fallibility ----

  private scheduleMistake(): void {
    this.mistakeTimer = this.rng.range(this.tune.mistakeGap * 0.5, this.tune.mistakeGap * 1.5);
  }

  /**
   * Picks a way to get it wrong. All four are distortions of the driving model
   * that last around a second, so the driver is always visibly *recovering*
   * rather than visibly broken - which is the difference between a rival who
   * made an error and a rival who is buggy.
   */
  private startMistake(): void {
    const r = this.rng.next();
    this.mistakeKind =
      r < 0.34 ? M_OVERSHOOT :
      r < 0.62 ? M_LATE_BRAKE :
      r < 0.84 ? M_LIFT : M_TWITCH;
    this.mistakeMag = this.tune.mistakeScale * this.rng.range(0.55, 1.0);
    this.mistakeLeft = this.rng.range(0.35, 1.05) * (0.6 + 0.6 * this.tune.mistakeScale);
    this.mistakeSign = this.rng.next() < 0.5 ? -1 : 1;
    this.scheduleMistake();
  }

  /**
   * Re-rolls the meter level this driver will spend boost at. Re-rolled per
   * boost rather than fixed, so a low-consistency driver is unpredictable
   * *across* a race instead of merely different from the others.
   */
  private rollBoostThreshold(): void {
    const j = this.tune.boostJitter;
    this.boostThreshold = clamp(this.tune.boostAt + this.rng.signed() * j, 0.06, 0.95);
  }

  private rollReaction(): void {
    this.reactionLeft = this.tune.reaction * this.rng.range(0.75, 1.3);
  }
}
