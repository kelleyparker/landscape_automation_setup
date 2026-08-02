import * as THREE from 'three';

/**
 * Engine: owns the renderer, the scene graph root, the camera, the frame clock
 * and the adaptive resolution controller. It knows nothing about boats or water.
 *
 * Two stepping modes:
 *  - live:          requestAnimationFrame, variable dt clamped to a sane range.
 *  - deterministic: fixed dt driven by the harness, so a (seed, time) pair
 *                   reproduces a frame byte-for-byte.
 */

export interface EngineOptions {
  container: HTMLElement;
  /** Upper bound on devicePixelRatio. Retina caps at 2. */
  maxPixelRatio?: number;
  /** Target frame budget in ms before the adaptive scaler backs off. */
  frameBudgetMs?: number;
}

export type RenderHook = (dt: number, elapsed: number) => void;

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /**
   * Frame timing. Hand-rolled rather than THREE.Clock, which is deprecated in
   * r185 and logs a warning on construction. All we ever needed was a clamped
   * delta, and owning it means the harness's fixed-step mode and the live loop
   * share exactly one definition of "a frame".
   */
  private lastFrameMs = 0;
  private clockRunning = false;

  /** Everything that ticks, in registration order. */
  private readonly updaters: RenderHook[] = [];
  /** Runs after updates, before the draw call. Camera rigs live here. */
  private readonly lateUpdaters: RenderHook[] = [];
  /** Replaces the default `renderer.render` when post-processing is installed. */
  private renderFn: ((dt: number) => void) | null = null;

  elapsed = 0;
  frame = 0;
  /** Smoothed frame time in ms. */
  frameMs = 16.7;
  /** Current resolution scale applied on top of devicePixelRatio. */
  resolutionScale = 1;

  private readonly maxPixelRatio: number;
  private readonly frameBudgetMs: number;
  private running = false;
  private rafId = 0;
  private deterministic = false;
  private lastAdapt = 0;
  private readonly frameTimes: number[] = [];

  constructor(opts: EngineOptions) {
    this.maxPixelRatio = opts.maxPixelRatio ?? 2;
    this.frameBudgetMs = opts.frameBudgetMs ?? 16.7;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // we do our own edge work; MSAA fights the ink lines
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Linear workflow with a gentle filmic-free curve: cel art wants its
    // saturation intact, so no ACES. Tone mapping happens in the post stack.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(0x0f4fbd, 1);
    this.renderer.autoClear = true;
    this.renderer.shadowMap.enabled = false; // cel shadows are shader-side

    opts.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      58,
      window.innerWidth / window.innerHeight,
      0.35,
      4200
    );
    this.camera.position.set(0, 6, -14);
    this.camera.lookAt(0, 1, 0);

    window.addEventListener('resize', this.onResize);
  }

  // ------------------------------------------------------------- registry --
  onUpdate(fn: RenderHook): void { this.updaters.push(fn); }
  onLateUpdate(fn: RenderHook): void { this.lateUpdaters.push(fn); }
  setRenderFn(fn: (dt: number) => void): void { this.renderFn = fn; }

  // -------------------------------------------------------------- sizing ---
  private onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.applySize();
  };

  private applySize(): void {
    const base = Math.min(window.devicePixelRatio, this.maxPixelRatio);
    this.renderer.setPixelRatio(base * this.resolutionScale);
    this.renderer.setSize(window.innerWidth, window.innerHeight, true);
  }

  /** Effective drawing-buffer size, for post-process render targets. */
  get drawingBufferSize(): THREE.Vector2 {
    return this.renderer.getDrawingBufferSize(new THREE.Vector2());
  }

  /**
   * Adaptive pixel ratio. Watches a rolling window of frame times and nudges
   * the scale between 0.66 and 1.0 in small steps. Steps are deliberately slow
   * and hysteretic so the image never visibly pulses.
   */
  private adapt(nowMs: number): void {
    this.frameTimes.push(this.frameMs);
    if (this.frameTimes.length > 45) this.frameTimes.shift();
    if (nowMs - this.lastAdapt < 700 || this.frameTimes.length < 30) return;
    this.lastAdapt = nowMs;

    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)] as number;

    let next = this.resolutionScale;
    if (p90 > this.frameBudgetMs * 1.22) next = Math.max(0.66, next - 0.08);
    else if (p90 < this.frameBudgetMs * 0.78) next = Math.min(1, next + 0.05);

    if (Math.abs(next - this.resolutionScale) > 0.001) {
      this.resolutionScale = next;
      this.applySize();
    }
  }

  // --------------------------------------------------------------- loop ----
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameMs = performance.now();
    this.clockRunning = true;
    const loop = (): void => {
      this.rafId = requestAnimationFrame(loop);
      const dt = Math.min(this.tick(), 1 / 20);
      const t0 = performance.now();
      this.step(dt);
      const t1 = performance.now();
      this.frameMs += ((t1 - t0) - this.frameMs) * 0.12;
      this.adapt(t1);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.clockRunning = false;
  }

  /** Seconds since the previous call. Zero on the first frame after a start. */
  private tick(): number {
    const now = performance.now();
    if (!this.clockRunning) { this.lastFrameMs = now; this.clockRunning = true; return 0; }
    const dt = (now - this.lastFrameMs) / 1000;
    this.lastFrameMs = now;
    return dt;
  }

  /** One simulation + render step. */
  step(dt: number): void {
    this.elapsed += dt;
    this.frame++;
    for (let i = 0; i < this.updaters.length; i++) (this.updaters[i] as RenderHook)(dt, this.elapsed);
    for (let i = 0; i < this.lateUpdaters.length; i++) (this.lateUpdaters[i] as RenderHook)(dt, this.elapsed);
    if (this.renderFn) this.renderFn(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  /** Simulate without drawing - used to fast-forward to a harness moment. */
  simulateOnly(dt: number): void {
    this.elapsed += dt;
    this.frame++;
    for (let i = 0; i < this.updaters.length; i++) (this.updaters[i] as RenderHook)(dt, this.elapsed);
    for (let i = 0; i < this.lateUpdaters.length; i++) (this.lateUpdaters[i] as RenderHook)(dt, this.elapsed);
  }

  setDeterministic(on: boolean): void {
    this.deterministic = on;
    if (on) this.stop();
  }

  get isDeterministic(): boolean { return this.deterministic; }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
  }
}
