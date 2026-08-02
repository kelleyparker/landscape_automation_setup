import * as THREE from 'three';
import type { Game } from '../Game';
import type { BoatInput } from '../core/types';

/**
 * The screenshot harness's entire surface area.
 *
 * `advanceTo()` steps the simulation at a fixed 1/60 without drawing, so a
 * (seed, time) pair reproduces an exact world state; `renderFrames()` then draws
 * that state. This is what makes "verify against a captured frame" meaningful -
 * the frame is repeatable, so a diff between two runs is a real regression.
 */

export interface ShotSpec {
  name: string;
  apply(g: Game, cam: THREE.PerspectiveCamera): void;
}

const _v = new THREE.Vector3();
const _f = new THREE.Vector3();

/** Camera setups the critic looks at. Each isolates a different claim. */
export const SHOTS: ShotSpec[] = [
  {
    // The money shot: what the player actually sees.
    name: 'chase',
    apply: (g) => { g.cameraRig.mode = 'chase'; g.cameraRig.update(1 / 60, g.engine.elapsed, g.player, g.status); },
  },
  {
    // Low, close to the water: judges wave silhouette, foam and band edges.
    name: 'lowwater',
    apply: (g, cam) => {
      g.cameraRig.mode = 'free';
      const s = g.player.state;
      _f.set(Math.sin(s.heading), 0, Math.cos(s.heading));
      cam.position.copy(s.position).addScaledVector(_f, -7).add(_v.set(2.2, 0.55, 0));
      cam.lookAt(s.position.x + _f.x * 12, s.position.y + 0.6, s.position.z + _f.z * 12);
      cam.fov = 62; cam.updateProjectionMatrix();
    },
  },
  {
    // Bow-on hero angle: judges hull outlines, rider pose, rim light.
    name: 'bow',
    apply: (g, cam) => {
      g.cameraRig.mode = 'free';
      const s = g.player.state;
      _f.set(Math.sin(s.heading), 0, Math.cos(s.heading));
      cam.position.copy(s.position).addScaledVector(_f, 9).add(_v.set(0, 2.1, 0));
      cam.lookAt(s.position.x, s.position.y + 0.9, s.position.z);
      cam.fov = 44; cam.updateProjectionMatrix();
    },
  },
  {
    // Tight on the rider: the pose has to read as a person, not a prop.
    name: 'rider',
    apply: (g, cam) => {
      g.cameraRig.mode = 'free';
      const s = g.player.state;
      _f.set(Math.sin(s.heading), 0, Math.cos(s.heading));
      const side = _v.set(_f.z, 0, -_f.x);
      cam.position.copy(s.position).addScaledVector(side, 3.6).addScaledVector(_f, 1.2);
      cam.position.y = s.position.y + 1.9;
      cam.lookAt(s.position.x, s.position.y + 1.15, s.position.z);
      cam.fov = 34; cam.updateProjectionMatrix();
    },
  },
  {
    // High and wide: judges the infinite ocean, tiling, LOD seams, horizon, sky.
    name: 'aerial',
    apply: (g, cam) => {
      g.cameraRig.mode = 'free';
      const s = g.player.state;
      _f.set(Math.sin(s.heading), 0, Math.cos(s.heading));
      cam.position.copy(s.position).addScaledVector(_f, -46).add(_v.set(0, 34, 0));
      cam.lookAt(s.position.x + _f.x * 90, 0, s.position.z + _f.z * 90);
      cam.fov = 60; cam.updateProjectionMatrix();
    },
  },
  {
    // Horizon-level: judges sky gradient, clouds, sun flare, fog blend.
    name: 'horizon',
    apply: (g, cam) => {
      g.cameraRig.mode = 'free';
      const s = g.player.state;
      cam.position.set(s.position.x, s.position.y + 3.2, s.position.z);
      cam.lookAt(s.position.x - 60, s.position.y + 16, s.position.z + 85);
      cam.fov = 66; cam.updateProjectionMatrix();
    },
  },
  {
    // The wake, from behind and above: judges ribbon persistence and spread.
    name: 'wake',
    apply: (g, cam) => {
      g.cameraRig.mode = 'free';
      const s = g.player.state;
      _f.set(Math.sin(s.heading), 0, Math.cos(s.heading));
      cam.position.copy(s.position).addScaledVector(_f, -17).add(_v.set(0, 9.5, 0));
      cam.lookAt(s.position.x - _f.x * 4, s.position.y, s.position.z - _f.z * 4);
      cam.fov = 55; cam.updateProjectionMatrix();
    },
  },
  {
    // The whole pack + course furniture: judges gates, race line, AI spacing.
    name: 'pack',
    apply: (g, cam) => {
      g.cameraRig.mode = 'free';
      const c = _v.set(0, 0, 0);
      for (const b of g.racers) c.add(b.state.position);
      c.multiplyScalar(1 / Math.max(1, g.racers.length));
      cam.position.set(c.x + 24, 16, c.z - 30);
      cam.lookAt(c.x, 0.5, c.z);
      cam.fov = 55; cam.updateProjectionMatrix();
    },
  },
];

export interface WavebreakHooks {
  ready: boolean;
  advanceTo(seconds: number): void;
  renderFrames(n: number): void;
  setShot(name: string): boolean;
  listShots(): string[];
  setInput(partial: Partial<BoatInput> | null): void;
  phase(name: string): void;
  stats(): Record<string, number | string>;
  game: Game;
}

export function installTestHooks(game: Game): void {
  const engine = game.engine;
  let simulated = 0;

  const hooks: WavebreakHooks = {
    ready: true,
    game,

    advanceTo(seconds: number): void {
      engine.setDeterministic(true);
      const step = 1 / 60;
      // Guard against a runaway request; 5 minutes of sim is plenty.
      const target = Math.min(seconds, 300);
      let guard = 0;
      while (simulated < target && guard++ < 20000) {
        engine.simulateOnly(step);
        simulated += step;
      }
    },

    renderFrames(n: number): void {
      for (let i = 0; i < n; i++) engine.step(1 / 60);
    },

    setShot(name: string): boolean {
      const shot = SHOTS.find((s) => s.name === name);
      if (!shot) return false;
      shot.apply(game, engine.camera);
      return true;
    },

    listShots(): string[] { return SHOTS.map((s) => s.name); },

    setInput(partial: Partial<BoatInput> | null): void {
      if (!partial) { game.input.scripted = null; return; }
      game.input.scripted = {
        throttle: 0, steer: 0, drift: false, boost: false, ...partial,
      };
    },

    phase(name: string): void { game.director.forcePhase(name as never); },

    stats(): Record<string, number | string> {
      const info = engine.renderer.info;
      return {
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        programs: info.programs?.length ?? 0,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        frameMs: Number(engine.frameMs.toFixed(2)),
        resolutionScale: Number(engine.resolutionScale.toFixed(3)),
        elapsed: Number(engine.elapsed.toFixed(2)),
        phase: game.status.phase,
        playerSpeed: Number(game.player.state.speed.toFixed(2)),
        playerLap: game.player.progress.lap,
      };
    },
  };

  (window as unknown as { __wavebreak: WavebreakHooks }).__wavebreak = hooks;
}
