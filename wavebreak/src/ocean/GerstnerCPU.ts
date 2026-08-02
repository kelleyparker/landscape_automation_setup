import * as THREE from 'three';
import { TERMS, MAX_WAVE_HEIGHT, type WaveTerms } from './waveConfig';

/**
 * CPU mirror of the water vertex shader.
 *
 * Gerstner waves displace horizontally as well as vertically, so "the height at
 * world (x, z)" is not a direct evaluation - it is the inverse of a forward
 * map. We solve it with a short fixed-point iteration, which converges in 3-4
 * steps for the steepness values in `waveConfig` and is cheap enough to run for
 * ~30 sample points per frame (6 hull points x 5 boats).
 *
 * Everything that needs to touch the water - buoyancy, wake ribbons, the race
 * line, gates, spray - samples through here, so nothing ever clips.
 */

const _tmpDisp = new THREE.Vector3();

export interface SurfaceSample {
  /** World-space point on the surface directly "above" the query. */
  height: number;
  /** Surface normal (unit). */
  normal: THREE.Vector3;
  /** Horizontal Jacobian - < 1 at crests, used for foam and spray triggers. */
  jacobian: number;
}

/** Raw forward displacement for a *parameter* point (not a world point). */
export function displace(px: number, pz: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  let ox = 0, oy = 0, oz = 0;
  for (let i = 0; i < TERMS.length; i++) {
    const w = TERMS[i] as WaveTerms;
    const ph = w.k * (w.dx * px + w.dz * pz) + w.phase * t;
    const c = Math.cos(ph);
    const s = Math.sin(ph);
    const qa = w.q * w.a;
    ox += qa * w.dx * c;
    oz += qa * w.dz * c;
    oy += w.a * s;
  }
  return out.set(ox, oy, oz);
}

/**
 * Inverse-solve the parameter point whose displaced position lands on world
 * (wx, wz). Four iterations is visually exact at our steepness.
 */
function solveParam(wx: number, wz: number, t: number, out: { x: number; z: number }): void {
  let px = wx;
  let pz = wz;
  for (let i = 0; i < 4; i++) {
    displace(px, pz, t, _tmpDisp);
    px = wx - _tmpDisp.x;
    pz = wz - _tmpDisp.z;
  }
  out.x = px;
  out.z = pz;
}

const _param = { x: 0, z: 0 };

/** Height only - the common case, cheapest path. */
export function sampleHeight(wx: number, wz: number, t: number): number {
  solveParam(wx, wz, t, _param);
  let y = 0;
  for (let i = 0; i < TERMS.length; i++) {
    const w = TERMS[i] as WaveTerms;
    y += w.a * Math.sin(w.k * (w.dx * _param.x + w.dz * _param.z) + w.phase * t);
  }
  return y;
}

const _tangent = new THREE.Vector3();
const _binormal = new THREE.Vector3();

/** Full surface sample: height, analytic normal and crest compression. */
export function sampleSurface(
  wx: number,
  wz: number,
  t: number,
  out: SurfaceSample = { height: 0, normal: new THREE.Vector3(0, 1, 0), jacobian: 1 }
): SurfaceSample {
  solveParam(wx, wz, t, _param);
  const px = _param.x;
  const pz = _param.z;

  let y = 0;
  _tangent.set(1, 0, 0);
  _binormal.set(0, 0, 1);

  for (let i = 0; i < TERMS.length; i++) {
    const w = TERMS[i] as WaveTerms;
    const ph = w.k * (w.dx * px + w.dz * pz) + w.phase * t;
    const c = Math.cos(ph);
    const s = Math.sin(ph);
    const wa = w.k * w.a;
    y += w.a * s;
    _tangent.x += -w.q * w.dx * w.dx * wa * s;
    _tangent.y += w.dx * wa * c;
    _tangent.z += -w.q * w.dx * w.dz * wa * s;
    _binormal.x += -w.q * w.dx * w.dz * wa * s;
    _binormal.y += w.dz * wa * c;
    _binormal.z += -w.q * w.dz * w.dz * wa * s;
  }

  out.height = y;
  out.normal.crossVectors(_binormal, _tangent).normalize();
  out.jacobian = _tangent.x * _binormal.z - _tangent.z * _binormal.x;
  return out;
}

/**
 * Water velocity at a point - the time derivative of the displacement. Used to
 * push floating objects along with the swell so drifting reads as water motion
 * rather than a scripted slide.
 */
export function sampleFlow(wx: number, wz: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  solveParam(wx, wz, t, _param);
  let vx = 0, vy = 0, vz = 0;
  for (let i = 0; i < TERMS.length; i++) {
    const w = TERMS[i] as WaveTerms;
    const ph = w.k * (w.dx * _param.x + w.dz * _param.z) + w.phase * t;
    const c = Math.cos(ph);
    const s = Math.sin(ph);
    const qa = w.q * w.a * w.phase;
    vx += -qa * w.dx * s;
    vz += -qa * w.dz * s;
    vy += w.a * w.phase * c;
  }
  return out.set(vx, vy, vz);
}

export { MAX_WAVE_HEIGHT };
