/**
 * Who is on the grid, and what makes each of them drive differently.
 *
 * A `Personality` is deliberately only three numbers. Three numbers is enough to
 * describe a driver in words - "brave, sloppy, streaky" - and few enough that the
 * grid stays readable at a glance instead of turning into a spreadsheet of
 * per-racer tuning knobs.
 *
 * The three numbers on their own do nothing. `deriveTuning()` expands them into
 * the ~20 concrete constants `AIController` actually drives with, and *that* is
 * where the personality becomes visible: how far ahead the driver looks, how much
 * lateral acceleration it believes the hull can hold, how late it brakes, how
 * often it slides, when it spends boost, how hard it fights for a line, and how
 * frequently it gets one wrong.
 *
 * The expansion is written so the traits pull against each other rather than all
 * feeding one "skill" scalar. Aggression buys corner entry speed but spends it on
 * slip; precision buys a longer horizon and smoother hands; consistency is the
 * only thing that keeps a mistake from happening. A driver who is aggressive and
 * imprecise is therefore *fast and scrappy*, not simply worse - which is the
 * whole point of having a grid.
 */

/** The public face of a racer's character. Index 0 of `PERSONALITIES` is the player. */
export interface Personality {
  name: string;
  /**
   * Willingness to spend the hull's grip and the boost meter *now*. Drives late
   * braking, corner-entry speed, drift usage, blocking and contact tolerance.
   */
  aggression: number;
  /**
   * Quality of the driver's model of the course. Drives lookahead distance,
   * apex accuracy, steering damping and how smoothly the stick moves.
   */
  precision: number;
  /**
   * How reliably the driver reproduces its own best lap. This is the *only*
   * input to mistake frequency and to the jitter on every threshold below.
   */
  consistency: number;
}

/**
 * The grid. Exactly four entries; slot 0 is the human.
 *
 * The player entry carries a call-sign and neutral traits so anything that
 * indexes personalities by racer slot (hull colours, HUD name plates, the
 * results table) can do so without a special case. Nothing reads the player's
 * three numbers - `AIController` is never constructed for slot 0.
 */
export const PERSONALITIES: Personality[] = [
  { name: 'Mako', aggression: 0.50, precision: 0.50, consistency: 0.50 },
  { name: 'Vex', aggression: 0.92, precision: 0.42, consistency: 0.30 },
  { name: 'Nori', aggression: 0.38, precision: 0.95, consistency: 0.92 },
  { name: 'Gus', aggression: 0.66, precision: 0.30, consistency: 0.18 },
];

// ---------------------------------------------------------------- tuning -----

/**
 * Everything `AIController` reads. One flat struct of named, unit-carrying
 * constants - the controller never does arithmetic on `aggression` directly, so
 * the mapping from character to behaviour lives in exactly one place and can be
 * re-tuned without touching the driving code.
 */
export interface DriverTuning {
  // --- steering geometry ---------------------------------------------------
  /** Lookahead at a standstill, metres. */
  lookaheadBase: number;
  /** Extra lookahead per m/s of speed. 0.9 puts the aim point ~1 s ahead. */
  lookaheadPerSpeed: number;
  /** Metres the driver cuts toward the inside of a corner at full curvature. */
  apexCut: number;
  /**
   * Amplitude of the slow lateral wander, metres. This is not noise for its own
   * sake - it is what makes a low-consistency driver take a visibly different
   * line every lap instead of tracing the same arc forever.
   */
  wander: number;
  /** Seconds for one full wander cycle. */
  wanderPeriod: number;

  // --- the hands -----------------------------------------------------------
  /** Proportional gain on heading error, steer units per radian. */
  steerP: number;
  /** Derivative gain on yaw rate, steer units per rad/s. Damps the P term. */
  steerD: number;
  /** Maximum stick movement per second. Low = smooth, high = snatchy. */
  steerSlew: number;

  // --- the right foot ------------------------------------------------------
  /**
   * Lateral acceleration the driver *believes* the hull will hold, m/s^2, used
   * to turn curvature into a corner speed. The hull's real limit is
   * `CORNER_ACCEL` = 24 in `BoatPhysics`, so a value above that is a driver who
   * habitually overdrives the entry and has to catch the slide.
   */
  cornerBudget: number;
  /**
   * Multiplier on the deceleration the driver plans around. Above 1 it believes
   * it can stop harder than it can, so it arrives hot - this is "late braking"
   * expressed as the thing that actually causes it rather than as a fudge.
   */
  brakeBias: number;
  /** How hard the lift is once it triggers, 0..1 of full closed throttle. */
  brakeDepth: number;
  /**
   * Scales how far down the road the braking solver looks. A brave driver
   * genuinely does not consider the corner after next; a careful one does.
   */
  brakeScan: number;

  // --- the powerslide ------------------------------------------------------
  /** |steer| that starts a slide, and the lower threshold that ends it. */
  driftEnter: number;
  driftExit: number;
  /** Minimum slide duration, seconds, so a slide always banks some charge. */
  driftHold: number;

  // --- the boost -----------------------------------------------------------
  /** Meter level the driver will spend at. Low = dumps it, high = hoards it. */
  boostAt: number;
  /** Random spread applied to `boostAt` each time the meter refills. */
  boostJitter: number;
  /**
   * How straight the road ahead must be before spending, 0..1, measured against
   * `STRAIGHT_REF` in `AIController`. A hoarder waits for a straight; a brawler
   * sits at 0 and spends it into the corner, then holds the slide.
   */
  boostStraightness: number;

  // --- racecraft -----------------------------------------------------------
  /** Strength of the lateral push away from a boat in the cone ahead. */
  avoidGain: number;
  /** Strength of the move to cover the inside line from a boat behind. */
  blockGain: number;

  // --- fallibility ---------------------------------------------------------
  /** Mean seconds between mistakes; the actual gap is rolled +/-50% of this. */
  mistakeGap: number;
  /** Scales both the size and the duration of a mistake. */
  mistakeScale: number;
  /** Nominal throttle-open delay at the green light, seconds. */
  reaction: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Expands a personality into driving constants.
 *
 * Every line below is a claim about how one trait shows up on screen, so they
 * are worth reading as a spec for the three AI:
 *
 *  - **Vex** (0.92 / 0.42 / 0.30) gets a `cornerBudget` of 27.4 against a hull
 *    that holds 24, a `brakeBias` of 1.20 and a `driftEnter` of 0.44. It arrives
 *    at every corner too fast, slides, and is paid in boost charge for it -
 *    which it then dumps at 0.12 of the meter, immediately, every time.
 *  - **Nori** (0.38 / 0.95 / 0.92) looks 16.5 m + 1.23/(m/s) ahead against Vex's
 *    11.2 m + 0.85, cuts 5.4 m of apex against Vex's 3.1, moves the stick at
 *    less than half Vex's rate, and will not touch the boost below 0.55 of the
 *    meter with a corner in sight. It is slower into a corner and quicker out.
 *  - **Gus** (0.66 / 0.30 / 0.18) has the shortest horizon, the least damping
 *    (`steerD` 0.32 against Nori's 0.67 - it visibly hunts), 2.9 m of lateral
 *    wander, and a mistake roughly every 9 s against Nori's 28.
 */
export function deriveTuning(p: Personality): DriverTuning {
  const { aggression: a, precision: pr, consistency: c } = p;
  // Sloppiness shows up in so many places it is worth naming once.
  const sloppy = 1 - c;

  return {
    // A precise driver plans further out. The per-speed term is the dominant one
    // at racing pace and is what keeps the aim point roughly a second ahead.
    lookaheadBase: lerp(9.5, 16.8, pr),
    lookaheadPerSpeed: lerp(0.72, 1.26, pr),
    // Apex cutting is an accuracy skill: you can only clip an apex you can see.
    apexCut: lerp(1.2, 5.6, pr),
    wander: 3.4 * sloppy,
    // Long enough that the wander reads as a driver drifting off line rather
    // than as a wobble, and prime-ish against the lap so it never syncs up.
    wanderPeriod: lerp(9.0, 5.5, sloppy),

    steerP: lerp(1.55, 2.75, pr),
    // The damping term is where "smooth" actually lives - without it a high P
    // gain simply oscillates, which is exactly what Gus is supposed to look like.
    steerD: lerp(0.14, 0.70, pr),
    steerSlew: lerp(4.2, 11.5, sloppy * 0.55 + (1 - pr) * 0.45),

    // 24 is the hull's real cornering limit (BoatPhysics.CORNER_ACCEL).
    cornerBudget: lerp(20.0, 28.2, a),
    brakeBias: lerp(0.98, 1.22, a),
    // A brave driver also brakes *harder* once it finally commits, because it
    // left itself less room. That is what makes a late brake look dramatic.
    brakeDepth: lerp(0.55, 1.0, a),
    brakeScan: lerp(1.18, 0.78, a),

    driftEnter: lerp(0.74, 0.42, a),
    driftExit: lerp(0.74, 0.42, a) - 0.20,
    // Long enough to clear the first payout tier. `CHARGE_RATE` is 1.05/s and
    // tier 1 wants 0.33, so a slide shorter than ~0.4 s banks the 0.06 booby
    // prize - which on screen is an AI that slides and gets nothing for it.
    driftHold: lerp(0.40, 0.75, a),

    // Hoarding is a precision trait; dumping is an aggression trait. A driver
    // high in both lands mid-table, which is the correct answer.
    boostAt: Math.max(0.08, 0.16 + 0.52 * pr - 0.24 * a),
    boostJitter: 0.42 * sloppy,
    // Nori (0.64) will not spend below a ~130 m radius, i.e. on a straight.
    // Vex and Gus both land on 0 - aggression cancels the requirement outright,
    // so they burn it the instant the meter clears their threshold, corner or not.
    boostStraightness: Math.max(0, 0.85 * pr - 0.45 * a),

    // Aggression buys the willingness to sit in someone's wake and lean on them.
    avoidGain: lerp(1.20, 0.42, a),
    // Only a genuinely aggressive driver bothers covering the inside line.
    blockGain: 1.15 * Math.max(0, a - 0.5) * 2,

    mistakeGap: lerp(5.0, 30.0, c),
    mistakeScale: lerp(0.34, 1.15, sloppy),
    // Brave off the line, but a streaky driver is also a streaky starter.
    reaction: Math.max(0.06, 0.34 - 0.26 * a + 0.12 * sloppy),
  };
}
