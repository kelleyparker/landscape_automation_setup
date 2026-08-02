import * as THREE from 'three';
import type { Racer, RaceStatus } from './types';
import { sampleHeight } from '../ocean/GerstnerCPU';

/**
 * Chase camera.
 *
 * Critically damped spring on position, a separate softer spring on the look
 * target, FOV that kicks with speed and harder with boost, positional shake on
 * slams, and a cinematic orbit used during the countdown and the results screen.
 *
 * The rig deliberately lags the boat's *yaw* rather than snapping to it, which
 * is what makes a turn read as a turn instead of the world spinning.
 */

const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export type CameraMode = 'chase' | 'orbit' | 'results' | 'free';

export class CameraRig {
  mode: CameraMode = 'chase';

  /** Spring state. */
  private pos = new THREE.Vector3(0, 8, -18);
  private vel = new THREE.Vector3();
  private target = new THREE.Vector3();
  private targetVel = new THREE.Vector3();
  private yaw = 0;

  private fov = 58;
  private shake = 0;
  private shakeSeed = 0;
  private orbitAngle = 0;

  /** Tunables. */
  distance = 11.5;
  height = 4.15;
  baseFov = 58;
  maxFov = 78;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  /** Add a one-shot shake impulse, 0..1. */
  addShake(amount: number): void {
    this.shake = Math.min(1.4, this.shake + amount);
  }

  update(dt: number, elapsed: number, player: Racer | null, status: RaceStatus): void {
    if (!player) return;
    const st = player.state;

    if (status.phase === 'countdown' || status.phase === 'intro') this.mode = 'orbit';
    else if (status.phase === 'results') this.mode = 'results';
    else if (this.mode !== 'free') this.mode = 'chase';

    if (this.mode === 'orbit') this.updateOrbit(dt, elapsed, player);
    else if (this.mode === 'results') this.updateResults(dt, elapsed, player);
    else this.updateChase(dt, elapsed, player);

    // --- shake -------------------------------------------------------------
    this.shake = Math.max(0, this.shake - dt * 2.6);
    if (this.shake > 0.001) {
      this.shakeSeed += dt * 47;
      const s = this.shake * this.shake * 0.55;
      // Deterministic pseudo-noise: no Math.random in the render path.
      const nx = Math.sin(this.shakeSeed * 1.7) * Math.sin(this.shakeSeed * 0.53);
      const ny = Math.sin(this.shakeSeed * 2.3 + 1.7) * Math.sin(this.shakeSeed * 0.71);
      const nz = Math.sin(this.shakeSeed * 1.13 + 3.1) * Math.sin(this.shakeSeed * 0.91);
      this.camera.position.x += nx * s;
      this.camera.position.y += ny * s * 0.7;
      this.camera.position.z += nz * s;
      this.camera.rotateZ(nx * s * 0.035);
    }
  }

  // ------------------------------------------------------------------ chase -
  private updateChase(dt: number, elapsed: number, player: Racer): void {
    const st = player.state;

    // Yaw lags the hull so hard turns swing the world past the camera.
    let dy = st.heading - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    // Drifting lets the camera fall further behind, which sells the slide.
    const yawLag = st.drifting ? 3.1 : 5.4;
    this.yaw += dy * Math.min(1, yawLag * dt);

    const speed01 = st.speed01;
    const dist = this.distance + speed01 * 2.4 + (st.boosting ? 1.5 : 0);
    const hgt = this.height + speed01 * 0.85 + st.airTime * 1.6;

    _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    _desired.copy(st.position).addScaledVector(_fwd, -dist);
    _desired.y = st.position.y + hgt;

    // Never let the camera go under the water surface.
    const waterY = sampleHeight(_desired.x, _desired.z, elapsed);
    if (_desired.y < waterY + 1.1) _desired.y = waterY + 1.1;

    springTo(this.pos, this.vel, _desired, 9.5, dt);

    // Look a little ahead of the bow, and lift the target with speed so the
    // horizon stays high and the water fills the frame.
    _look.copy(st.position)
      .addScaledVector(_fwd, 6.5 + speed01 * 5.0)
      .add(_tmp.set(0, 1.35 + speed01 * 0.5, 0));
    springTo(this.target, this.targetVel, _look, 7.0, dt);

    this.camera.position.copy(this.pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    // A touch of roll into the turn + drift; small, but it reads.
    this.camera.rotateZ(-st.roll * 0.22 - Math.sign(st.slip) * Math.min(Math.abs(st.slip), 8) * 0.006);

    const fovTarget = this.baseFov + speed01 * 11 + (st.boosting ? 8 : 0) + st.airTime * 3;
    this.fov += (Math.min(this.maxFov, fovTarget) - this.fov) * Math.min(1, 4.0 * dt);
    this.applyFov();
  }

  // ------------------------------------------------------------------ orbit -
  private updateOrbit(dt: number, elapsed: number, player: Racer): void {
    this.orbitAngle += dt * 0.28;
    const st = player.state;
    const r = 13.5;
    const a = st.heading + Math.PI + Math.sin(this.orbitAngle) * 0.85 + this.orbitAngle * 0.35;
    _desired.set(
      st.position.x + Math.sin(a) * r,
      st.position.y + 3.4 + Math.sin(this.orbitAngle * 0.7) * 1.1,
      st.position.z + Math.cos(a) * r
    );
    const waterY = sampleHeight(_desired.x, _desired.z, elapsed);
    if (_desired.y < waterY + 1.0) _desired.y = waterY + 1.0;
    springTo(this.pos, this.vel, _desired, 5.5, dt);
    _look.copy(st.position).add(_tmp.set(0, 1.0, 0));
    springTo(this.target, this.targetVel, _look, 6.0, dt);
    this.camera.position.copy(this.pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    this.fov += (52 - this.fov) * Math.min(1, 3 * dt);
    this.applyFov();
  }

  // ---------------------------------------------------------------- results -
  private updateResults(dt: number, elapsed: number, player: Racer): void {
    this.orbitAngle += dt * 0.17;
    const st = player.state;
    const r = 9.5;
    const a = this.orbitAngle;
    _desired.set(
      st.position.x + Math.sin(a) * r,
      st.position.y + 2.9,
      st.position.z + Math.cos(a) * r
    );
    const waterY = sampleHeight(_desired.x, _desired.z, elapsed);
    if (_desired.y < waterY + 0.9) _desired.y = waterY + 0.9;
    springTo(this.pos, this.vel, _desired, 4.0, dt);
    _look.copy(st.position).add(_tmp.set(0, 1.2, 0));
    springTo(this.target, this.targetVel, _look, 5.0, dt);
    this.camera.position.copy(this.pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    this.fov += (46 - this.fov) * Math.min(1, 2 * dt);
    this.applyFov();
  }

  private applyFov(): void {
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Snap the rig instantly (used on race reset and by the harness). */
  snap(player: Racer, elapsed: number): void {
    this.yaw = player.state.heading;
    this.vel.set(0, 0, 0);
    this.targetVel.set(0, 0, 0);
    this.updateChase(1 / 60, elapsed, player);
    this.pos.copy(this.camera.position);
  }
}

/**
 * Critically damped spring. `omega` is the angular frequency; higher is stiffer.
 * Uses the semi-implicit form so it stays stable at large dt.
 */
function springTo(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  goal: THREE.Vector3,
  omega: number,
  dt: number
): void {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const det = 1 / (f + hhoo);
  const nx = (pos.x * f + vel.x * dt + goal.x * hhoo) * det;
  const ny = (pos.y * f + vel.y * dt + goal.y * hhoo) * det;
  const nz = (pos.z * f + vel.z * dt + goal.z * hhoo) * det;
  vel.set(
    (vel.x + hoo * (goal.x - pos.x)) * det,
    (vel.y + hoo * (goal.y - pos.y)) * det,
    (vel.z + hoo * (goal.z - pos.z)) * det
  );
  pos.set(nx, ny, nz);
}
