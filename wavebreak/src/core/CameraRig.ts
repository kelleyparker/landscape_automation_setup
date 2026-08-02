import * as THREE from 'three';
import type { Racer, RaceStatus, ShotContext } from './types';
import { sampleHeight } from '../ocean/GerstnerCPU';
import { SUN_DIR } from './Palette';

/**
 * Camera rig.
 *
 * Two responsibilities, deliberately kept in one file so the framing rules live
 * in one place:
 *
 * 1. The *gameplay* chase camera - critically damped spring on position, a
 *    softer spring on the look target, FOV that kicks with speed and harder with
 *    boost, positional shake on slams, and the cinematic orbit used during the
 *    countdown and the results screen. The rig deliberately lags the boat's
 *    *yaw* rather than snapping to it, which is what makes a turn read as a turn
 *    instead of the world spinning.
 *
 * 2. The *named shot rigs* the screenshot harness asks for by name. These are
 *    NOT offsets from the chase spring - each one is its own harness pose with
 *    its own altitude, lens and composition, recomputed from live boat state
 *    every frame so a shot stays locked while the sim runs under it.
 *
 * ## Composition
 *
 * Every rig places the camera, sets a lens, and then calls `frameSubject()`,
 * which aims so a chosen world point lands on a chosen *screen* coordinate.
 * That is what lets a rig say "hull on the left third, horizon on the upper
 * third" and actually get it, instead of pointing at the subject and hoping.
 * Aiming a metre in front of the bow is why every previous frame had the boat
 * dead centre with the horizon through the middle of it.
 */

const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _subject = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _ndc = new THREE.Vector3();
const _centroid = new THREE.Vector3();

/** Sun azimuth on the water plane, and its right-hand perpendicular. */
const _sunAz = new THREE.Vector3(SUN_DIR.x, 0, SUN_DIR.z).normalize();
const _sunRight = new THREE.Vector3(-_sunAz.z, 0, _sunAz.x);

export type CameraMode = 'chase' | 'orbit' | 'results' | 'free' | 'shot';

/** The named framings the harness (and the critic) can ask for. */
export type ShotName =
  | 'chase' | 'lowwater' | 'bow' | 'rider'
  | 'aerial' | 'horizon' | 'wake' | 'pack';

export const SHOT_NAMES: readonly ShotName[] = [
  'chase', 'lowwater', 'bow', 'rider', 'aerial', 'horizon', 'wake', 'pack',
];

function isShotName(s: string): s is ShotName {
  return (SHOT_NAMES as readonly string[]).indexOf(s) >= 0;
}

export class CameraRig {
  mode: CameraMode = 'chase';

  /** Spring state. */
  private pos = new THREE.Vector3(0, 8, -18);
  private vel = new THREE.Vector3();
  private target = new THREE.Vector3();
  private targetVel = new THREE.Vector3();
  private yaw = 0;

  private fov = 55;
  private shake = 0;
  private shakeSeed = 0;
  private orbitAngle = 0;
  private forceSnap = true;

  /** Active named shot while `mode === 'shot'`. */
  private shot: ShotName = 'chase';
  private shotRacers: readonly Racer[] = [];

  /**
   * Chase tunables. The camera sits off the boat's rear quarter rather than
   * dead astern: from directly behind, a 4.2 m hull presents only its 1.6 m
   * beam and reads as a 30 px smear. Swinging 17 deg round nearly doubles the
   * silhouette and turns the wake from a vertical column into a diagonal.
   */
  distance = 7.6;
  height = 3.0;
  /** Radians the camera is swung round the boat's stern. Negative = rear-left. */
  offAxis = -0.30;
  /** Where the hull sits on screen, 0..1 from the top-left. Left-third intersection. */
  frameX = 0.40;
  frameY = 0.60;
  baseFov = 52;
  maxFov = 68;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  /** Add a one-shot shake impulse, 0..1. */
  addShake(amount: number): void {
    this.shake = Math.min(1.4, this.shake + amount);
  }

  /** Names the harness may pass to `applyShot`. */
  listShots(): readonly ShotName[] { return SHOT_NAMES; }

  /**
   * Point the rig at a named framing. The pose is applied immediately and then
   * re-derived every `update()` while the shot is held, so the composition
   * survives the sim stepping underneath it.
   */
  applyShot(name: string, ctx: ShotContext): boolean {
    if (!isShotName(name)) return false;
    const player = ctx.player;
    if (!player) return false;
    this.shot = name;
    this.shotRacers = ctx.racers;
    if (name === 'chase') {
      // The chase shot must be the *gameplay* camera, springs and all, or it
      // proves nothing about what the player sees. Snap the springs so the
      // frame is deterministic rather than mid-settle.
      this.mode = 'chase';
      this.forceSnap = true;
      this.updateChase(1 / 60, ctx.elapsed, player);
    } else {
      this.mode = 'shot';
      this.updateShot(ctx.elapsed, player);
    }
    return true;
  }

  update(dt: number, elapsed: number, player: Racer | null, status: RaceStatus): void {
    if (!player) return;

    // 'free' means something outside the rig owns the camera this frame; 'shot'
    // means a named harness rig owns it. Neither may be stomped by the phase
    // machine - that is what collapsed all eight shots into one chase frame.
    if (this.mode === 'free') return;

    if (this.mode === 'shot') {
      this.updateShot(elapsed, player);
      this.applyShake(dt);
      return;
    }

    if (status.phase === 'countdown' || status.phase === 'intro') this.mode = 'orbit';
    else if (status.phase === 'results') this.mode = 'results';
    else this.mode = 'chase';

    if (this.mode === 'orbit') this.updateOrbit(dt, elapsed, player);
    else if (this.mode === 'results') this.updateResults(dt, elapsed, player);
    else this.updateChase(dt, elapsed, player);

    this.applyShake(dt);
  }

  private applyShake(dt: number): void {
    this.shake = Math.max(0, this.shake - dt * 2.6);
    if (this.shake <= 0.001) return;
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
    const dist = this.distance + speed01 * 1.7 + (st.boosting ? 1.2 : 0);
    const hgt = this.height + speed01 * 0.45 + st.airTime * 1.4;

    // Direction from boat to camera: astern, swung round the quarter.
    const a = this.yaw + Math.PI + this.offAxis;
    _desired.set(
      st.position.x + Math.sin(a) * dist,
      st.position.y + hgt,
      st.position.z + Math.cos(a) * dist
    );

    // Never let the camera go under the water surface.
    const waterY = sampleHeight(_desired.x, _desired.z, elapsed);
    if (_desired.y < waterY + 1.1) _desired.y = waterY + 1.1;

    // The subject is the hull itself, held on a thirds intersection. Aiming at
    // a point six metres past the bow is what parked the boat dead centre.
    _look.copy(st.position).add(_tmp.set(0, 0.85, 0));

    if (this.forceSnap) {
      this.pos.copy(_desired); this.vel.set(0, 0, 0);
      this.target.copy(_look); this.targetVel.set(0, 0, 0);
      this.forceSnap = false;
    } else {
      springTo(this.pos, this.vel, _desired, 9.5, dt);
      // Stiff enough that the hull holds its screen position through wave bob,
      // soft enough that a landing still throws the frame around.
      springTo(this.target, this.targetVel, _look, 13.0, dt);
    }

    this.camera.position.copy(this.pos);

    const fovTarget = this.baseFov + speed01 * 9 + (st.boosting ? 7 : 0) + st.airTime * 3;
    this.fov += (Math.min(this.maxFov, fovTarget) - this.fov) * Math.min(1, 4.0 * dt);
    this.applyFov();

    this.frameSubject(this.target, this.frameX, this.frameY);
    // A touch of roll into the turn + drift; small, but it reads.
    this.camera.rotateZ(-st.roll * 0.22 - Math.sign(st.slip) * Math.min(Math.abs(st.slip), 8) * 0.006);
  }

  // ------------------------------------------------------------------- shot -
  private updateShot(elapsed: number, player: Racer): void {
    const st = player.state;
    _fwd.set(Math.sin(st.heading), 0, Math.cos(st.heading));
    _right.set(-_fwd.z, 0, _fwd.x);
    switch (this.shot) {
      case 'lowwater': this.rigLowWater(elapsed, player); break;
      case 'bow': this.rigBow(elapsed, player); break;
      case 'rider': this.rigRider(elapsed, player); break;
      case 'aerial': this.rigAerial(elapsed, player); break;
      case 'horizon': this.rigHorizon(elapsed, player); break;
      case 'wake': this.rigWake(elapsed, player); break;
      case 'pack': this.rigPack(elapsed, player); break;
      default: this.rigLowWater(elapsed, player); break;
    }
  }

  /**
   * Eye 0.34 m above the *local* surface, off the boat's flank and slightly
   * astern, lens near level. From down here the crests between camera and
   * horizon are two to three metres taller than the eye, so the wave silhouette
   * breaks the horizon line instead of being looked down on.
   */
  private rigLowWater(elapsed: number, player: Racer): void {
    const st = player.state;
    _desired.copy(st.position).addScaledVector(_right, -6.4).addScaledVector(_fwd, -5.8);
    _desired.y = sampleHeight(_desired.x, _desired.z, elapsed) + 0.34;
    this.camera.position.copy(_desired);
    this.setFov(58);
    _subject.copy(st.position).add(_tmp.set(0, 0.75, 0));
    this.frameSubject(_subject, 0.63, 0.44);
  }

  /**
   * Front three-quarter, one metre off the water, four and a half metres out:
   * the bow tip sits in the near foreground and the hull rakes away from it.
   * The side is chosen so the camera looks into the sun and the hull gets its
   * rim.
   */
  private rigBow(elapsed: number, player: Racer): void {
    const st = player.state;
    const off = 0.46 * this.sunSide();
    const a = st.heading + off;
    _desired.set(
      st.position.x + Math.sin(a) * 4.6,
      0,
      st.position.z + Math.cos(a) * 4.6
    );
    _desired.y = Math.max(
      sampleHeight(_desired.x, _desired.z, elapsed) + 0.45,
      st.position.y + 1.02
    );
    this.camera.position.copy(_desired);
    this.setFov(44);
    _subject.copy(st.position).add(_tmp.set(0, 0.85, 0));
    this.frameSubject(_subject, 0.50, 0.60);
  }

  /**
   * Tight on the rider: a ~35 mm-equivalent lens at 4.4 m, eye just above the
   * yoke, three-quarter front so the visor, both hands and the lean all read.
   * Hull deliberately cropped - this shot exists to answer "is that a person",
   * and it cannot do that at 28 px.
   */
  private rigRider(elapsed: number, player: Racer): void {
    const st = player.state;
    const off = 0.62 * this.sunSide();
    const a = st.heading + off;
    _desired.set(
      st.position.x + Math.sin(a) * 3.6,
      st.position.y + 1.42,
      st.position.z + Math.cos(a) * 3.6
    );
    const w = sampleHeight(_desired.x, _desired.z, elapsed);
    if (_desired.y < w + 0.5) _desired.y = w + 0.5;
    this.camera.position.copy(_desired);
    this.setFov(29);
    // Rider mid-torso: seat is 0.235 above the hull origin, spine mid ~0.9 up.
    _subject.copy(st.position).add(_tmp.set(0, 1.06, 0));
    this.frameSubject(_subject, 0.46, 0.50);
  }

  /**
   * 65 m up, 89 m back on the quarter, wide lens. Steep enough to read as an
   * aerial (36 deg down onto the boat) yet still holding the horizon in the
   * upper quarter, which is the only way this frame can say anything about
   * tiling, LOD rings or where the ocean ends.
   */
  private rigAerial(elapsed: number, player: Racer): void {
    const st = player.state;
    _desired.copy(st.position)
      .addScaledVector(_fwd, -82)
      .addScaledVector(_right, 34);
    _desired.y = st.position.y + 65;
    this.camera.position.copy(_desired);
    this.setFov(62);
    _subject.copy(st.position).add(_tmp.set(0, 0.6, 0));
    this.frameSubject(_subject, 0.58, 0.74);
  }

  /**
   * Down the sun azimuth from three metres up, lens pitched up ~15 deg. Horizon
   * on the lower third, sun and flare in the upper quarter, the boat a small
   * backlit silhouette on the left - the opposite composition to chase.
   */
  private rigHorizon(elapsed: number, player: Racer): void {
    const st = player.state;
    _desired.copy(st.position)
      .addScaledVector(_sunAz, -26)
      .addScaledVector(_sunRight, 22);
    _desired.y = sampleHeight(_desired.x, _desired.z, elapsed) + 3.0;
    this.camera.position.copy(_desired);
    this.setFov(72);
    _subject.copy(st.position).add(_tmp.set(0, 0.6, 0));
    this.frameSubject(_subject, 0.36, 0.75);
  }

  /**
   * Twelve metres up, seventeen back, swung twenty degrees off the centreline
   * so the ribbon runs corner to corner instead of straight down the middle.
   * No horizon by design: this frame is about foam persistence and spread.
   */
  private rigWake(elapsed: number, player: Racer): void {
    const st = player.state;
    const a = st.heading + Math.PI + 0.35;
    _desired.set(
      st.position.x + Math.sin(a) * 17,
      st.position.y + 12.5,
      st.position.z + Math.cos(a) * 17
    );
    this.camera.position.copy(_desired);
    this.setFov(50);
    _subject.copy(st.position).add(_tmp.set(0, 0.5, 0));
    this.frameSubject(_subject, 0.62, 0.24);
  }

  /**
   * Low outside-line three-quarter on the whole pack: the field staggers in
   * depth across the frame instead of stacking into one wake, and the horizon
   * lands on the upper third so gate banners cross it at an angle rather than
   * lying on top of it.
   */
  private rigPack(elapsed: number, player: Racer): void {
    const racers = this.shotRacers.length ? this.shotRacers : null;
    _centroid.copy(player.state.position);
    let hx = Math.sin(player.state.heading);
    let hz = Math.cos(player.state.heading);
    if (racers) {
      _centroid.set(0, 0, 0);
      hx = 0; hz = 0;
      for (const r of racers) {
        _centroid.add(r.state.position);
        hx += Math.sin(r.state.heading);
        hz += Math.cos(r.state.heading);
      }
      const inv = 1 / racers.length;
      _centroid.multiplyScalar(inv);
      hx *= inv; hz *= inv;
    }
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl; hz /= hl;
    // Right-hand perpendicular to the pack's heading = the outside line.
    _desired.set(
      _centroid.x - hz * 20 + hx * 11,
      0,
      _centroid.z + hx * 20 + hz * 11
    );
    _desired.y = Math.max(
      sampleHeight(_desired.x, _desired.z, elapsed) + 1.2,
      _centroid.y + 6.9
    );
    this.camera.position.copy(_desired);
    this.setFov(46);
    _subject.copy(_centroid).add(_tmp.set(0, 0.8, 0));
    this.frameSubject(_subject, 0.40, 0.65);
  }

  /**
   * +1 or -1: which way to swing a front-quarter rig so the lens looks more
   * into the sun. A backlit hull gets a rim; a frontlit one gets a flat fill.
   *
   * A rig at `heading + off` sits along `fwd*cos(off) - right*sin(off)` and
   * looks back down that vector, so the sun is in front of the lens when that
   * offset direction opposes the sun azimuth. Only the sign of `off` is ours to
   * choose, and `sign(right . sun)` is the choice that helps.
   */
  private sunSide(): number {
    const s = _right.x * _sunAz.x + _right.z * _sunAz.z;
    return s >= 0 ? 1 : -1;
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
    this.fov += (52 - this.fov) * Math.min(1, 3 * dt);
    this.applyFov();
    this.frameSubject(this.target, 0.42, 0.56);
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
    _look.copy(st.position).add(_tmp.set(0, 1.1, 0));
    springTo(this.target, this.targetVel, _look, 5.0, dt);
    this.camera.position.copy(this.pos);
    this.fov += (46 - this.fov) * Math.min(1, 2 * dt);
    this.applyFov();
    this.frameSubject(this.target, 0.40, 0.58);
  }

  private setFov(f: number): void {
    this.fov = f;
    this.applyFov();
  }

  private applyFov(): void {
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Aim the camera so `target` lands at screen `(sx, sy)`, 0..1 from the
   * top-left, instead of dead centre.
   *
   * `lookAt` puts the subject on the optical axis, which is why every frame in
   * the last review had the hero object in the middle of the picture with the
   * horizon cutting through it. This nudges the aim point sideways in camera
   * space and re-solves; the coupling between the two axes is weak so it
   * converges in two or three passes. No allocation: all scratch is module
   * scope and `project` reuses the camera's matrices.
   */
  private frameSubject(target: THREE.Vector3, sx: number, sy: number): void {
    const cam = this.camera;
    const ndcX = sx * 2 - 1;
    const ndcY = 1 - sy * 2;
    const tanV = Math.tan(cam.fov * Math.PI / 360);
    const tanH = tanV * cam.aspect;
    _aim.copy(target);
    for (let i = 0; i < 4; i++) {
      cam.up.set(0, 1, 0);
      cam.lookAt(_aim);
      cam.updateMatrixWorld(true);
      _ndc.copy(target).project(cam);
      const ex = ndcX - _ndc.x;
      const ey = ndcY - _ndc.y;
      if (Math.abs(ex) < 2e-4 && Math.abs(ey) < 2e-4) break;
      const d = cam.position.distanceTo(target);
      const m = cam.matrixWorld.elements;
      // Camera right = column 0, up = column 1. Pushing the aim point left
      // swings the lens left, which slides the subject right on screen.
      _aim.x -= (m[0]! * ex * tanH + m[4]! * ey * tanV) * d;
      _aim.y -= (m[1]! * ex * tanH + m[5]! * ey * tanV) * d;
      _aim.z -= (m[2]! * ex * tanH + m[6]! * ey * tanV) * d;
    }
  }

  /** Snap the rig instantly (used on race reset and by the harness). */
  snap(player: Racer, elapsed: number): void {
    this.yaw = player.state.heading;
    this.vel.set(0, 0, 0);
    this.targetVel.set(0, 0, 0);
    this.forceSnap = true;
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
