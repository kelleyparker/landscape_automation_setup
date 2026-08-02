import * as THREE from 'three';
import type { Racer, RacerProgress, BoatState, BoatInput } from '../core/types';
import { NEUTRAL_INPUT } from '../core/types';
import type { Rng } from '../core/Rng';
import type { FoamSystem } from '../ocean/FoamSystem';
import { buildBoatVisual, type BoatVisual } from './BoatMesh';
import { BoatPhysics } from './BoatPhysics';

/**
 * One racer: geometry, handling and whatever is riding it, wired together.
 *
 * The class itself is deliberately thin. `BoatMesh` owns everything about how
 * the boat looks, `BoatPhysics` owns everything about how it moves, and this is
 * the seam between them - it pushes the physics state onto the transform, drives
 * the two animated bits of hardware (the yoke and the boost plume), and ticks the
 * rider.
 *
 * The rider is held through a structural type rather than an import. `Rider`
 * needs `Boat` for its mount and its handle targets, so importing `Rider` here
 * would close a cycle; describing the one method that gets called avoids it
 * entirely and costs nothing, because the rider is constructed and attached from
 * the composition root either way.
 */

/**
 * Animation phases published to the rider. These describe what the *boat* is
 * doing, not what the race is doing - a rider braced for a landing looks the
 * same whether it is lap one or the last corner. A race-level phase can be
 * forced through `phaseOverride` when the director wants a celebration.
 */
export type BoatPhase = 'idle' | 'ride' | 'drift' | 'boost' | 'air' | 'land';

/** Structural view of the rider, kept minimal to avoid an import cycle. */
export interface BoatRider {
  update(dt: number, elapsed: number, state: BoatState, phase: string): void;
}

export interface BoatOptions {
  index: number;
  name: string;
  isPlayer: boolean;
  color: THREE.Color;
  rng: Rng;
  foam: FoamSystem;
}

/** Landing pose is held this long after touchdown, in seconds. */
const LAND_HOLD = 0.32;
/** Below this speed the rider idles rather than rides. */
const IDLE_SPEED = 1.6;

export class Boat implements Racer {
  readonly index: number;
  readonly name: string;
  readonly isPlayer: boolean;
  readonly color: THREE.Color;

  readonly state: BoatState;

  /** Owned and written by the race director; the boat only carries it. */
  readonly progress: RacerProgress = {
    lap: 0,
    splineT: 0,
    total: 0,
    place: 1,
    nextGate: 0,
    wrongWay: false,
    lapTimes: [],
    finishTime: null,
    lateralOffset: 0,
  };

  readonly root: THREE.Object3D;
  readonly riderMount: THREE.Object3D;
  /** Yoke grip targets for the rider's hand IK. Named on the scene graph too. */
  readonly handleLeft: THREE.Object3D;
  readonly handleRight: THREE.Object3D;

  rider: BoatRider | null = null;

  /** Set by the race director to force a pose ('celebrate', 'wipeout', ...). */
  phaseOverride: string | null = null;

  private readonly physics: BoatPhysics;
  private readonly visual: BoatVisual;
  private landTimer = 0;
  private phase: BoatPhase = 'idle';
  /**
   * Last wave clock seen. `reset()` takes no time argument (the composition root
   * calls it mid-race on a restart), but the hull has to be placed against the
   * sea *as it is now* or every boat pops a metre on the first frame after a
   * restart.
   */
  private lastElapsed = 0;
  /** Decaying collision flash, 0..1. */
  private hitFlash = 0;

  constructor(opts: BoatOptions) {
    this.index = opts.index;
    this.name = opts.name;
    this.isPlayer = opts.isPlayer;
    this.color = opts.color;

    this.physics = new BoatPhysics({ index: opts.index, color: opts.color, foam: opts.foam });
    this.state = this.physics.state;

    this.visual = buildBoatVisual(opts.index, opts.color);
    this.root = this.visual.root;
    this.riderMount = this.visual.riderMount;
    this.handleLeft = this.visual.handleLeft;
    this.handleRight = this.visual.handleRight;
    this.root.userData.racerIndex = opts.index;
  }

  // ---------------------------------------------------------------- control --

  setInput(input: BoatInput): void {
    this.physics.setInput(input);
  }

  reset(position: THREE.Vector3, heading: number): void {
    this.physics.setInput(NEUTRAL_INPUT);
    this.physics.reset(position, heading, this.lastElapsed);
    this.landTimer = 0;
    this.hitFlash = 0;
    this.phase = 'idle';
    this.phaseOverride = null;

    this.progress.lap = 0;
    this.progress.splineT = 0;
    this.progress.total = 0;
    this.progress.place = this.index + 1;
    this.progress.nextGate = 0;
    this.progress.wrongWay = false;
    this.progress.lapTimes.length = 0;
    this.progress.finishTime = null;
    this.progress.lateralOffset = 0;

    this.syncTransform();
    this.visual.setSteer(0);
    this.visual.setBoost(0, 0);
    this.visual.setHitFlash(0);
  }

  applySeparation(dx: number, dz: number): void {
    this.physics.applySeparation(dx, dz);
    // Collisions are resolved after the boats have already been transformed this
    // frame, so the nudge has to reach the scene graph immediately or the visual
    // hulls stay interpenetrated for a frame.
    this.root.position.copy(this.state.position);
  }

  registerHit(mag: number): void {
    this.physics.registerHit(mag);
  }

  // ------------------------------------------------------------------ tick ---

  update(dt: number, elapsed: number): void {
    this.lastElapsed = elapsed;
    this.physics.step(dt, elapsed);
    this.syncTransform();

    this.visual.setSteer(this.physics.steerVisual);
    this.visual.setBoost(this.physics.boostVisual, elapsed);
    // Hits are registered after every boat has been updated, so this picks the
    // spike up on the following frame - 16 ms behind an event the camera is
    // already shaking for, which is not a delay anyone can see.
    if (this.state.hitImpact > this.hitFlash) this.hitFlash = this.state.hitImpact;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 4.5);
    this.visual.setHitFlash(this.hitFlash);

    this.phase = this.derivePhase(dt);
    if (this.rider) this.rider.update(dt, elapsed, this.state, this.phaseOverride ?? this.phase);
  }

  private syncTransform(): void {
    const st = this.state;
    this.root.position.copy(st.position);
    // Rotation order is YXZ (set in BoatMesh): yaw, then pitch about the hull's
    // own lateral axis, then roll about its own long axis.
    this.root.rotation.set(st.pitch, st.heading, st.roll);
  }

  /**
   * Picks the pose the rider should be in. Ordering is a priority list, not a
   * state machine: airborne beats everything, a fresh landing beats a boost, and
   * "idle" only wins when nothing at all is happening.
   */
  private derivePhase(dt: number): BoatPhase {
    const st = this.state;
    if (st.landingImpact > 0.05) this.landTimer = LAND_HOLD;
    else this.landTimer = Math.max(0, this.landTimer - dt);

    if (st.airborne && st.airTime > 0.10) return 'air';
    if (this.landTimer > 0) return 'land';
    if (st.boosting) return 'boost';
    if (st.drifting) return 'drift';
    if (Math.abs(st.speed) < IDLE_SPEED) return 'idle';
    return 'ride';
  }

  /** Current derived pose, for the HUD or the harness. */
  get currentPhase(): string { return this.phaseOverride ?? this.phase; }

  /** Source triangles in one boat, for the harness's budget readout. */
  get triangles(): number { return this.visual.triangles; }

  dispose(): void {
    this.root.removeFromParent();
    this.visual.dispose();
  }
}
