import * as THREE from 'three';
import type { BoatInput, BoatState } from '../core/types';
import { NEUTRAL_INPUT } from '../core/types';
import { sampleHeight } from '../ocean/GerstnerCPU';
import type { FoamSystem } from '../ocean/FoamSystem';
import { Buoyancy, makeBuoyancyOutput, BOW_PROBE, TRANSOM_PROBE, type BuoyancyOutput } from './Buoyancy';

/**
 * Arcade handling.
 *
 * The brief for this file is a feeling, not a simulation: the boat has to fight
 * the water. Everything below is arranged around three ideas.
 *
 * **1. The hull is never in a steady state.** Water resistance scales with how
 * deep the hull is sitting (`Buoyancy` reports it), so dropping into a trough
 * visibly bogs the boat down and climbing back onto a crest lets it go. That one
 * coupling does more for the feel than any amount of drag tuning, because it
 * makes the *sea* the thing modulating the speed rather than the throttle.
 *
 * **2. Grip has a breakaway.** Lateral friction is enormous below a slip
 * threshold and collapses above it. A powerslide is not "less grip", it is the
 * moment grip stops holding - and it only reads as an event if there is an edge
 * to fall off. Slip also feeds an induced forward drag, so a slide costs speed
 * and the boat settles into a stable slip angle instead of spinning.
 *
 * **3. Yaw is rate-controlled, not torque-integrated.** Steering commands a
 * turn *rate*, reached through a first-order lag. That is what keeps an arcade
 * boat from pirouetting when its grip lets go, and the lag is what gives the
 * hull its weight. Authority peaks at mid speed, softens at the top end and
 * nearly vanishes in the air.
 *
 * ## Fixed timestep
 *
 * Integration runs at 240 Hz in up to four substeps per frame, so at 60 fps and
 * above the handling is bit-identical regardless of frame rate. Below 60 the
 * backlog is dropped rather than chased - a spiral of death on a boat that is
 * already stuttering is strictly worse than a moment of slow motion, and the
 * engine's adaptive resolution exists to keep that from happening.
 *
 * All forces are accelerations (mass is normalised to 1) and the two rotational
 * inertias are quoted per unit mass, so every constant below is directly
 * readable in m/s^2 or rad/s^2.
 */

// ------------------------------------------------------------- integration ---

const SUB_HZ = 240;
const SUB_DT = 1 / SUB_HZ;
const MAX_SUBSTEPS = 4;

// ------------------------------------------------------------------ world ----

/**
 * Arcade gravity. Well above 9.81 and matched to `FoamSystem`'s spray gravity so
 * a boat and the water it throws fall at the same rate - at 9.81 a jump off a
 * crest hangs like a moon landing.
 */
const GRAVITY = 19.0;

// ---------------------------------------------------------------- engine -----

/** Target top speed on flat water at full throttle, m/s (~122 km/h). */
const TOP_SPEED = 34.0;
/** Boost raises the ceiling by this much. */
const BOOST_TOP_MULT = 1.22;

/**
 * Peak acceleration off the line, m/s^2. 2.6 g is absurd for a boat and exactly
 * right for this one: the first second has to feel like a launch.
 */
const THRUST_MAX = 26.0;
/**
 * How much of that is left at the speed ceiling. The taper is what makes the
 * acceleration curve read as "punchy then tapering" rather than as a linear ramp
 * into a drag wall.
 */
const THRUST_TAPER = 0.62;
/** Extra thrust while boosting. Tuned with the drag below for ~42 m/s terminal. */
const BOOST_THRUST = 6.0;
const REVERSE_ACCEL = 9.0;
const REVERSE_TOP = 8.0;

/**
 * Quadratic drag coefficient. THRUST_MAX * (1 - THRUST_TAPER) = 9.88 m/s^2 is
 * left at the ceiling, and 9.88 / 34^2 = 0.00855 puts terminal velocity exactly
 * on TOP_SPEED at nominal immersion.
 */
const DRAG_F = 0.00855;
/**
 * Water resistance against immersion: `DRAG_SUB_BASE + DRAG_SUB_GAIN * immersion`.
 * A hull planing on a crest with two probes wet drags at ~0.75x; one buried in a
 * trough drags at ~1.6x. This is the "fighting water" term - it is why the boat
 * surges over a swell instead of holding a constant speed across it.
 */
const DRAG_SUB_BASE = 0.55;
const DRAG_SUB_GAIN = 1.05;
/** Forward drag induced by sliding sideways. Makes a drift cost speed. */
const DRAG_INDUCED = 0.42;

// --------------------------------------------------------------- steering ----

/** Peak turn rate, rad/s, at the most agile speed. */
const STEER_RATE = 1.90;
/** Authority that survives even at a standstill, so the boat is never inert. */
const STEER_FLOOR = 0.12;
/** Authority ramps in over this speed fraction... */
const STEER_RISE = new THREE.Vector2(0.03, 0.34);
/** ...and sheds this fraction of itself over the top end. */
const STEER_FALL = new THREE.Vector2(0.55, 1.00);
const STEER_FALL_DEPTH = 0.44;
/** Airborne, the rudder and the jet are both in the air. */
const AIR_STEER = 0.16;
/** First-order lag on the turn rate. Lower feels heavier. */
const YAW_RESPONSE = 8.5;
/**
 * Lateral acceleration the chines can hold before the hull lets go, m/s^2.
 *
 * A turn of rate w at speed v demands v*w of lateral acceleration. Asking for
 * more than the hull can supply does not produce a tighter turn - it produces
 * slip - so the commanded rate is capped at `CORNER_ACCEL / v`. Without the cap
 * the fixed peak turn rate is simply unaffordable above about 13 m/s and the boat
 * sits in a permanent 30-degree slide, which destroys the contrast the drift
 * button is supposed to create.
 *
 * The value is the grip curve's own peak: GRIP_HIGH * SLIP_BREAK is 44, and the
 * hull holds a little over half of that before the knee.
 */
const CORNER_ACCEL = 24.0;
/** Drifting deliberately commands more rotation than the hull can hold. */
const DRIFT_CORNER_MULT = 1.35;
/** Below this speed the cap is meaningless; it would divide by nearly zero. */
const CORNER_MIN_SPEED = 4.0;

/**
 * Weathervane: the yaw moment a hull at a large slip angle generates against
 * itself, rad/s^2 at saturation.
 *
 * This is what separates a powerslide from a spin. Slide hard enough and the
 * nose keeps rotating past the velocity vector; nothing in the grip model stops
 * that, because grip only ever removes lateral speed, it never re-points the
 * hull. A real hull at 40 degrees of yaw is a barn door and swings back. Without
 * this term the boat reaches 70 degrees of slip and simply spins - measured, not
 * assumed: the tuning harness had it pirouetting at 12 m/s.
 *
 * It starts well past a committed grippy corner (which sits around 13 degrees) so
 * it never interferes with normal cornering.
 */
const WEATHERVANE = 2.9;
const WEATHER_START = 0.30;
const WEATHER_RANGE = 0.45;

// ------------------------------------------------------------------ grip -----

/**
 * Lateral friction coefficients, 1/s (they act on the slip velocity directly).
 * GRIP_HIGH gives a 0.095 s time constant - the hull simply does not slide. Past
 * the breakaway it falls to GRIP_LOW, a 0.31 s constant, which slides but still
 * generates enough side force to hold a stable slip angle.
 */
const GRIP_HIGH = 10.5;
const GRIP_LOW = 4.2;
/**
 * Slip speed at which grip is halfway down. Measured against the shipped sea:
 * 4.2 m/s is just past what a committed turn at three-quarter throttle produces
 * on grip alone, so an ordinary corner stays hooked up and the breakaway is
 * something the player reaches for rather than something that happens to them.
 */
const SLIP_BREAK = 4.2;
/** Sharpness of the collapse. 3 is a knee; 1 would be a shrug. */
const BREAK_SHARP = 3.0;
/** Grip multiplier while the drift button is held. */
const DRIFT_GRIP = 0.42;
/** Residual lateral resistance in the air. */
const AIR_LATERAL = 0.05;

// ----------------------------------------------------------------- drift -----

const DRIFT_MIN_SPEED = 7.0;
const DRIFT_MIN_STEER = 0.15;
/** Yaw impulse the unloaded stern contributes, rad/s^2. */
const DRIFT_KICK = 1.7;
/** Steering gain multiplier while drifting - the nose points further in. */
const DRIFT_STEER_GAIN = 1.30;
/** Charge per second at full slip and full speed. ~1.3 s for a maximum slide. */
const CHARGE_RATE = 1.05;
/** Slip speed that counts as "fully sideways" for charging purposes. */
const CHARGE_SLIP_REF = 8.0;
/** Tier thresholds. Crossing one is meant to be a moment the player feels. */
const DRIFT_TIERS: readonly number[] = [0.33, 0.66, 1.0];
/**
 * Boost meter paid out per tier. Deliberately non-linear: a scrappy half-charged
 * slide is worth almost nothing, and holding one all the way to tier 3 is worth
 * more than two tier-2 slides. That is the whole risk/reward of the mechanic.
 */
const TIER_PAYOUT: readonly number[] = [0.06, 0.24, 0.50, 0.85];

// ----------------------------------------------------------------- boost -----

/** Meter drained per second. A full meter is ~2.4 s of boost. */
const BOOST_DRAIN = 0.42;
const BOOST_MIN = 0.02;

// ----------------------------------------------------------- attitude --------

/**
 * Rotational inertia per unit mass, m^2. Pitch is close to L^2/12 for a 4.2 m
 * hull; roll is deliberately higher than B^2/12 because the rider, the engine and
 * the cowl all sit well above the waterline and a bare beam term rolls like a log.
 */
const INERTIA_PITCH = 1.55;
const INERTIA_ROLL = 0.40;
/** Extra rate damping on top of what the buoyancy dampers already provide. */
const PITCH_DAMP = 1.9;
const ROLL_DAMP = 2.0;
/** Squat under power: the bow lifts as the jet pushes, rad/s^2 at full thrust. */
const TRIM_ACCEL = 2.0;
/**
 * Planing trim, rad/s^2 at top speed, scaling with the square of speed.
 *
 * The hull's own hydrostatics settle it about 3 degrees bow-down (see the probe
 * table in `Buoyancy`) - correct for a displacement hull sitting still, and
 * completely wrong for a race boat at 30 m/s, where the whole point is that the
 * bottom is generating lift aft of the centre of mass and the nose is up. Left
 * alone the boat ploughed through the entire race at 10 degrees nose-down, which
 * is what made four boats on a rolling sea read as four boats on a flat one: a
 * hull that is always at the same wrong angle has no attitude to read.
 *
 * Against the pitch stiffness the probe table produces (about 92 rad/s^2 per
 * radian, but far less than that once the bow probe lifts clear) 6.5 measures out
 * at about 5 degrees of bow-up on the shipped course - level through the troughs,
 * standing on its pad down the straights. It was 17 for one tuning pass, which
 * pinned the hull against its own pitch limit for most of a lap: past the point
 * where the forefoot leaves the water there is nothing left to restore it.
 */
const PLANE_TRIM = 6.5;
/**
 * Dynamic lift off the planing surfaces, m/s^2 at top speed, likewise quadratic.
 *
 * It takes a third of the hull's weight off the buoyancy at racing speed, so the
 * boat rides high and light on a crest and settles deep the instant it loses
 * speed in a trough. That feeds straight back into the immersion-scaled drag
 * term, which is where the surge over a swell comes from.
 */
const PLANE_LIFT = 5.0;
/**
 * Pitch authority while airborne, rad/s^2, against a self-levelling spring that
 * pulls toward AIR_TRIM rather than toward flat.
 *
 * A boat coming off a crest with nothing held should arrive nose-high; that is
 * the pose the whole jump reads from, and the old spring drove it to 18 degrees
 * nose-down every single time. Now: hands off settles at AIR_TRIM (7 degrees
 * bow-up, a ballistic arc), and holding throttle drives it through to 7 degrees
 * nose-down for a clean knifing entry. The player picks the landing.
 */
const AIR_PITCH = 1.0;
const AIR_LEVEL = 4.2;
const AIR_TRIM = -0.12;
/**
 * Attitude limits. Past these the boat has stopped being a boat - and the roll
 * limit in particular is a *look* decision, not a safety net: 49 degrees of heel
 * on a hull with sponsons either side reads as capsizing, and it was reachable
 * whenever a wave face lined up with a committed corner.
 */
const MAX_PITCH = 0.62;
const MAX_ROLL = 0.60;
/** Bank into the turn, radians at full steer and full speed. */
const LEAN_STEER = 0.26;
/** Extra outboard lean from raw slip, so a powerslide visibly heels. */
const LEAN_SLIP = 0.14;
/** Stiffness of the spring that pulls roll toward the commanded lean. */
const LEAN_STIFF = 9.0;

// --------------------------------------------------------------- landing -----

/** Downward speed below which a touchdown is not an impact at all, m/s. */
const LAND_FLOOR = 2.5;
/** Downward speed that saturates the impact, m/s. */
const LAND_REF = 12.0;
/** Airtime that fully weights the impact. */
const LAND_AIR_REF = 1.0;
/** Fraction of forward speed a maximum flat landing scrubs. */
const LAND_SCRUB = 0.44;
/** Vertical momentum lost to splash on contact. */
const LAND_ABSORB = 0.55;

// ------------------------------------------------------------------ misc -----

/** Water flow push, 1/s applied to the sampled surface velocity. */
const FLOW_PUSH = 1.2;
/** How much of a collision separation becomes velocity, 1/s. */
const SEPARATION_VEL = 6.0;
/** Forward speed scrubbed by a maximum hull-to-hull hit. */
const HIT_SCRUB = 0.20;
/** Yaw jolt from a maximum hit, rad/s. */
const HIT_YAW = 2.2;

// ------------------------------------------------------------------ foam -----

/** Half-beam the wake ribbon starts at, before speed widens it. Sponson to sponson. */
const WAKE_HALF_BEAM = 0.86;
const WAKE_MIN_SPEED = 0.5;
/** Bow immersion above which the entry is punching through, not slicing. */
const BOW_PUNCH = 0.82;
const BOW_PUNCH_SPEED = 11.0;
/** Slip above which a drift starts throwing water. */
const DRIFT_SPRAY_SLIP = 4.5;

// --------------------------------------------------------------- scratch -----
// Module scope. `step()` and everything it calls allocate nothing.

const _sprayPos = new THREE.Vector3();
const _sprayDir = new THREE.Vector3();
const _wakePos = new THREE.Vector3();

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/** Smoothstep between an edge pair carried in a Vector2. */
function ramp(edges: THREE.Vector2, x: number): number {
  return smooth01((x - edges.x) / Math.max(1e-6, edges.y - edges.x));
}

export interface BoatPhysicsOptions {
  index: number;
  color: THREE.Color;
  foam: FoamSystem;
}

export class BoatPhysics {
  readonly state: BoatState = {
    position: new THREE.Vector3(),
    heading: 0,
    velocity: new THREE.Vector3(),
    speed: 0,
    speed01: 0,
    rpm: 0,
    slip: 0,
    drifting: false,
    driftCharge: 0,
    boostMeter: 0,
    boosting: false,
    airborne: false,
    airTime: 0,
    landingImpact: 0,
    hitImpact: 0,
    pitch: 0,
    roll: 0,
    heave: 0,
  };

  /** Smoothed steering, for the yoke and the rider's arms. */
  steerVisual = 0;
  /** Smoothed 0..1 boost plume intensity. */
  boostVisual = 0;

  private readonly buoy = new Buoyancy();
  private readonly bo: BuoyancyOutput = makeBuoyancyOutput();
  private readonly foam: FoamSystem;
  private readonly index: number;
  private readonly color: THREE.Color;

  private input: BoatInput = NEUTRAL_INPUT;

  private pitchRate = 0;
  private rollRate = 0;
  private yawRate = 0;

  private driftCharge = 0;
  private boostMeter = 0;
  private wasDrifting = false;
  private wasAirborne = false;

  private accum = 0;
  /**
   * The wave clock the substeps sample against, advanced one substep at a time.
   *
   * This is not a convenience. Feeding every substep the *frame's* elapsed time
   * makes the sea stand still for four substeps at 60 fps and move every substep
   * at 240, so the two frame rates sample different wave fields and the boats
   * diverge within a second - the interaction is chaotic enough that a millimetre
   * of difference in where the bow lands becomes metres a few seconds later.
   * Advancing per substep makes the sampled sequence identical at any frame rate.
   */
  private waveClock = 0;
  private clockPrimed = false;
  private pendingHit = 0;
  private pendingHitSide = 0;

  /** Per-frame accumulators for the once-a-frame foam emitters. */
  private sprayDrift = 0;
  private sprayBow = 0;

  constructor(opts: BoatPhysicsOptions) {
    this.index = opts.index;
    this.color = opts.color;
    this.foam = opts.foam;
  }

  setInput(input: BoatInput): void {
    this.input = input;
  }

  /** Places the hull at its floating equilibrium on the current sea. */
  reset(position: THREE.Vector3, heading: number, t = 0): void {
    const st = this.state;
    st.position.copy(position);
    // The buoyancy equilibrium puts the hull origin a little above the surface;
    // starting there means the boat does not visibly drop on the first frame.
    st.position.y = sampleHeight(position.x, position.z, t) + 0.06;
    st.heading = heading;
    st.velocity.set(0, 0, 0);
    st.speed = 0;
    st.speed01 = 0;
    st.rpm = 0;
    st.slip = 0;
    st.drifting = false;
    st.driftCharge = 0;
    st.boostMeter = 0;
    st.boosting = false;
    st.airborne = false;
    st.airTime = 0;
    st.landingImpact = 0;
    st.hitImpact = 0;
    st.pitch = 0;
    st.roll = 0;
    st.heave = 0;

    this.pitchRate = this.rollRate = this.yawRate = 0;
    this.driftCharge = 0;
    this.boostMeter = 0;
    this.wasDrifting = false;
    this.wasAirborne = false;
    this.accum = 0;
    this.waveClock = t;
    this.clockPrimed = false;
    this.pendingHit = 0;
    this.pendingHitSide = 0;
    this.sprayDrift = 0;
    this.sprayBow = 0;
    this.steerVisual = 0;
    this.boostVisual = 0;
    this.input = NEUTRAL_INPUT;
  }

  // ---------------------------------------------------------------- tick -----

  step(dt: number, elapsed: number): void {
    const st = this.state;
    // One-frame spikes are cleared here, at the top of the update that follows
    // the one that raised them - so a consumer running in late-update still sees
    // the value the physics wrote this frame.
    st.landingImpact = 0;
    st.hitImpact = 0;
    this.sprayDrift = 0;
    this.sprayBow = 0;

    // Re-anchor if the clock has slipped more than a couple of frames from the
    // engine's - a tab that was backgrounded, or a harness jump. Small drift is
    // left alone, because snapping it every frame would reintroduce exactly the
    // frame-rate coupling the clock exists to remove.
    const frameStart = elapsed - dt;
    if (!this.clockPrimed || Math.abs(this.waveClock - frameStart) > 0.05) {
      this.waveClock = frameStart;
      this.clockPrimed = true;
    }

    this.accum += dt;
    let n = 0;
    while (this.accum >= SUB_DT && n < MAX_SUBSTEPS) {
      this.substep(SUB_DT, this.waveClock);
      this.waveClock += SUB_DT;
      this.accum -= SUB_DT;
      n++;
    }
    // Backlog past the clamp is discarded rather than chased. See the file notes.
    if (n === MAX_SUBSTEPS && this.accum > SUB_DT) this.accum = 0;

    this.steerVisual += (this.input.steer - this.steerVisual) * Math.min(1, 11 * dt);
    // Published as an optional extra on the state object. `BoatState` is a shared
    // contract this module does not own, but the rider animator looks for a
    // `steer` field and falls back to differentiating the heading when it is
    // absent - and a differentiated heading on a boat that is being thrown
    // around by chop is a far noisier signal than the stick itself.
    (this.state as BoatState & { steer?: number }).steer = this.steerVisual;
    const boostGoal = st.boosting ? 1 : 0;
    this.boostVisual += (boostGoal - this.boostVisual) * Math.min(1, (st.boosting ? 16 : 7) * dt);

    this.emitFoam(dt);
  }

  private substep(h: number, t: number): void {
    const st = this.state;
    const inp = this.input;
    const b = this.buoy.sample(
      st.position, st.heading, st.pitch, st.roll,
      st.velocity, this.pitchRate, this.yawRate, this.rollRate,
      t, this.bo,
    );

    const airborne = b.submerged === 0;
    // How planted the hull is. Three of six probes wet is a boat under control;
    // fewer and the rudder, the jet and the chines all start losing their bite.
    const wet = Math.min(1, b.submerged / 3);
    const subm = b.submersion;

    // --- water re-entry ----------------------------------------------------
    let landingScrub = 0;
    if (this.wasAirborne && !airborne) {
      const fall = -st.velocity.y;
      const airFactor = Math.min(1, st.airTime / LAND_AIR_REF);
      const impact = clamp((fall - LAND_FLOOR) / (LAND_REF - LAND_FLOOR), 0, 1) *
        (0.4 + 0.6 * airFactor);
      if (impact > 0.02) {
        if (impact > st.landingImpact) st.landingImpact = impact;
        // Nose-down knifes in; flat or nose-high slaps the pad and scrubs. The
        // window is narrow on purpose - this is the skill in every jump.
        const flat = clamp(1 - (st.pitch - 0.05) / 0.30, 0, 1);
        landingScrub = LAND_SCRUB * impact * flat;
        // Slam the nose down a little, whichever way it came in. Small: the
        // buoyancy torque from a half-buried bow is already the dominant term,
        // and stacking a large impulse on top of it flips the boat end over end.
        // Smaller than it was, because the hull now arrives nose-high by default
        // and a big kick simply cancelled the pose the jump was for.
        this.pitchRate += impact * 0.55;
        this.emitLandingSpray(impact);
      }
      // Most of the vertical momentum goes into the splash rather than into
      // driving the hull under; without this a hard landing submarines.
      st.velocity.y *= LAND_ABSORB;
    }
    this.wasAirborne = airborne;
    st.airTime = airborne ? st.airTime + h : 0;

    // --- collision aftermath -----------------------------------------------
    let hitScrub = 0;
    if (this.pendingHit > 0) {
      hitScrub = HIT_SCRUB * this.pendingHit;
      this.yawRate += this.pendingHitSide * this.pendingHit * HIT_YAW;
      this.rollRate += this.pendingHitSide * this.pendingHit * 1.4;
      this.pendingHit = 0;
      this.pendingHitSide = 0;
    }

    // --- hull frame --------------------------------------------------------
    // heading 0 faces +Z: forward = (sin, 0, cos), starboard = (cos, 0, -sin).
    const sh = Math.sin(st.heading);
    const ch = Math.cos(st.heading);
    let vf = st.velocity.x * sh + st.velocity.z * ch;
    let vr = st.velocity.x * ch - st.velocity.z * sh;

    if (landingScrub > 0) vf *= 1 - landingScrub;
    if (hitScrub > 0) vf *= 1 - hitScrub;

    // Handling keys off how fast the boat is actually moving, not off how much
    // of that is pointing forward. Using vf alone makes a sideways boat behave
    // like a stationary one, which is how a slide turns into a pirouette.
    const hSpeed = Math.sqrt(vf * vf + vr * vr);
    const speedFrac = clamp(hSpeed / TOP_SPEED, 0, 1);

    // --- boost -------------------------------------------------------------
    let boosting = false;
    if (inp.boost && this.boostMeter > BOOST_MIN && !airborne) {
      boosting = true;
      this.boostMeter = Math.max(0, this.boostMeter - BOOST_DRAIN * h);
    }
    const topSpeed = TOP_SPEED * (boosting ? BOOST_TOP_MULT : 1);

    // --- thrust ------------------------------------------------------------
    // The jet only bites when the aft hull is in the water, which is what makes
    // a boat launched off a crest coast instead of accelerating in mid-air. The
    // gate saturates at a quarter immersion (10 cm) rather than ramping linearly:
    // a planing hull rides with its stern barely wetted by design, and a linear
    // gate would tax it for doing exactly the right thing.
    const jet = Math.min(1, b.aftWet * 4) * wet;
    const s01 = clamp(vf / topSpeed, 0, 1);
    let thrust = 0;
    if (inp.throttle > 0) {
      thrust = THRUST_MAX * (1 - THRUST_TAPER * s01 * s01) * inp.throttle;
    } else if (inp.throttle < 0 && vf > -REVERSE_TOP) {
      thrust = REVERSE_ACCEL * inp.throttle;
    }
    thrust *= jet;
    if (boosting) thrust += BOOST_THRUST * jet;

    // --- longitudinal drag -------------------------------------------------
    const dragScale = DRAG_SUB_BASE + DRAG_SUB_GAIN * subm;
    const drag = DRAG_F * vf * Math.abs(vf) * dragScale + DRAG_INDUCED * Math.abs(vr) * wet * Math.sign(vf);
    vf += (thrust - drag) * h;

    // --- drift state -------------------------------------------------------
    // The charge is banked against the *button*, not against the conditions. A
    // slide that momentarily straightens out over a crest, or dips under the
    // minimum speed in a trough, must not dump what the player has earned - that
    // reads as the game taking the charge away, and it is the single most
    // reliable way to make a drift mechanic feel unfair.
    const canDrift = !airborne && vf > DRIFT_MIN_SPEED && Math.abs(inp.steer) > DRIFT_MIN_STEER;
    const drifting = inp.drift && canDrift;
    if (drifting) {
      this.yawRate += DRIFT_KICK * Math.sign(inp.steer) * speedFrac * h;
      const bite = Math.min(1, Math.abs(vr) / CHARGE_SLIP_REF);
      this.driftCharge = Math.min(1, this.driftCharge + CHARGE_RATE * bite * speedFrac * h);
    }
    if (this.wasDrifting && !inp.drift) {
      let tier = 0;
      for (let i = 0; i < DRIFT_TIERS.length; i++) if (this.driftCharge >= DRIFT_TIERS[i]!) tier = i + 1;
      this.boostMeter = Math.min(1, this.boostMeter + TIER_PAYOUT[tier]!);
      this.driftCharge = 0;
    }
    if (drifting) this.wasDrifting = true;
    else if (!inp.drift) this.wasDrifting = false;

    // --- lateral grip ------------------------------------------------------
    const slipAbs = Math.abs(vr);
    let grip: number;
    if (airborne) {
      grip = AIR_LATERAL;
    } else {
      // A soft-shouldered inverse power law: flat and huge below the breakaway,
      // then a knee, then a floor. `pow` on a ratio keeps the knee's *position*
      // independent of the two coefficients, so they can be tuned separately.
      const k = 1 / (1 + Math.pow(slipAbs / SLIP_BREAK, BREAK_SHARP));
      grip = (GRIP_LOW + (GRIP_HIGH - GRIP_LOW) * k) * wet;
      if (drifting) grip *= DRIFT_GRIP;
    }
    vr -= grip * vr * h;

    // --- steering ----------------------------------------------------------
    // Rise, then partial fall: most agile around 40-55% of top speed, heavier
    // either side of it. A monotonic curve gives a boat that is either twitchy
    // everywhere or numb everywhere.
    const rise = ramp(STEER_RISE, speedFrac);
    const fall = 1 - STEER_FALL_DEPTH * ramp(STEER_FALL, speedFrac);
    let auth = STEER_FLOOR + (1 - STEER_FLOOR) * rise * fall;
    auth *= 0.35 + 0.65 * wet;
    if (airborne) auth *= AIR_STEER;
    let yawTarget = STEER_RATE * inp.steer * auth;
    if (drifting) yawTarget *= DRIFT_STEER_GAIN;
    // Clamp to the grip envelope - see CORNER_ACCEL. Airborne there is no
    // envelope to speak of, and AIR_STEER has already taken authority away.
    if (!airborne) {
      const cap = (CORNER_ACCEL * (drifting ? DRIFT_CORNER_MULT : 1)) /
        Math.max(CORNER_MIN_SPEED, hSpeed);
      if (yawTarget > cap) yawTarget = cap;
      else if (yawTarget < -cap) yawTarget = -cap;
    }
    // Backing up, the rudder works the other way round.
    if (vf < -0.5) yawTarget = -yawTarget;
    this.yawRate += (yawTarget - this.yawRate) * Math.min(1, YAW_RESPONSE * h);
    if (!airborne && hSpeed > 2) {
      // See WEATHERVANE. vr < 0 means the nose has over-rotated to starboard of
      // the velocity, so the restoring yaw is toward the sign of vr.
      const slipAngle = Math.atan2(vr, Math.max(1, Math.abs(vf)));
      const bite = smooth01((Math.abs(slipAngle) - WEATHER_START) / WEATHER_RANGE);
      this.yawRate += WEATHERVANE * Math.sign(vr) * bite * wet * h;
    }
    st.heading += this.yawRate * h;

    // --- back to world -----------------------------------------------------
    st.velocity.x = vf * sh + vr * ch;
    st.velocity.z = vf * ch - vr * sh;
    // A gentle shove from the swell itself. The grip and drag terms decay it to
    // near nothing at speed, so it only really shows when the boat is drifting
    // idle - which is exactly when water motion should be visible.
    st.velocity.x += b.flow.x * FLOW_PUSH * wet * h;
    st.velocity.z += b.flow.z * FLOW_PUSH * wet * h;

    // --- heave -------------------------------------------------------------
    // Planing lift is gated on the aft hull being wet for the same reason thrust
    // is: a bottom in mid-air is not generating anything.
    const plane = speedFrac * speedFrac * jet;
    st.velocity.y += (b.lift + PLANE_LIFT * plane - GRAVITY) * h;
    st.position.x += st.velocity.x * h;
    st.position.y += st.velocity.y * h;
    st.position.z += st.velocity.z * h;

    // --- pitch -------------------------------------------------------------
    this.pitchRate += (b.pitchTorque / INERTIA_PITCH) * h;
    // Squat: thrust lifts the bow, and so does the pad once the boat is planing.
    // Negative pitch is nose-up.
    this.pitchRate -= TRIM_ACCEL * (thrust / THRUST_MAX) * wet * h;
    this.pitchRate -= PLANE_TRIM * plane * h;
    if (airborne) {
      this.pitchRate += AIR_PITCH * inp.throttle * h;
      this.pitchRate -= (st.pitch - AIR_TRIM) * AIR_LEVEL * h;
    }
    this.pitchRate -= this.pitchRate * PITCH_DAMP * h;
    st.pitch += this.pitchRate * h;
    if (st.pitch > MAX_PITCH) { st.pitch = MAX_PITCH; if (this.pitchRate > 0) this.pitchRate = 0; }
    else if (st.pitch < -MAX_PITCH) { st.pitch = -MAX_PITCH; if (this.pitchRate < 0) this.pitchRate = 0; }

    // --- roll --------------------------------------------------------------
    this.rollRate += (b.rollTorque / INERTIA_ROLL) * h;
    // Positive roll lifts the starboard side, so turning right (steer > 0) wants
    // negative roll: the boat banks into its own turn.
    const leanTarget = -(LEAN_STEER * inp.steer * speedFrac + LEAN_SLIP * clamp(vr / 8, -1, 1)) * wet;
    this.rollRate += (leanTarget - st.roll) * LEAN_STIFF * h;
    this.rollRate -= this.rollRate * ROLL_DAMP * h;
    st.roll += this.rollRate * h;
    if (st.roll > MAX_ROLL) { st.roll = MAX_ROLL; if (this.rollRate > 0) this.rollRate = 0; }
    else if (st.roll < -MAX_ROLL) { st.roll = -MAX_ROLL; if (this.rollRate < 0) this.rollRate = 0; }

    // --- published state ---------------------------------------------------
    st.speed = vf;
    st.slip = vr;
    st.speed01 = clamp(vf / TOP_SPEED, 0, 1);
    st.drifting = drifting;
    st.driftCharge = this.driftCharge;
    st.boostMeter = this.boostMeter;
    st.boosting = boosting;
    st.airborne = airborne;
    st.heave = st.velocity.y;

    // --- engine note -------------------------------------------------------
    // A jet out of the water has nothing to push against, so it revs out. That
    // scream over a jump is most of what sells airtime through the speakers.
    let rpmTarget = 0.14 + 0.86 * clamp(Math.abs(vf) / topSpeed, 0, 1);
    if (inp.throttle <= 0 && !airborne) rpmTarget *= 0.62;
    if (airborne && inp.throttle > 0) rpmTarget = 1;
    if (boosting) rpmTarget = Math.min(1, rpmTarget + 0.12);
    st.rpm += (rpmTarget - st.rpm) * Math.min(1, 6 * h);

    // --- continuous spray accumulators -------------------------------------
    if (!airborne) {
      if (b.bowWet > BOW_PUNCH && vf > BOW_PUNCH_SPEED) {
        this.sprayBow += (b.bowWet - BOW_PUNCH) * st.speed01 * h;
      }
      if (slipAbs > DRIFT_SPRAY_SLIP) {
        this.sprayDrift += Math.min(1, (slipAbs - DRIFT_SPRAY_SLIP) / 6) * st.speed01 * h;
      }
    }
  }

  // ---------------------------------------------------------------- foam -----

  private emitLandingSpray(impact: number): void {
    // Thrown from the bow contact point, up and forward along the hull's travel.
    _sprayPos.set(
      this.buoy.worldX[BOW_PROBE]!,
      this.buoy.surfaceY[BOW_PROBE]!,
      this.buoy.worldZ[BOW_PROBE]!,
    );
    const st = this.state;
    _sprayDir.set(st.velocity.x * 0.16, 6.5 + impact * 7.0, st.velocity.z * 0.16);
    this.foam.emitSpray(_sprayPos, _sprayDir, 1.2 + impact * 2.6, this.color);
  }

  /** Once per frame: the wake ribbon plus whatever the substeps accumulated. */
  private emitFoam(dt: number): void {
    const st = this.state;
    if (st.airborne || Math.abs(st.speed) < WAKE_MIN_SPEED) return;

    // The ribbon is laid from the transom, on the surface rather than on the
    // hull - FoamSystem re-seats every spine point on the sea anyway, but a
    // stern that has lifted clear should not start the trail in mid-air.
    _wakePos.set(
      this.buoy.worldX[TRANSOM_PROBE]!,
      this.buoy.surfaceY[TRANSOM_PROBE]!,
      this.buoy.worldZ[TRANSOM_PROBE]!,
    );
    const slip01 = Math.min(1, Math.abs(st.slip) / 8);
    const halfWidth = WAKE_HALF_BEAM * (0.80 + 0.55 * st.speed01 + 0.35 * slip01);
    const strength = clamp(
      st.speed01 * 0.85 + slip01 * 0.35 + (st.boosting ? 0.15 : 0),
      0, 1,
    );
    this.foam.emitWake(this.index, _wakePos, st.heading, halfWidth, strength, dt);

    if (this.sprayBow > 1e-4) {
      _sprayPos.set(
        this.buoy.worldX[BOW_PROBE]!,
        this.buoy.surfaceY[BOW_PROBE]!,
        this.buoy.worldZ[BOW_PROBE]!,
      );
      // Thrown outward and up from the entry, at a fraction of hull speed.
      _sprayDir.set(st.velocity.x * 0.26, 4.2, st.velocity.z * 0.26);
      this.foam.emitSpray(_sprayPos, _sprayDir, this.sprayBow * 26, this.color);
    }

    if (this.sprayDrift > 1e-4) {
      // From the outboard aft quarter - the chine that is actually digging in.
      const side = st.slip > 0 ? 3 : 4; // slipping to starboard loads the port pad
      _sprayPos.set(
        this.buoy.worldX[side]!,
        this.buoy.surfaceY[side]!,
        this.buoy.worldZ[side]!,
      );
      const lat = Math.sign(st.slip);
      _sprayDir.set(
        Math.cos(st.heading) * lat * 3.4,
        4.6,
        -Math.sin(st.heading) * lat * 3.4,
      );
      this.foam.emitSpray(_sprayPos, _sprayDir, this.sprayDrift * 22, this.color);
    }
  }

  // ------------------------------------------------------------- external ----

  /** Positional nudge from the hull-separation pass in the composition root. */
  applySeparation(dx: number, dz: number): void {
    const st = this.state;
    st.position.x += dx;
    st.position.z += dz;
    st.velocity.x += dx * SEPARATION_VEL;
    st.velocity.z += dz * SEPARATION_VEL;
  }

  /**
   * Records a collision. The spike is published immediately so a consumer in
   * late-update sees it this frame; the physical response is applied on the next
   * substep, because collisions are resolved after the integration has run.
   */
  registerHit(mag: number): void {
    const m = clamp(mag, 0, 1);
    if (m <= 0) return;
    if (m > this.state.hitImpact) this.state.hitImpact = m;
    if (m > this.pendingHit) {
      this.pendingHit = m;
      // Kick the yaw away from whichever way the boat is already leaning, so two
      // boats that touch scatter rather than lock together.
      this.pendingHitSide = this.state.slip >= 0 ? 1 : -1;
    }
  }
}
