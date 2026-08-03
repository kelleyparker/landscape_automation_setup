import * as THREE from 'three';
import type { Game } from '../Game';
import type { BoatInput } from '../core/types';
import { SHOT_NAMES } from '../core/CameraRig';

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

/**
 * Camera setups the critic looks at. Each isolates a different claim.
 *
 * The poses themselves live in `CameraRig.applyShot` - a shot is a rig, not a
 * one-frame camera nudge. Posing the camera from here was the bug that made all
 * eight named shots come out as the same chase frame: the rig's `update()` ran
 * again on every rendered frame and overwrote whatever this file had set.
 */
export const SHOTS: ShotSpec[] = SHOT_NAMES.map((name) => ({
  name,
  apply: (g: Game) => {
    g.cameraRig.applyShot(name, {
      player: g.player,
      racers: g.racers,
      elapsed: g.engine.elapsed,
    });
  },
}));

export interface WavebreakHooks {
  ready: boolean;
  advanceTo(seconds: number): void;
  renderFrames(n: number): void;
  setShot(name: string): boolean;
  listShots(): string[];
  setInput(partial: Partial<BoatInput> | null): void;
  phase(name: string): void;
  autopilot(on: boolean): void;
  setHud(on: boolean): void;
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

    autopilot(on: boolean): void { game.setAutopilot(on); },

    setHud(on: boolean): void { game.hudEnabled = on; },

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
