import type * as THREE from 'three';

/**
 * Cross-subsystem contracts. Every module that another module has to talk to
 * exposes itself through one of these. Keep this file dependency-free so it can
 * be imported from anywhere without cycles.
 */

/** Anything the game loop ticks. */
export interface Updatable {
  update(dt: number, elapsed: number): void;
}

/** Player / AI control intent, normalised. Physics only ever sees this. */
export interface BoatInput {
  /** -1 (reverse) .. 1 (full throttle). */
  throttle: number;
  /** -1 (left) .. 1 (right). */
  steer: number;
  /** Drift / powerslide held. */
  drift: boolean;
  /** Boost requested (only fires if the meter allows). */
  boost: boolean;
}

export const NEUTRAL_INPUT: BoatInput = { throttle: 0, steer: 0, drift: false, boost: false };

/** Read-only physical state of a boat, published for camera, HUD, AI, audio. */
export interface BoatState {
  position: THREE.Vector3;
  /** Facing yaw in radians, 0 = +Z. */
  heading: number;
  /** World-space linear velocity. */
  velocity: THREE.Vector3;
  /** Forward speed in m/s (can be negative). */
  speed: number;
  /** 0..1 normalised against top speed, for HUD + FOV + audio. */
  speed01: number;
  /** Engine RPM 0..1 for audio pitch. */
  rpm: number;
  /** Sideways slip in m/s; the drift signal. */
  slip: number;
  /** True while the powerslide is engaged and charging. */
  drifting: boolean;
  /** 0..1 charge accumulated in the current slide. */
  driftCharge: number;
  /** 0..1 stored boost. */
  boostMeter: number;
  /** True while boost is being spent. */
  boosting: boolean;
  /** True while no hull point is in the water. */
  airborne: boolean;
  /** Seconds of continuous airtime; 0 on the ground. */
  airTime: number;
  /** Set for one frame on water re-entry; magnitude of the slam 0..1. */
  landingImpact: number;
  /** Set for one frame on a collision; magnitude 0..1. */
  hitImpact: number;
  /** Hull pitch/roll in radians, driven by buoyancy. */
  pitch: number;
  roll: number;
  /** Vertical velocity, for the rider's crouch anticipation. */
  heave: number;
}

/** Per-racer progress along the course, owned by the race director. */
export interface RacerProgress {
  /** Lap index, 0-based, increments on crossing the line forwards. */
  lap: number;
  /** 0..1 along the spline this lap. */
  splineT: number;
  /** Monotonic total progress = lap + splineT, used for sorting positions. */
  total: number;
  /** 1-based finishing/running position. */
  place: number;
  /** Index of the next gate to pass. */
  nextGate: number;
  /** True while heading backwards along the spline. */
  wrongWay: boolean;
  /** Seconds for each completed lap. */
  lapTimes: number[];
  /** Total race time once finished, else null. */
  finishTime: number | null;
  /** Signed metres from the racing line; + is right of the line. */
  lateralOffset: number;
}

export interface Racer {
  readonly index: number;
  readonly name: string;
  readonly isPlayer: boolean;
  readonly color: THREE.Color;
  readonly state: BoatState;
  readonly progress: RacerProgress;
  /** Root object for the hull; riders and outlines parent under it. */
  readonly root: THREE.Object3D;
  setInput(input: BoatInput): void;
}

/** Race phase machine. */
export type RacePhase = 'intro' | 'countdown' | 'racing' | 'finished' | 'results';

export interface RaceStatus {
  phase: RacePhase;
  /** Seconds remaining in the countdown, 3..0. */
  countdown: number;
  /** Seconds since the green light. */
  raceTime: number;
  totalLaps: number;
}

/** Named camera setups the screenshot harness can request. */
export interface ShotDefinition {
  name: string;
  apply(camera: THREE.PerspectiveCamera, ctx: ShotContext): void;
}

export interface ShotContext {
  player: Racer | null;
  racers: readonly Racer[];
  elapsed: number;
}

/** Anything that wants to know the water surface. */
export interface WaterProbe {
  heightAt(x: number, z: number, t: number): number;
}
