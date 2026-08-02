import type { Boat } from '../boat/Boat';
import type { RacePhase, RaceStatus } from '../core/types';
import type { Course } from './Course';

/**
 * The referee.
 *
 * Owns the phase machine, validates laps, decides who is where, and publishes
 * all of it into each boat's `RacerProgress`. Nothing else in the game writes
 * that struct; the HUD, the minimap, the camera and the AI all read it.
 *
 * Three decisions here are worth the words:
 *
 * **1. Laps are earned, not triggered.** A finish-line trigger is trivial to
 * defeat - drive a hundred metres up the course, turn around, drive back through
 * the line, repeat. So a lap only counts when every gate has been passed *in
 * order*, and a gate is only passed when the segment between last frame's
 * position and this frame's crosses its plane inside its width. The segment test
 * (rather than a proximity test) is what makes it tunnel-proof: at 42 m/s a boat
 * covers 0.7 m per frame, and a radius check small enough to be meaningful is
 * smaller than that.
 *
 * **2. Position comes from geometry, not from gates.** Gates are sparse; the
 * order changes continuously. Placement sorts on a *continuous* progress value
 * unwrapped from the course projection every frame, which is why an overtake
 * registers the instant a bow noses ahead rather than at the next checkpoint.
 *
 * **3. Progress is unwrapped, not summed.** The obvious `lap + splineT` steps
 * backwards by almost a whole lap every time the projection wraps past the line,
 * because the gate that increments `lap` and the wrap that resets `splineT` are
 * two different events that only *usually* land on the same frame. Integrating
 * the frame-to-frame delta instead is continuous by construction; the validated
 * lap counter then acts as a ceiling on it, which is what keeps a boat that cut
 * a gate from being scored as though it had taken it.
 */

// -------------------------------------------------------------- timings ------

/** Cinematic orbit before the lights. Long enough to read the course, short enough not to bore. */
const INTRO_TIME = 2.5;
/** The countdown starts here and counts down through zero. */
const COUNT_FROM = 3.0;
/**
 * How long "GO" stays up after the lights. `status.countdown` keeps counting
 * past zero into negative through this window and then clamps *exactly* on
 * -GO_HOLD, so the HUD's test is a clean `countdown > -GO_HOLD` with no epsilon:
 * `Math.max` returns the constant itself, bit for bit.
 */
const GO_HOLD = 0.9;
/** Beat between the last boat crossing the line and the results screen. */
const RESULTS_DELAY = 2.0;
/** ...and the backstop, in case someone is stranded facing the wrong way. */
const RESULTS_TIMEOUT = 30.0;

// ------------------------------------------------------------- wrong way -----

/** Backwards speed along the centreline that counts as going the wrong way, m/s. */
const WRONG_SPEED = 2.0;
/** Sustained seconds before the warning appears... */
const WRONG_ON = 0.7;
/** ...and before it clears. Asymmetric on purpose: a spin must not flicker it. */
const WRONG_OFF = 0.4;

// ------------------------------------------------------------- progress ------

/**
 * `splineT` is a sawtooth: it runs 0 -> 1 and drops back to 0 at the line. A
 * frame-to-frame delta larger than this can only be that drop rather than real
 * motion - half a lap in 16 ms is not physically available - so it is unwrapped
 * rather than integrated. Everything about placement rests on this.
 */
const SEAM_JUMP = 0.5;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// --------------------------------------------------------------- scratch -----
/**
 * The course direction at the racer most recently projected.
 *
 * `Course.project` hands back a pooled object it recycles after a few further
 * calls, so nothing here holds one across a call boundary; the two numbers the
 * wrong-way test needs are copied out of it the moment it arrives instead.
 */
let _tanX = 0;
let _tanZ = 1;

export interface RaceResult {
  racer: Boat;
  /** 1-based. Live running position until the racer finishes, then frozen. */
  place: number;
  /** Total race time, or null while still running. */
  time: number | null;
  /** The racer's own lap-time array, by reference - not a copy. */
  lapTimes: number[];
}

export class RaceDirector {
  readonly status: RaceStatus;

  /**
   * Live standings, re-ordered in place every frame so `results[0]` is the
   * leader. The entry objects are pooled per racer, so a reorder is four
   * pointer writes and allocates nothing.
   */
  readonly results: RaceResult[] = [];

  /**
   * Estimated seconds behind the current leader, indexed by racer slot. For a
   * finished racer this is the real time delta; for a running one it is the
   * distance still owed divided by that racer's own speed, which is the honest
   * answer to "how long until they are where the leader is now".
   */
  readonly gaps: number[] = [];

  /** Fastest validated lap of the race so far. `racer` is -1 until one is set. */
  readonly bestLap = { racer: -1, time: Number.POSITIVE_INFINITY };

  private readonly boats: Boat[];
  private readonly course: Course;
  private readonly n: number;

  /**
   * Index of the gate straddling the start/finish line - the one whose pass
   * closes a lap. Found rather than assumed, so a course laid out with its
   * spline origin somewhere other than the line still scores correctly.
   */
  private readonly startGate: number;
  private readonly gateCount: number;

  // --- per-racer bookkeeping ---------------------------------------------
  /** Last frame's projection parameter, fed back as the search hint. NaN = search wide. */
  private readonly hintT: Float32Array;
  private readonly prevX: Float32Array;
  private readonly prevZ: Float32Array;
  private readonly lapStart: Float32Array;
  /**
   * Unwrapped position in lap-space: continuous, monotone under forward motion,
   * and slightly negative on the grid because the grid is staged behind the
   * line. This is what `RacerProgress.total` publishes.
   */
  private readonly unwrapped: Float32Array;
  private readonly wrongTimer: Float32Array;
  private readonly finishPlace: Int32Array;
  /**
   * Only meaningful on a single-gate course, where the start line and the lap
   * line are the same plane and the first crossing is the start, not a lap.
   */
  private readonly lineArmed: Uint8Array;
  private readonly order: Int32Array;

  private phaseTimer = 0;
  private finishedCount = 0;
  /** Seconds since the player crossed the line; drives the results backstop. */
  private sinceFinish = 0;
  /** Seconds since the *last* racer crossed; drives the normal results beat. */
  private sinceLast = 0;
  /** Which gate is currently lit, so the course is only poked on a change. */
  private litGate = -1;

  constructor(boats: Boat[], course: Course, laps: number) {
    this.boats = boats;
    this.course = course;
    this.n = boats.length;
    this.status = { phase: 'intro', countdown: COUNT_FROM, raceTime: 0, totalLaps: laps };

    // Gates arrive in course order carrying their own arc-length parameter, so
    // the lap line is simply whichever one sits closest to the seam - measured
    // circularly, because a line at t = 0.998 is at the seam just as much as one
    // at t = 0.002 and a naive `min(t)` would pick the wrong gate.
    const gates = course.gates;
    this.gateCount = gates.length;
    let startGate = 0;
    let startDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < gates.length; i++) {
      const t = gates[i]!.t;
      const d = Math.min(t - Math.floor(t), 1 - (t - Math.floor(t)));
      if (d < startDist) { startDist = d; startGate = i; }
    }
    this.startGate = startGate;

    const n = this.n;
    this.hintT = new Float32Array(n);
    this.prevX = new Float32Array(n);
    this.prevZ = new Float32Array(n);
    this.lapStart = new Float32Array(n);
    this.unwrapped = new Float32Array(n);
    this.wrongTimer = new Float32Array(n);
    this.finishPlace = new Int32Array(n);
    this.lineArmed = new Uint8Array(n);
    this.order = new Int32Array(n);

    for (let i = 0; i < n; i++) {
      this.results.push({ racer: boats[i]!, place: i + 1, time: null, lapTimes: boats[i]!.progress.lapTimes });
      this.gaps.push(0);
    }

    this.reset();
  }

  // -------------------------------------------------------------- phases -----

  /**
   * The engine's `elapsed` is deliberately unused: every time in this file is
   * measured against `status.raceTime`, which starts at the green light rather
   * than at page load and survives a restart. Splits taken against the wall
   * clock would be off by however long the player spent looking at the title.
   */
  update(dt: number, _elapsed: number): void {
    const s = this.status;

    switch (s.phase) {
      case 'intro':
        this.phaseTimer += dt;
        // Parked at the top of the count so a HUD that scales on the fractional
        // part has a stable value to sit on during the flyover.
        s.countdown = COUNT_FROM;
        if (this.phaseTimer >= INTRO_TIME) this.enterCountdown();
        break;

      case 'countdown':
        s.countdown -= dt;
        if (s.countdown <= 0) this.enterRacing();
        break;

      case 'racing':
        s.raceTime += dt;
        s.countdown = Math.max(-GO_HOLD, s.countdown - dt);
        break;

      case 'finished':
        // The player is done; the rest of the grid is still out there and the
        // clock is still theirs.
        s.raceTime += dt;
        s.countdown = Math.max(-GO_HOLD, s.countdown - dt);
        this.sinceFinish += dt;
        break;

      case 'results':
        break;
    }

    const live = s.phase === 'racing' || s.phase === 'finished';
    if (live) {
      this.sinceLast += dt;
      for (let i = 0; i < this.n; i++) this.trackRacer(i, dt, s.raceTime);
    } else {
      // Off the clock the geometry still has to be right - the camera frames the
      // grid during the intro and the results screen reads the standings.
      for (let i = 0; i < this.n; i++) this.projectOnly(i);
    }

    this.rankAndPublish();
    this.syncGateLights();

    if (s.phase === 'finished') {
      const everyone = this.finishedCount >= this.n;
      if ((everyone && this.sinceLast >= RESULTS_DELAY) || this.sinceFinish >= RESULTS_TIMEOUT) {
        this.enterResults();
      }
    }
  }

  private enterCountdown(): void {
    this.status.phase = 'countdown';
    this.status.countdown = COUNT_FROM;
    this.phaseTimer = 0;
  }

  private enterRacing(): void {
    const s = this.status;
    // Only zero the clock if the race has not actually started yet - forcing
    // 'racing' from 'finished' (the harness does exactly this) must not rewind it.
    if (s.phase !== 'finished') s.raceTime = 0;
    s.phase = 'racing';
    // Whatever fraction of the frame the countdown overshot zero by is kept, so
    // the green light lands at the same instant at any frame rate.
    if (s.countdown > 0) s.countdown = 0;
    this.phaseTimer = 0;
    for (let i = 0; i < this.n; i++) {
      this.lapStart[i] = s.raceTime;
      // Re-seed the crossing test from where the boat is *now*, or the first
      // frame of the race compares against a stale position from the grid.
      const p = this.boats[i]!.state.position;
      this.prevX[i] = p.x;
      this.prevZ[i] = p.z;
    }
  }

  private enterFinished(): void {
    if (this.status.phase === 'finished' || this.status.phase === 'results') return;
    this.status.phase = 'finished';
    this.sinceFinish = 0;
  }

  private enterResults(): void {
    this.status.phase = 'results';
    this.phaseTimer = 0;
  }

  /** Harness / debug entry point: jump the machine straight to a phase. */
  forcePhase(p: RacePhase): void {
    switch (p) {
      case 'intro':
        this.status.phase = 'intro';
        this.status.countdown = COUNT_FROM;
        this.phaseTimer = 0;
        break;
      case 'countdown': this.enterCountdown(); break;
      case 'racing': this.enterRacing(); break;
      case 'finished':
        // Landing here has to leave a sane clock for the AI still racing, so
        // route through the normal start if we never actually left the grid.
        if (this.status.phase === 'intro' || this.status.phase === 'countdown') this.enterRacing();
        this.enterFinished();
        break;
      case 'results': this.enterResults(); break;
    }
  }

  // -------------------------------------------------------------- tracking ---

  /**
   * Projection only: spline parameter, lateral offset and the hint for next
   * frame. Runs in every phase, because the camera and the minimap need it
   * before the lights go out.
   *
   * The hint is what keeps this correct as well as cheap. A closed circuit
   * passes near itself; an unhinted nearest-point search will happily decide a
   * boat on the back straight is halfway round the lap the moment two sections
   * come within a hull's length of each other.
   */
  private projectOnly(i: number): void {
    const boat = this.boats[i]!;
    const pr = boat.progress;
    const proj = this.course.project(boat.state.position, this.hintT[i]!);
    this.hintT[i] = proj.t;
    pr.splineT = proj.t;
    pr.lateralOffset = proj.lateral;
    _tanX = proj.tangent.x;
    _tanZ = proj.tangent.z;
  }

  /** Full per-frame racer update: projection, gates, laps, wrong-way, progress. */
  private trackRacer(i: number, dt: number, raceTime: number): void {
    const boat = this.boats[i]!;
    const pr = boat.progress;
    const pos = boat.state.position;

    // Captured before the projection overwrites it - this is the whole basis of
    // the unwrap below.
    const lastT = pr.splineT;
    this.projectOnly(i);

    if (pr.finishTime === null) {
      this.checkGates(i, pos.x, pos.z, raceTime);
      this.checkWrongWay(i, dt);
    } else {
      pr.wrongWay = false;
    }

    this.prevX[i] = pos.x;
    this.prevZ[i] = pos.z;

    // --- monotone progress ------------------------------------------------
    let d = pr.splineT - lastT;
    if (d > SEAM_JUMP) d -= 1;
    else if (d < -SEAM_JUMP) d += 1;
    let u = this.unwrapped[i]! + d;
    // A racer can never be further round than one lap past their last
    // *validated* line crossing. Clamping here is what stops a boat that cut a
    // gate from being scored as though it had taken it: geometrically it is
    // ahead, but its position freezes on the line until it goes back and
    // completes the sequence properly.
    const ceiling = pr.lap + 1;
    if (u > ceiling) u = ceiling;
    this.unwrapped[i] = u;
    pr.total = u;
  }

  /**
   * Sequential checkpoint validation.
   *
   * Only the *next* gate can be passed, and only by a forward crossing of its
   * plane inside its width. Everything else - a gate taken out of order, a gate
   * clipped outside the pylons, a gate crossed backwards - is simply not a pass,
   * so `nextGate` sits where it is until the racer goes back and takes it
   * properly. That single rule is the whole anti-shortcut system.
   */
  private checkGates(i: number, x: number, z: number, raceTime: number): void {
    const gc = this.gateCount;
    if (gc === 0) return;

    const pr = this.boats[i]!.progress;
    const g = pr.nextGate;
    const gate = this.course.gates[g];
    if (!gate) return;

    // Read live: the gates are moored, and they bob and lean with the swell.
    const gx = gate.center.x;
    const gz = gate.center.z;
    const nx = gate.normal.x;
    const nz = gate.normal.z;

    // Signed distance to the plane, last frame and this frame.
    const d0 = (this.prevX[i]! - gx) * nx + (this.prevZ[i]! - gz) * nz;
    const d1 = (x - gx) * nx + (z - gz) * nz;
    if (!(d0 < 0 && d1 >= 0)) return; // not a forward crossing this frame

    // Where on the segment the plane was punched through. Solving for the exact
    // point rather than testing the endpoints is what stops a boat that clears
    // the pylons at 40 m/s from being judged on the frame it is already past them.
    const s = d0 / (d0 - d1);
    const ix = this.prevX[i]! + (x - this.prevX[i]!) * s;
    const iz = this.prevZ[i]! + (z - this.prevZ[i]!) * s;
    // Any perpendicular to the plane normal does; only the magnitude is tested.
    const lateral = (ix - gx) * nz - (iz - gz) * nx;
    if (Math.abs(lateral) > gate.halfWidth) return; // outside the pylons

    if (g === this.startGate) {
      // On a normal circuit `nextGate` can only come back round to the line
      // after every other gate has been taken, so arriving here *is* a lap.
      if (gc === 1 && this.lineArmed[i] === 0) {
        // Degenerate single-gate course: the first crossing is the start itself.
        this.lineArmed[i] = 1;
      } else {
        this.completeLap(i, raceTime);
      }
    }
    pr.nextGate = (g + 1) % gc;
  }

  private completeLap(i: number, raceTime: number): void {
    const boat = this.boats[i]!;
    const pr = boat.progress;

    const split = raceTime - this.lapStart[i]!;
    this.lapStart[i] = raceTime;
    pr.lapTimes.push(split);
    if (split < this.bestLap.time) { this.bestLap.time = split; this.bestLap.racer = i; }

    pr.lap++;
    this.sinceLast = 0;

    if (pr.lap >= this.status.totalLaps) {
      pr.finishTime = raceTime;
      this.finishPlace[i] = ++this.finishedCount;
      // The rider rig has a celebration pose; this is the only thing that asks
      // for it. Cleared again by `reset()`.
      boat.phaseOverride = 'celebrate';
      if (boat.isPlayer) this.enterFinished();
    }
  }

  /**
   * Wrong-way detection with asymmetric hysteresis.
   *
   * The signal is the component of world velocity along the course direction,
   * not the hull's heading - a boat can be pointing backwards mid-spin while
   * still travelling forwards, and warning it then would simply be wrong. The
   * warning needs WRONG_ON seconds of sustained reverse progress to appear and
   * only WRONG_OFF to clear, so a spin never blinks it and a genuine about-face
   * is unambiguous.
   */
  private checkWrongWay(i: number, dt: number): void {
    const boat = this.boats[i]!;
    const pr = boat.progress;
    const v = boat.state.velocity;
    // `_tanX/_tanZ` were copied out of this racer's projection a few lines
    // earlier in `trackRacer`; nothing between here and there projects again.
    const along = v.x * _tanX + v.z * _tanZ;
    const backwards = along < -WRONG_SPEED;

    if (!pr.wrongWay) {
      this.wrongTimer[i] = backwards ? this.wrongTimer[i]! + dt : 0;
      if (this.wrongTimer[i]! >= WRONG_ON) { pr.wrongWay = true; this.wrongTimer[i] = 0; }
    } else {
      this.wrongTimer[i] = backwards ? 0 : this.wrongTimer[i]! + dt;
      if (this.wrongTimer[i]! >= WRONG_OFF) { pr.wrongWay = false; this.wrongTimer[i] = 0; }
    }
  }

  // ------------------------------------------------------------- standings ---

  /**
   * Orders the grid and writes `place`, `results` and `gaps`.
   *
   * Insertion sort over an index array: at four racers it beats a comparator
   * sort outright, it is stable by construction, and it allocates nothing -
   * which `Array.prototype.sort` with a closure comparator would not manage.
   */
  private rankAndPublish(): void {
    const n = this.n;
    if (n === 0) return;
    const ord = this.order;
    for (let i = 0; i < n; i++) ord[i] = i;

    for (let k = 1; k < n; k++) {
      const v = ord[k]!;
      let j = k - 1;
      while (j >= 0 && this.ahead(v, ord[j]!)) { ord[j + 1] = ord[j]!; j--; }
      ord[j + 1] = v;
    }

    const lead = this.boats[ord[0]!]!;
    const leaderTotal = lead.progress.total;
    const leaderTime = lead.progress.finishTime;
    const lapLength = this.course.totalLength;

    for (let k = 0; k < n; k++) {
      const i = ord[k]!;
      const boat = this.boats[i]!;
      const pr = boat.progress;
      pr.place = k + 1;

      const entry = this.results[k]!;
      entry.racer = boat;
      entry.place = k + 1;
      entry.time = pr.finishTime;
      entry.lapTimes = pr.lapTimes;

      if (k === 0) {
        this.gaps[i] = 0;
      } else if (pr.finishTime !== null && leaderTime !== null) {
        // Both across the line: the gap is just the difference in race time.
        this.gaps[i] = pr.finishTime - leaderTime;
      } else {
        // Still running: distance owed, divided by how fast this racer is
        // covering it. The floor keeps a stationary boat from reporting an
        // unbounded gap the HUD would then have to special-case.
        const metres = (leaderTotal - pr.total) * lapLength;
        this.gaps[i] = Math.max(0, metres) / Math.max(6, boat.state.speed);
      }
    }
  }

  /** True if racer `a` should be placed ahead of racer `b`. */
  private ahead(a: number, b: number): boolean {
    const pa = this.boats[a]!.progress;
    const pb = this.boats[b]!.progress;
    const fa = pa.finishTime !== null;
    const fb = pb.finishTime !== null;
    // Anyone across the line outranks anyone still out on the course, and among
    // the finishers the order is the order they crossed in - never their total,
    // which keeps drifting after the flag.
    if (fa !== fb) return fa;
    if (fa && fb) return this.finishPlace[a]! < this.finishPlace[b]!;
    return pa.total > pb.total;
  }

  /**
   * Lights the player's next checkpoint and nothing else.
   *
   * One lamp lit at a time is the whole navigation aid on an open-water course:
   * with no track edges to read, the lit banner is what tells you which way the
   * circuit goes next. Cleared entirely once the race is over.
   */
  private syncGateLights(): void {
    let want = -1;
    const s = this.status.phase;
    if (s === 'countdown' || s === 'racing' || s === 'finished') {
      for (let i = 0; i < this.n; i++) {
        const boat = this.boats[i]!;
        if (!boat.isPlayer) continue;
        if (boat.progress.finishTime === null) want = boat.progress.nextGate;
        break;
      }
    }
    if (want === this.litGate) return;
    if (this.litGate >= 0) this.course.setGateLit(this.litGate, false);
    if (want >= 0) this.course.setGateLit(want, true);
    this.litGate = want;
  }

  // ----------------------------------------------------------------- reset ---

  /**
   * Back to the grid. The composition root resets the boats first and then calls
   * this, so the projections below are taken against the grid positions.
   */
  reset(): void {
    const s = this.status;
    s.phase = 'intro';
    s.countdown = COUNT_FROM;
    s.raceTime = 0;

    this.phaseTimer = 0;
    this.finishedCount = 0;
    this.sinceFinish = 0;
    this.sinceLast = 0;
    this.bestLap.racer = -1;
    this.bestLap.time = Number.POSITIVE_INFINITY;

    if (this.litGate >= 0) { this.course.setGateLit(this.litGate, false); this.litGate = -1; }

    for (let i = 0; i < this.n; i++) {
      const boat = this.boats[i]!;
      const pr = boat.progress;
      const pos = boat.state.position;

      pr.lap = 0;
      // The line is the plane the grid is already staged behind, so the first
      // crossing of it is the start, not a lap. Aiming at the gate *after* the
      // line is what makes that fall out of the sequential rule instead of
      // needing a special case (a single-gate course still needs one - see
      // `lineArmed`).
      pr.nextGate = this.gateCount > 1 ? (this.startGate + 1) % this.gateCount : 0;
      pr.wrongWay = false;
      pr.lapTimes.length = 0;
      pr.finishTime = null;
      pr.place = i + 1;

      // A non-finite hint is Course's signal for "no usable previous t": it
      // falls back to a strided scan of the whole table, which is exactly what
      // a fresh grid placement needs.
      const proj = this.course.project(pos, Number.NaN);
      this.hintT[i] = proj.t;
      pr.splineT = proj.t;
      pr.lateralOffset = proj.lateral;
      // The grid sits *behind* the start line, i.e. at the far end of the
      // parameter range, so seed lap-space one lap back. Without this every
      // racer's progress would fall off a cliff the instant they crossed the
      // line for the start.
      this.unwrapped[i] = proj.t > SEAM_JUMP ? proj.t - 1 : proj.t;
      pr.total = this.unwrapped[i]!;

      this.prevX[i] = pos.x;
      this.prevZ[i] = pos.z;
      this.lapStart[i] = 0;
      this.wrongTimer[i] = 0;
      this.finishPlace[i] = 0;
      this.lineArmed[i] = 0;
      this.gaps[i] = 0;

      boat.phaseOverride = null;

      const entry = this.results[i]!;
      entry.racer = boat;
      entry.place = i + 1;
      entry.time = null;
      entry.lapTimes = pr.lapTimes;
    }

    this.rankAndPublish();
  }

  // ----------------------------------------------------------------- reads ---

  /** Metres of course between two parameters, measured forwards from `a`. */
  arcBetween(a: number, b: number): number {
    let d = b - a;
    if (d < 0) d += 1;
    return d * this.course.totalLength;
  }

  /** Seconds the given racer is behind the leader, as displayed. */
  gapFor(index: number): number {
    return clamp(this.gaps[index] ?? 0, 0, 999);
  }

  /** The racer currently leading, or null on an empty grid. */
  get leader(): Boat | null {
    return this.n > 0 ? this.results[0]!.racer : null;
  }
}
