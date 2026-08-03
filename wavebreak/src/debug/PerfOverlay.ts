import type { Engine } from '../core/Engine';
import { CSS } from '../core/Palette';

/**
 * Frame-time overlay, toggled with F3 or `?debug`.
 *
 * The point of this file is the GPU number. `Engine.frameMs` measures how long
 * the JavaScript took to *submit* a frame, which on a GPU-bound renderer like
 * this one is close to meaningless - the CPU can finish issuing draw calls in
 * 3ms while the GPU is still shading for 20. Every performance figure quoted in
 * this project so far came either from that CPU clock or from SwiftShader in a
 * headless container, so none of it says anything about real hardware.
 *
 * `EXT_disjoint_timer_query_webgl2` gives the real elapsed GPU time for a range
 * of commands. It is asynchronous - results are not available for a frame or
 * three - so queries are pooled and drained as they become ready. The extension
 * is unavailable in some browsers (Safari notably); the overlay degrades to CPU
 * time and says so rather than showing a confident wrong number.
 */

interface TimerExt {
  createQueryEXT?: () => WebGLQuery;
  QUERY_COUNTER_BITS_EXT?: number;
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

const HISTORY = 120;

export class PerfOverlay {
  visible: boolean;

  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerExt | null;

  /** Queries in flight, oldest first. */
  private readonly pending: WebGLQuery[] = [];
  private readonly freeQueries: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  private gpuMs = 0;
  private readonly cpuHistory = new Float32Array(HISTORY);
  private readonly gpuHistory = new Float32Array(HISTORY);
  private cursor = 0;

  constructor(private readonly engine: Engine, visible = false) {
    this.visible = visible;
    this.gl = engine.renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  }

  get hasGpuTiming(): boolean { return this.ext !== null; }

  toggle(): void { this.visible = !this.visible; }

  /** Call immediately before the frame's draw commands. */
  beginFrame(): void {
    if (!this.visible || !this.ext || this.active) return;
    const q = this.freeQueries.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.active = q;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
  }

  /** Call immediately after the frame's draw commands. */
  endFrame(): void {
    if (!this.active || !this.ext) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
    this.drain();
  }

  /**
   * Collect any finished queries. A disjoint event means the GPU was
   * interrupted (power state change, another context) and every in-flight
   * result is garbage, so they are dropped rather than reported.
   */
  private drain(): void {
    if (!this.ext) return;
    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    if (disjoint) {
      for (const q of this.pending) this.freeQueries.push(q);
      this.pending.length = 0;
      return;
    }
    while (this.pending.length) {
      const q = this.pending[0]!;
      const available = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE);
      if (!available) break;
      const ns = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT) as number;
      // Exponential smoothing: a raw per-frame GPU time is too jumpy to read.
      this.gpuMs += (ns / 1e6 - this.gpuMs) * 0.15;
      this.pending.shift();
      this.freeQueries.push(q);
      // Cap the pool; three in flight is plenty for a 1-2 frame latency.
      if (this.freeQueries.length > 4) this.gl.deleteQuery(this.freeQueries.pop()!);
    }
  }

  /** Draw onto the shared 2D overlay. Called after the HUD. */
  render(ctx: CanvasRenderingContext2D, w: number, _h: number): void {
    if (!this.visible) return;

    const e = this.engine;
    this.cpuHistory[this.cursor] = e.frameMs;
    this.gpuHistory[this.cursor] = this.gpuMs;
    this.cursor = (this.cursor + 1) % HISTORY;

    const info = e.renderer.info;
    const PAD = 12;
    const W = 260;
    const H = 132;
    const x = w - W - PAD;
    const y = PAD;

    ctx.save();
    ctx.globalAlpha = 0.86;
    ctx.fillStyle = CSS.ink;
    ctx.fillRect(x, y, W, H);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = CSS.panelEdge;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, W - 2, H - 2);

    // The frame-time graph. 16.7ms is drawn as a line, because "is the bar
    // under the line" is the only question this panel needs to answer at a
    // glance while someone is driving.
    const gx = x + 8;
    const gy = y + 8;
    const gw = W - 16;
    const gh = 46;
    const SCALE = 33; // ms at full height, i.e. two frames at 60Hz
    ctx.fillStyle = CSS.deep;
    ctx.fillRect(gx, gy, gw, gh);

    const plot = (buf: Float32Array, colour: string): void => {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < HISTORY; i++) {
        const v = buf[(this.cursor + i) % HISTORY]!;
        const px = gx + (i / (HISTORY - 1)) * gw;
        const py = gy + gh - Math.min(1, v / SCALE) * gh;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    };
    if (this.ext) plot(this.gpuHistory, CSS.accent);
    plot(this.cpuHistory, CSS.crest);

    // 60fps budget line.
    const budgetY = gy + gh - (16.7 / SCALE) * gh;
    ctx.strokeStyle = CSS.good;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gx, budgetY);
    ctx.lineTo(gx + gw, budgetY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    let ty = gy + gh + 8;
    const line = (label: string, value: string, colour: string): void => {
      ctx.fillStyle = CSS.dim;
      ctx.fillText(label, gx, ty);
      ctx.fillStyle = colour;
      ctx.textAlign = 'right';
      ctx.fillText(value, gx + gw, ty);
      ctx.textAlign = 'left';
      ty += 15;
    };

    const fps = this.gpuMs > 0.01 ? 1000 / Math.max(this.gpuMs, e.frameMs) : 1000 / Math.max(e.frameMs, 0.01);
    line('GPU', this.ext ? this.gpuMs.toFixed(2) + ' ms' : 'unavailable',
      this.ext ? (this.gpuMs > 16.7 ? CSS.accent : CSS.good) : CSS.dim);
    line('CPU', e.frameMs.toFixed(2) + ' ms', e.frameMs > 16.7 ? CSS.accent : CSS.crest);
    line('~fps', fps.toFixed(0), fps < 58 ? CSS.warn : CSS.good);
    line('draws / tris', info.render.calls + ' / ' + (info.render.triangles / 1000).toFixed(0) + 'k', CSS.cream);
    line('res scale', e.resolutionScale.toFixed(2) + 'x', CSS.cream);
    ctx.restore();
  }

  dispose(): void {
    for (const q of this.pending) this.gl.deleteQuery(q);
    for (const q of this.freeQueries) this.gl.deleteQuery(q);
    this.pending.length = 0;
    this.freeQueries.length = 0;
  }
}
