import * as THREE from 'three';
import { Engine } from './core/Engine';
import { Input } from './core/Input';
import { CameraRig } from './core/CameraRig';
import { rng, SEED, Rng } from './core/Rng';
import { PALETTE, RACER_COLORS } from './core/Palette';
import type { Racer, RaceStatus, BoatInput } from './core/types';

import { Sky } from './sky/Sky';
import { Ocean } from './ocean/Ocean';
import { FoamSystem } from './ocean/FoamSystem';
import { Course } from './race/Course';
import { RaceDirector } from './race/RaceDirector';
import { AIController } from './race/AIController';
import { PERSONALITIES } from './race/Personalities';
import { Boat } from './boat/Boat';
import { Rider } from './rider/Rider';
import { Composer } from './render/Composer';
import { Hud } from './ui/Hud';
import { Audio } from './audio/Audio';

/**
 * Composition root. Owns every subsystem and the order they tick in.
 * Nothing here implements gameplay - it wires the pieces together.
 */
export class Game {
  readonly engine: Engine;
  readonly input = new Input();
  readonly cameraRig: CameraRig;

  readonly sky: Sky;
  readonly ocean: Ocean;
  readonly foam: FoamSystem;
  readonly course: Course;
  readonly boats: Boat[] = [];
  readonly riders: Rider[] = [];
  readonly ai: AIController[] = [];
  readonly director: RaceDirector;
  readonly composer: Composer;
  readonly hud: Hud;
  readonly audio: Audio;

  player: Boat;

  constructor(container: HTMLElement, hudCanvas: HTMLCanvasElement) {
    this.engine = new Engine({ container });
    this.cameraRig = new CameraRig(this.engine.camera);

    const scene = this.engine.scene;
    scene.fog = new THREE.Fog(PALETTE.skyHorizon.getHex(), 260, 1750);

    // --- world -------------------------------------------------------------
    this.sky = new Sky(scene);
    this.ocean = new Ocean(scene, this.engine.camera);
    this.course = new Course(scene, rng.fork(11));
    this.foam = new FoamSystem(scene);

    // --- racers ------------------------------------------------------------
    const grid = this.course.gridSlots(4);
    for (let i = 0; i < 4; i++) {
      const slot = grid[i]!;
      const boat = new Boat({
        index: i,
        name: PERSONALITIES[i]!.name,
        isPlayer: i === 0,
        color: RACER_COLORS[i]!,
        rng: rng.fork(100 + i),
        foam: this.foam,
      });
      boat.reset(slot.position, slot.heading);

      // The rider is built here rather than inside Boat so the two systems stay
      // independent - Boat holds it through a structural type and never imports it.
      const rider = new Rider({ index: i, color: RACER_COLORS[i]!, rng: rng.fork(300 + i) });
      boat.riderMount.add(rider.root);
      rider.setYoke(boat.handleLeft, boat.handleRight);
      boat.rider = rider;
      this.riders.push(rider);

      scene.add(boat.root);
      this.boats.push(boat);
      if (i > 0) this.ai.push(new AIController(boat, this.course, PERSONALITIES[i]!, rng.fork(200 + i)));
    }
    this.player = this.boats[0]!;

    this.director = new RaceDirector(this.boats, this.course, 3);
    this.composer = new Composer(this.engine);
    this.hud = new Hud(hudCanvas);
    this.audio = new Audio();

    this.wire();
    this.cameraRig.snap(this.player, 0);
  }

  private wire(): void {
    const e = this.engine;

    e.onUpdate((dt, t) => {
      const status = this.director.status;

      // --- input -----------------------------------------------------------
      const raw = this.input.update(dt);
      if (this.autopilot && this.playerAI) {
        this.playerAI.update(dt, t, status, this.boats);
      } else {
        const playerInput: BoatInput =
          status.phase === 'racing' || status.phase === 'finished'
            ? raw
            : { throttle: 0, steer: 0, drift: false, boost: false };
        this.player.setInput(playerInput);
      }

      // --- AI ---------------------------------------------------------------
      for (const a of this.ai) a.update(dt, t, status, this.boats);

      // --- simulation -------------------------------------------------------
      for (const b of this.boats) b.update(dt, t);
      this.resolveBoatCollisions();
      this.director.update(dt, t);
      this.course.update(dt, t);
      this.foam.update(dt, t);
      // The foam system tracks where each hull is displacing water; the ocean
      // shader turns those into depth-difference foam rings. One array, no copy.
      this.ocean.setInteractors(this.foam.interactors);
      this.ocean.update(dt, t);
      this.sky.update(dt, t);
      this.audio.update(dt, this.player.state, this.director.status);
    });

    e.onLateUpdate((dt, t) => {
      this.cameraRig.update(dt, t, this.player, this.director.status);
      const st = this.player.state;
      if (st.landingImpact > 0.05) this.cameraRig.addShake(st.landingImpact * 0.55);
      if (st.hitImpact > 0.05) this.cameraRig.addShake(st.hitImpact * 0.4);
      this.ocean.follow(this.engine.camera);
      this.hud.render(this.boats, this.player, this.director.status, this.engine, this.course);
    });

    e.setRenderFn(() => this.composer.render());

    this.input.onRestart(() => this.restart());
  }

  /** Cheap sphere-ish separation between hulls; keeps races scrappy, not sticky. */
  private resolveBoatCollisions(): void {
    const R = 1.75;
    for (let i = 0; i < this.boats.length; i++) {
      for (let j = i + 1; j < this.boats.length; j++) {
        const a = this.boats[i]!;
        const b = this.boats[j]!;
        const dx = b.state.position.x - a.state.position.x;
        const dz = b.state.position.z - a.state.position.z;
        const d2 = dx * dx + dz * dz;
        const min = R * 2;
        if (d2 > min * min || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const nz = dz / d;
        const push = (min - d) * 0.5;
        a.applySeparation(-nx * push, -nz * push);
        b.applySeparation(nx * push, nz * push);
        const rel = Math.abs(a.state.speed - b.state.speed) + Math.abs(a.state.slip) + Math.abs(b.state.slip);
        const mag = Math.min(1, rel * 0.06 + push * 0.5);
        a.registerHit(mag);
        b.registerHit(mag);
      }
    }
  }

  /**
   * Hands the player's boat to an AI driver. Used by the screenshot harness so
   * captured frames show the game actually being raced - a stationary boat
   * cannot demonstrate a wake, a powerslide or a landing, which are exactly the
   * things the frames exist to verify.
   */
  setAutopilot(on: boolean): void {
    if (on && !this.playerAI) {
      this.playerAI = new AIController(this.player, this.course, PERSONALITIES[2]!, rng.fork(999));
    }
    this.autopilot = on;
  }

  private playerAI: AIController | null = null;
  private autopilot = false;

  restart(): void {
    const grid = this.course.gridSlots(4);
    for (let i = 0; i < this.boats.length; i++) {
      const slot = grid[i]!;
      this.boats[i]!.reset(slot.position, slot.heading);
    }
    this.director.reset();
    this.foam.clear();
    this.cameraRig.snap(this.player, this.engine.elapsed);
  }

  start(): void { this.engine.start(); }

  get status(): RaceStatus { return this.director.status; }
  get racers(): readonly Racer[] { return this.boats; }
}
