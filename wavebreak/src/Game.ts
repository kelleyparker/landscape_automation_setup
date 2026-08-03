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
import { PauseMenu } from './ui/PauseMenu';
import { Settings } from './core/Settings';
import { PerfOverlay } from './debug/PerfOverlay';
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
  readonly settings = new Settings();
  readonly pauseMenu: PauseMenu;
  readonly perf: PerfOverlay;

  player: Boat;

  /**
   * Draw the HUD at all. Off produces a clean gameplay frame, which is what
   * store capsules and press art want - a cropped speedometer at the edge of a
   * capsule reads as a screenshot someone forgot to clean up.
   */
  hudEnabled = true;
  /** True while the pause menu owns input; the world renders but does not tick. */
  paused = false;
  private readonly hudCanvas: HTMLCanvasElement;

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
    this.hudCanvas = hudCanvas;
    this.audio = new Audio();

    this.pauseMenu = new PauseMenu(
      this.settings,
      () => { this.paused = false; },
      () => { this.paused = false; this.restart(); }
    );

    // ?debug starts it visible; F3 toggles. Constructed after the composer so
    // the GL context and its timer extension are already live.
    this.perf = new PerfOverlay(
      this.engine,
      typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug')
    );

    this.applySettings();
    this.wire();
    this.cameraRig.snap(this.player, 0);
  }

  private wire(): void {
    const e = this.engine;

    e.onUpdate((dt, t) => {
      if (this.paused) return;
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
      if (this.paused) {
        // Still draw: the menu sits over a live frame of the world, which keeps
        // the player oriented and costs nothing extra.
        this.drawOverlay(dt);
        return;
      }
      this.cameraRig.update(dt, t, this.player, this.director.status);
      const st = this.player.state;
      if (st.landingImpact > 0.05) this.cameraRig.addShake(st.landingImpact * 0.55);
      if (st.hitImpact > 0.05) this.cameraRig.addShake(st.hitImpact * 0.4);
      this.ocean.follow(this.engine.camera);
      this.drawOverlay(dt);
    });

    e.setRenderFn(() => {
      // The timer query must bracket the actual draw commands, which is why
      // this wraps the composer rather than living inside Engine.step.
      this.perf.beginFrame();
      this.composer.render();
      this.perf.endFrame();
    });

    this.input.onRestart(() => this.restart());

    // Escape toggles pause; the menu consumes navigation keys while open so the
    // boat never reads them.
    this.input.onKeyPress((code) => {
      if (this.pauseMenu.handleKey(code)) return true;
      if (code === 'F3') { this.perf.toggle(); return true; }
      if (code === 'Escape') { this.paused = true; this.pauseMenu.show(); return true; }
      return false;
    });

    // A racing game left running in a background tab or an alt-tabbed desktop
    // window is a real problem; rAF throttling only half-solves it.
    window.addEventListener('blur', () => {
      if (!this.paused && this.director.status.phase === 'racing') {
        this.paused = true;
        this.pauseMenu.show();
      }
    });
  }

  /** HUD + pause menu, drawn on the shared 2D overlay in that order. */
  private drawOverlay(dt: number): void {
    const ctx = this.hudCanvas.getContext('2d');
    if (this.hudEnabled) {
      this.hud.render(this.boats, this.player, this.director.status, this.engine, this.course);
    } else if (ctx) {
      ctx.clearRect(0, 0, this.hudCanvas.width, this.hudCanvas.height);
    }
    if (ctx && (this.pauseMenu.visible || this.paused)) {
      const dpr = this.hudCanvas.width / Math.max(1, window.innerWidth);
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.pauseMenu.render(ctx, window.innerWidth, window.innerHeight, dt);
      ctx.restore();
    }
    if (ctx && this.perf.visible) {
      const dpr = this.hudCanvas.width / Math.max(1, window.innerWidth);
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.perf.render(ctx, window.innerWidth, window.innerHeight);
      ctx.restore();
    }
  }

  /**
   * Push every setting at the thing it controls. Called once at construction
   * and on every change, so no setting can be silently inert.
   */
  private applySettings(): void {
    this.settings.onChange((s) => {
      this.engine.setMaxPixelRatio(s.resolutionScale);
      this.composer.setEnabled(s.edges, s.bloom);
      this.cameraRig.shakeScale = s.cameraShake;
      this.cameraRig.fovKickScale = s.fovKick;
      // Volume lands through whichever API the audio system exposes; mute is
      // the one guaranteed to exist.
      const audio = this.audio as unknown as { setMasterVolume?: (v: number) => void };
      audio.setMasterVolume?.(s.muted ? 0 : s.masterVolume);
      this.audio.setMuted(s.muted || s.masterVolume <= 0);
    });
  }

  /**
   * Cheap sphere-ish separation between hulls; keeps races scrappy, not sticky.
   *
   * Separation is applied every frame while hulls overlap - that is just
   * physics. The COLLISION EVENT is not, and that distinction was a real bug:
   * this used to call registerHit() on every overlapping frame, so two boats
   * running side by side generated a fresh impact 60 times a second. The audio
   * probe measured 198 "hits" in an 18-second race, each one spawning camera
   * shake and an audio one-shot. Continuous contact is a scrape, not a crash.
   *
   * An event now needs two things:
   *  - the hulls must be CLOSING along the contact normal, not merely touching.
   *    Boats drafting or sliding apart have no approach velocity and produce
   *    nothing, which is what stops the spam at its source.
   *  - a per-pair cooldown, so one collision is one event no matter how many
   *    frames the hulls stay tangled afterwards.
   */
  private resolveBoatCollisions(): void {
    const R = 1.75;
    /** m/s of approach below which contact is a scrape, not an impact. */
    const IMPACT_SPEED = 2.2;
    /** Seconds before the same pair may register a second impact. */
    const PAIR_COOLDOWN = 0.28;

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

        // Approach speed along the contact normal. Positive = closing.
        const closing =
          (a.state.velocity.x - b.state.velocity.x) * nx +
          (a.state.velocity.z - b.state.velocity.z) * nz;
        if (closing < IMPACT_SPEED) continue;

        const pair = i * 4 + j;
        if (this.engine.elapsed - (this.lastHitAt[pair] ?? -99) < PAIR_COOLDOWN) continue;
        this.lastHitAt[pair] = this.engine.elapsed;

        const mag = Math.min(1, closing / 14);
        a.registerHit(mag);
        b.registerHit(mag);
      }
    }
  }

  /** Last impact time per boat pair, indexed i*4+j. Module of the cooldown above. */
  private readonly lastHitAt: number[] = [];

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
