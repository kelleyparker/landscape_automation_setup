import * as THREE from 'three';
import { CSS, RACER_CSS } from '../core/Palette';
import { Rng } from '../core/Rng';
import type { Engine } from '../core/Engine';
import type { Boat } from '../boat/Boat';
import type { Course } from '../race/Course';
import type { RaceStatus } from '../core/types';
import { Minimap } from './Minimap';
import { Screens } from './Screens';

/**
 * THE HUD — hand-drawn cel interface on a 2D canvas.
 *
 * Everything here is drawn, not styled. There is no DOM in the overlay: one
 * `<canvas id="hud">` with `pointer-events: none`, sized to the backing store so
 * text is genuinely crisp at retina rather than upscaled.
 *
 * ## The visual grammar
 *
 * Four rules, applied everywhere, are what make a canvas HUD read as *designed
 * anime interface* instead of as debug text:
 *
 *  1. **Ink, not black.** Every panel and every glyph carries a 3-4 px indigo
 *     outline (`CSS.ink`). Numerals are `strokeText` under `fillText`, which is
 *     the sticker look — the ink is *behind* the cream, so the letterform reads
 *     as a cut shape rather than as an outlined font.
 *  2. **Hard shadows.** Offset down-right, zero blur, flat ink. A blurred shadow
 *     is a photographic cue and would fight every other surface in the frame.
 *  3. **Nothing is axis-aligned.** Panels carry a small shear and a chamfered
 *     corner pair, and the amounts differ per panel, so the layout reads as a
 *     composed set of stickers rather than a grid of boxes.
 *  4. **Quantised, not continuous.** Gauges fill in whole chunks. The speedo
 *     lights 22 discrete segments; the boost ring 16; the drift ring 14. A
 *     smooth bar would be the one place in the game where a value is drawn as a
 *     gradient.
 *
 * ## Timing
 *
 * All animation advances from `engine.elapsed`, never `performance.now()`. The
 * harness steps the engine at a fixed 1/60 with no wall clock involved, so a
 * (seed, time) pair reproduces the HUD frame exactly — including the lap
 * flourish, the position punch and the countdown scale.
 *
 * ## Allocation
 *
 * Nothing in `render()` allocates an array or an object. Font strings, per-glyph
 * advance widths and the speed-line burst path are cached on first use; the
 * course polyline is a `Path2D` built once. The unavoidable exceptions are the
 * formatted clock strings (three or four short strings a frame — a clock cannot
 * be drawn without composing one) and the single-character strings canvas text
 * needs, which V8 serves from its interned ASCII table.
 */

// ------------------------------------------------------------------ layout ---

/**
 * Design-space margin. Every constant in this file is authored against a
 * 1440 x 810 reference frame and multiplied by `Ink.s`, so the HUD keeps its
 * proportions from a laptop to a 5K display instead of shrinking into a corner.
 */
const M = 22;

/** Reference frame the layout constants are authored against. */
const REF_W = 1440;
const REF_H = 810;
/**
 * UI scale clamp. Below 0.58 the numerals stop being readable at a glance;
 * above 1.45 the HUD starts eating the screen on a very large display.
 */
const SCALE_MIN = 0.58;
const SCALE_MAX = 1.45;

/**
 * Backing-store cap. The engine caps its own pixel ratio at 2; the HUD is 2D
 * and much cheaper per pixel, so it is allowed 3 for the sake of phone-class
 * displays, but not the 4 that some browsers will report under page zoom.
 */
const MAX_DPR = 3;

// --------------------------------------------------------------- speedo ------

/** Full-scale reading. TOP_SPEED is 34 m/s and boost multiplies it by 1.22,
 *  i.e. 149 km/h flat out — so the needle sits just short of the stop on a
 *  boosted straight, which is what a gauge is supposed to feel like. */
const SPEEDO_MAX_KMH = 152;
/** Segment counts. All three rings are odd-ish counts so no ring lines up with another. */
const SPEED_CHUNKS = 22;
const BOOST_CHUNKS = 16;
const DRIFT_CHUNKS = 14;
/** Gauge sweep, canvas radians. Opens at the bottom: 140 deg round to 400 deg. */
const GAUGE_A0 = Math.PI * 0.78;
const GAUGE_A1 = Math.PI * 2.22;

/** Drift payout thresholds, mirrored from `BoatPhysics.DRIFT_TIERS`. Marked on the ring. */
const DRIFT_TIERS: readonly number[] = [0.33, 0.66, 1.0];

// ------------------------------------------------------------ corner aid -----

/**
 * How far down the course the corner preview looks, metres.
 *
 * Chosen against the circuit rather than round: the longest run without a bend
 * on "Anchorline" is T6's exit through the line and down the pit straight to
 * T1, about 416 m. 400 m therefore keeps the aid up almost everywhere and lets
 * it go dark on exactly one stretch - which is itself information, and the only
 * place on the lap where "nothing is coming" is true.
 */
const CORNER_SCAN = 400;
/** Scan step, metres. 5 m is a quarter of the tightest corner's arc. */
const CORNER_STEP = 5;
/**
 * Curvature that counts as "a corner", 1/240 m.
 *
 * Set against the real circuit, not picked round: "Anchorline"'s widest bends -
 * T1 The Reach and T3 The Drop - are 205-208 m radius, i.e. k = 0.0049. A
 * threshold at 1/175 would have silently excluded both, and a corner aid that
 * ignores two of the six corners is worse than none. 1/240 catches them at the
 * bottom of the severity scale, which is exactly how they should read: real
 * corners, but flat-out ones.
 */
const CORNER_K_MIN = 1 / 240;
/**
 * Curvature that reads as maximum severity. The hairpin is 30 m radius, but
 * `Course` box-blurs its curvature table over ~40 m of arc, which clips the
 * measured peak of an 86 m corner; 1/34 is where that blurred peak actually
 * lands, so The Anchor pegs the meter and nothing else does.
 */
const CORNER_K_MAX = 1 / 34;
/** Once a corner is found, keep scanning this far for its true peak curvature. */
const CORNER_PEAK_WINDOW = 90;

// --------------------------------------------------------------- animation ---

/** Seconds the lap-complete flourish runs for. */
const LAP_FLASH_TIME = 0.85;
/** Seconds the position punch runs for. */
const PLACE_PUNCH_TIME = 0.45;
/** Seconds a drift-tier flash runs for. Short and hard — it is a hit, not a fade. */
const TIER_FLASH_TIME = 0.34;

// ------------------------------------------------------------------ colour ---

/**
 * Position colours, by place. Gold for the win, cream for the podium chase,
 * sky for third and the hot accent for last — so the colour alone tells you how
 * the race is going without reading the numeral.
 */
const PLACE_CSS: readonly string[] = [CSS.warn, CSS.cream, CSS.sky, CSS.accent];

/**
 * Ordinals, split into numeral and suffix so the position readout can set them
 * at two different sizes and baselines without slicing a string every frame.
 */
const ORDINALS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8'];
const ORDINAL_SUFFIX: readonly string[] = ['st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th'];

const DIGITS: readonly string[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * Heavy system stack. No web fonts (zero external assets), so the HUD leans on
 * whatever the platform's UI face is — which at weight 900 is Inter/SF/Segoe,
 * all of which have the tight, geometric numerals this design wants.
 */
const FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif';

// ----------------------------------------------------------------- scratch ---

// Module scope. Nothing below allocates inside render().
const _tanA = new THREE.Vector3();
const _tanB = new THREE.Vector3();

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrap01(t: number): number {
  const f = t - Math.floor(t);
  return f < 0 ? f + 1 : f;
}

/** CSS colour for a racer slot, wrapped so an out-of-range index can never crash the HUD. */
export function racerCss(index: number): string {
  return RACER_CSS[((index % 4) + 4) % 4] as string;
}

// =============================================================== the pen =====

/**
 * The drawing kit: every mark the HUD makes goes through here.
 *
 * `Minimap` and `Screens` receive one of these rather than importing it, so
 * they share the exact same ink weight, font metrics and caches. They import it
 * with `import type`, which erases at compile time — there is no module cycle at
 * runtime even though `Hud` imports them as values.
 */
export class Ink {
  readonly ctx: CanvasRenderingContext2D;
  /** Viewport in CSS pixels. */
  w = 0;
  h = 0;
  /** UI scale. Multiply every authored dimension by this. */
  s = 1;

  /** Extra advance per glyph, in pixels. Set before `draw`. */
  tracking = 0;
  /**
   * Fixed-advance digits. Every 0-9 occupies the widest digit's cell, so a
   * running clock does not shuffle sideways as the hundredths tick over.
   */
  mono = false;

  private fillCol: string = CSS.cream;
  private strokeCol: string = CSS.ink;
  private strokeW = 0;

  // --- caches ---------------------------------------------------------------
  /** font key -> css font string. Keyed numerically so lookups never build a string. */
  private readonly fontCache = new Map<number, string>();
  /** css font string -> per-glyph advance widths + the mono digit cell width. */
  private readonly fontData = new Map<string, { g: Map<string, number>; d: number }>();
  private glyphs: Map<string, number> = new Map();
  private digitAdv = 0;
  private fontKey = '';

  /** Radiating cel speed lines, unit radius. Built once, transformed per use. */
  readonly burst: Path2D;

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
    this.burst = buildBurst();
  }

  // --------------------------------------------------------------- state ----

  alpha(a: number): void {
    this.ctx.globalAlpha = a;
  }

  /** Fill colour, ink colour and ink weight for the next `draw`. */
  style(fill: string, stroke: string = CSS.ink, strokeW = 0): void {
    this.fillCol = fill;
    this.strokeCol = stroke;
    this.strokeW = strokeW;
  }

  /**
   * Selects a font. `px` is quantised to the half-pixel so that a UI scale which
   * varies continuously with the window size still hits a bounded set of cache
   * keys instead of allocating a new metrics table on every resize frame.
   */
  font(px: number, weight = 900): void {
    const q = Math.max(1, Math.round(px * 2));
    const key = q * 1000 + weight;
    let f = this.fontCache.get(key);
    if (f === undefined) {
      f = weight + ' ' + q * 0.5 + 'px ' + FONT_STACK;
      this.fontCache.set(key, f);
    }
    if (f === this.fontKey) return;
    this.fontKey = f;
    this.ctx.font = f;

    let data = this.fontData.get(f);
    if (data === undefined) {
      // Measure the digits up front: the mono cell is the widest of them, and
      // every clock in the HUD depends on that number being stable.
      const g = new Map<string, number>();
      let widest = 0;
      for (let i = 0; i < 10; i++) {
        const ch = DIGITS[i] as string;
        const wd = this.ctx.measureText(ch).width;
        g.set(ch, wd);
        if (wd > widest) widest = wd;
      }
      data = { g, d: widest };
      this.fontData.set(f, data);
    }
    this.glyphs = data.g;
    this.digitAdv = data.d;
  }

  // ---------------------------------------------------------------- text ----

  private adv(ch: string): number {
    let a = this.glyphs.get(ch);
    if (a === undefined) {
      a = this.ctx.measureText(ch).width;
      this.glyphs.set(ch, a);
    }
    return a;
  }

  /** Total advance of `str` under the current font, tracking and mono setting. */
  measure(str: string): number {
    let total = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charAt(i);
      total += this.mono && ch >= '0' && ch <= '9' ? this.digitAdv : this.adv(ch);
      if (i > 0) total += this.tracking;
    }
    return total;
  }

  /**
   * Draws tracked text, glyph by glyph.
   *
   * Per-glyph rather than one `fillText` for two reasons: canvas letter-spacing
   * is not universally available, and mono digits need each glyph *centred in a
   * fixed cell*, which no text API exposes. `align` is -1 left, 0 centre, 1 right.
   *
   * Stroke first, fill second: the ink has to sit behind the cream or the
   * outline eats the letterform's interior.
   */
  draw(str: string, x: number, y: number, align: -1 | 0 | 1 = -1): number {
    const c = this.ctx;
    const total = this.measure(str);
    let px = align === -1 ? x : align === 0 ? x - total * 0.5 : x - total;

    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    c.lineJoin = 'round';
    c.lineCap = 'round';
    if (this.strokeW > 0) {
      c.lineWidth = this.strokeW;
      c.strokeStyle = this.strokeCol;
    }
    c.fillStyle = this.fillCol;

    for (let i = 0; i < str.length; i++) {
      const ch = str.charAt(i);
      const natural = this.adv(ch);
      const cell = this.mono && ch >= '0' && ch <= '9' ? this.digitAdv : natural;
      if (ch !== ' ') {
        const gx = px + (cell - natural) * 0.5;
        if (this.strokeW > 0) c.strokeText(ch, gx, y);
        c.fillText(ch, gx, y);
      }
      px += cell + this.tracking;
    }
    return total;
  }

  // --------------------------------------------------------------- panels ---

  /**
   * Traces a sheared, chamfered panel.
   *
   * `skew` shears the top edge right and the bottom edge left about the panel's
   * vertical centre, so the shape leans without drifting off its anchor point.
   * `cut` chamfers the top-left and bottom-right corners — one diagonal pair, not
   * all four, which is what keeps it looking cut by hand rather than rounded by
   * a border-radius.
   */
  tracePanel(x: number, y: number, w: number, h: number, skew: number, cut: number): void {
    const c = this.ctx;
    const sx = skew * h * 0.5;
    const tlx = x + sx;
    const trx = x + w + sx;
    const brx = x + w - sx;
    const blx = x - sx;
    const y1 = y + h;
    const f = h > 0 ? 1 - cut / h : 1; // parameter along a vertical edge, short of its end

    c.beginPath();
    c.moveTo(tlx + cut, y);
    c.lineTo(trx, y);
    c.lineTo(trx + (brx - trx) * f, y1 - cut);
    c.lineTo(brx - cut, y1);
    c.lineTo(blx, y1);
    c.lineTo(blx + (tlx - blx) * f, y + cut);
    c.closePath();
  }

  /** Hard shadow, flat fill, chunky ink border. The whole HUD is made of these. */
  panel(
    x: number,
    y: number,
    w: number,
    h: number,
    skew: number,
    cut: number,
    fill: string | null,
    strokeW: number,
    strokeCol: string = CSS.ink,
    shadow = 5
  ): void {
    const c = this.ctx;
    if (shadow > 0) {
      this.tracePanel(x + shadow, y + shadow, w, h, skew, cut);
      c.fillStyle = CSS.ink;
      c.fill();
    }
    this.tracePanel(x, y, w, h, skew, cut);
    if (fill !== null) {
      c.fillStyle = fill;
      c.fill();
    }
    if (strokeW > 0) {
      c.lineJoin = 'miter';
      c.miterLimit = 4;
      c.lineWidth = strokeW;
      c.strokeStyle = strokeCol;
      c.stroke();
    }
  }

  // ---------------------------------------------------------------- gauge ---

  /**
   * An arc gauge that fills in whole chunks.
   *
   * `lit` is a chunk count, not a fraction — the caller floors the value, so a
   * segment only lights once it has been fully earned. Each chunk is inked
   * individually, which is what gives the ring its stitched, sticker-sheet feel.
   */
  chunkArc(
    cx: number,
    cy: number,
    rOuter: number,
    thickness: number,
    a0: number,
    a1: number,
    count: number,
    lit: number,
    on: string,
    off: string,
    inkW: number
  ): void {
    const c = this.ctx;
    const rIn = Math.max(0, rOuter - thickness);
    const span = (a1 - a0) / count;
    const gap = span * 0.16;
    c.lineJoin = 'round';
    for (let i = 0; i < count; i++) {
      const t0 = a0 + i * span + gap * 0.5;
      const t1 = a0 + (i + 1) * span - gap * 0.5;
      c.beginPath();
      c.arc(cx, cy, rOuter, t0, t1, false);
      c.arc(cx, cy, rIn, t1, t0, true);
      c.closePath();
      c.fillStyle = i < lit ? on : off;
      c.fill();
      if (inkW > 0) {
        c.lineWidth = inkW;
        c.strokeStyle = CSS.ink;
        c.stroke();
      }
    }
  }

  /** A chevron: the ">" shape, filled and inked. `dir` +1 points right, -1 left. */
  chevron(
    cx: number,
    cy: number,
    size: number,
    dir: number,
    fill: string,
    inkW: number
  ): void {
    const c = this.ctx;
    const hw = size * 0.55; // half-width
    const t = size * 0.46; // stroke thickness of the arm
    const d = dir >= 0 ? 1 : -1;
    c.beginPath();
    c.moveTo(cx + d * -hw, cy - size);
    c.lineTo(cx + d * (-hw + t), cy - size);
    c.lineTo(cx + d * hw, cy);
    c.lineTo(cx + d * (-hw + t), cy + size);
    c.lineTo(cx + d * -hw, cy + size);
    c.lineTo(cx + d * (hw - t), cy);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
    if (inkW > 0) {
      c.lineWidth = inkW;
      c.lineJoin = 'round';
      c.strokeStyle = CSS.ink;
      c.stroke();
    }
  }

  /** Radiating cel speed lines, centred at (cx, cy) and scaled to `radius`. */
  speedLines(cx: number, cy: number, radius: number, colour: string, spin = 0): void {
    const c = this.ctx;
    c.save();
    c.translate(cx, cy);
    c.rotate(spin);
    c.scale(radius, radius);
    c.fillStyle = colour;
    c.fill(this.burst);
    c.restore();
  }

  // ----------------------------------------------------------- formatting ---

  /** mm:ss.cc, or a placeholder of the same width for "no time yet". */
  fmtTime(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) return '--:--.--';
    const cs = Math.floor(sec * 100);
    const m = Math.floor(cs / 6000);
    const s = Math.floor(cs / 100) % 60;
    const c = cs % 100;
    return (
      (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + (c < 10 ? '0' : '') + c
    );
  }

  /** Signed seconds for a gap readout: +1.24 behind, -0.38 ahead, ± on level. */
  fmtDelta(sec: number): string {
    const a = Math.min(99.99, Math.abs(sec));
    const sign = sec < -0.005 ? '-' : sec > 0.005 ? '+' : '±';
    return sign + a.toFixed(2);
  }
}

/**
 * The speed-line burst, in unit space.
 *
 * Tapered wedges — a point near the centre opening out to a wide base at the
 * rim — because that is the direction an anime speed line actually reads: the
 * eye is pulled outward from whatever is in the middle. Lengths and widths are
 * jittered by a fixed seed so the fan is irregular but identical every run.
 */
function buildBurst(): Path2D {
  const p = new Path2D();
  const COUNT = 46;
  // Fixed seed, not the global `rng`: the fan is a piece of art direction, not a
  // piece of the simulation, and it must look identical under every `?seed=`.
  const r = new Rng(0x5eed);
  for (let i = 0; i < COUNT; i++) {
    const a = ((i + r.next() * 0.7) / COUNT) * Math.PI * 2;
    const hw = 0.006 + r.next() * 0.017;
    const inner = 0.20 + r.next() * 0.22;
    const outer = 1.0 + r.next() * 0.55;
    p.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
    p.lineTo(Math.cos(a - hw) * outer, Math.sin(a - hw) * outer);
    p.lineTo(Math.cos(a + hw) * outer, Math.sin(a + hw) * outer);
    p.closePath();
  }
  return p;
}

// ================================================================= HUD =======

export class Hud {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly ink: Ink;
  private readonly minimap = new Minimap();
  private readonly screens = new Screens();
  /** `?debug` in the URL turns on the frame-time readout and nothing else. */
  private readonly debug: boolean;

  // --- backing store ---------------------------------------------------------
  private cssW = 0;
  private cssH = 0;
  private dpr = 0;

  // --- clock -----------------------------------------------------------------
  /** HUD-local seconds, integrated from the engine so the harness reproduces it. */
  private t = 0;
  private lastElapsed = -1;

  // --- animation state -------------------------------------------------------
  private lapFlash = 0;
  private lastLap = -1;
  private placePunch = 0;
  private lastPlace = -1;
  private tierFlash = 0;
  private lastTier = 0;
  private boostPulse = 0;
  /** Lightly smoothed km/h, so the numeral does not chatter on engine noise. */
  private kmh = 0;

  // --- corner preview --------------------------------------------------------
  /** 0..1 visibility, so the widget fades rather than popping between corners. */
  private cornerBlend = 0;
  private cornerDist = 0;
  private cornerSev = 0;
  /** +1 the corner goes right, -1 it goes left. */
  private cornerSide = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx) throw new Error('Hud: 2D context unavailable');
    this.ctx = ctx;
    this.ink = new Ink(ctx);
    this.debug =
      typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');
  }

  // ------------------------------------------------------------------ tick ---

  render(
    boats: Boat[],
    player: Boat,
    status: RaceStatus,
    engine: Engine,
    course: Course
  ): void {
    // dt from the engine, never the wall clock. First frame gets a nominal step
    // so nothing divides by zero and no animation starts mid-flight.
    const dt = this.lastElapsed < 0 ? 1 / 60 : clamp(engine.elapsed - this.lastElapsed, 0, 0.25);
    this.lastElapsed = engine.elapsed;
    this.t += dt;

    this.sync();
    const ink = this.ink;
    const c = this.ctx;
    c.clearRect(0, 0, this.cssW, this.cssH);
    c.globalAlpha = 1;

    this.advance(dt, player, status, course);

    const phase = status.phase;
    const gauges = phase !== 'intro';
    // The results screen owns the frame; the gauges stay visible underneath but
    // step back so the panel reads as the foreground layer.
    const gaugeAlpha = phase === 'results' ? 0.32 : 1;

    if (gauges) {
      ink.alpha(gaugeAlpha);
      this.drawLapPanel(player, status);
      this.drawSplits(boats, player, status, course);
      this.drawPosition(player);
      this.drawSpeedo(player);
      this.drawCorner();
      ink.alpha(1);
    }

    ink.alpha(phase === 'results' ? 0.32 : 1);
    this.minimap.render(ink, boats, player, course, this.t);
    ink.alpha(1);

    if (gauges && player.progress.wrongWay && (phase === 'racing' || phase === 'finished')) {
      this.drawWrongWay();
    }

    this.screens.render(ink, boats, player, status, dt, this.t);

    if (this.debug) this.drawDebug(engine);
  }

  /**
   * Sizes the backing store to the device's real pixels and re-establishes the
   * CSS-pixel coordinate system.
   *
   * The size check runs every frame because there is no resize event for a
   * display-density change (dragging a window between a retina and a non-retina
   * monitor), but the expensive part — reallocating the backing store — only
   * happens when something actually moved.
   */
  private sync(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

    if (w !== this.cssW || h !== this.cssH || dpr !== this.dpr) {
      this.cssW = w;
      this.cssH = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }

    // setTransform rather than scale: it is idempotent, so a stray save/restore
    // imbalance anywhere in the HUD cannot compound across frames.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ink = this.ink;
    ink.w = w;
    ink.h = h;
    ink.s = clamp(Math.min(w / REF_W, h / REF_H), SCALE_MIN, SCALE_MAX);
  }

  // ------------------------------------------------------------- animation ---

  private advance(dt: number, player: Boat, status: RaceStatus, course: Course): void {
    const pr = player.progress;
    const st = player.state;

    // --- lap flourish -------------------------------------------------------
    if (pr.lap !== this.lastLap) {
      // Only a lap *gained* is worth a flourish; a reset drops the counter back
      // to zero and must not fire one.
      if (this.lastLap >= 0 && pr.lap > this.lastLap) this.lapFlash = 1;
      this.lastLap = pr.lap;
    }
    this.lapFlash = Math.max(0, this.lapFlash - dt / LAP_FLASH_TIME);

    // --- position punch ------------------------------------------------------
    if (pr.place !== this.lastPlace) {
      if (this.lastPlace >= 0) this.placePunch = 1;
      this.lastPlace = pr.place;
    }
    this.placePunch = Math.max(0, this.placePunch - dt / PLACE_PUNCH_TIME);

    // --- drift tier ----------------------------------------------------------
    let tier = 0;
    for (let i = 0; i < DRIFT_TIERS.length; i++) {
      if (st.driftCharge >= (DRIFT_TIERS[i] as number)) tier = i + 1;
    }
    // Crossing *up* through a threshold is the event. The charge resetting to
    // zero at the end of a slide drops the tier back down, which re-arms it.
    if (tier > this.lastTier) this.tierFlash = 1;
    this.lastTier = tier;
    this.tierFlash = Math.max(0, this.tierFlash - dt / TIER_FLASH_TIME);

    // --- boost ---------------------------------------------------------------
    this.boostPulse = st.boosting ? 1 : Math.max(0, this.boostPulse - dt * 3.5);

    // --- speed ---------------------------------------------------------------
    const target = Math.max(0, st.speed) * 3.6;
    // A 14/s follow is fast enough to feel connected to the throttle and slow
    // enough that the integer readout is not flickering between two values.
    this.kmh += (target - this.kmh) * Math.min(1, dt * 14);

    // --- corner preview ------------------------------------------------------
    const live = status.phase === 'racing' || status.phase === 'finished';
    const found = live && pr.finishTime === null ? this.scanCorner(course, pr.splineT) : false;
    this.cornerBlend += ((found ? 1 : 0) - this.cornerBlend) * Math.min(1, dt * 7);
  }

  /**
   * Finds the next corner ahead of the player and measures it.
   *
   * Walks forward along the arc-length parameter until the curvature clears
   * `CORNER_K_MIN`, then keeps walking to find the corner's *peak* — the entry
   * of a long sweeper is barely bent, and grading the warning on the entry
   * would call the hairpin a kink. Distance is reported to the entry, because
   * that is where the driver has to have finished braking; severity is graded on
   * the peak, because that is what the corner actually is.
   *
   * Handedness cannot come from `curvatureAt` (it returns a magnitude), so it is
   * recovered from the cross product of the tangent either side of the peak —
   * the same sign convention `Course` builds its own curvature table with:
   * a positive cross means the tangent swung to the right of travel.
   */
  private scanCorner(course: Course, tNow: number): boolean {
    const L = course.totalLength;
    if (!(L > 0)) return false;
    const dT = CORNER_STEP / L;
    const steps = Math.floor(CORNER_SCAN / CORNER_STEP);

    let entry = -1;
    for (let i = 1; i <= steps; i++) {
      if (course.curvatureAt(wrap01(tNow + i * dT)) >= CORNER_K_MIN) {
        entry = i;
        break;
      }
    }
    if (entry < 0) return false;

    let peakK = 0;
    let peakI = entry;
    const peakSteps = entry + Math.floor(CORNER_PEAK_WINDOW / CORNER_STEP);
    for (let i = entry; i <= peakSteps; i++) {
      const k = course.curvatureAt(wrap01(tNow + i * dT));
      // Stop at the exit: once the bend has flattened out again we are looking
      // at the *next* corner, which is not this warning's business.
      if (k < CORNER_K_MIN * 0.75 && i > entry) break;
      if (k > peakK) {
        peakK = k;
        peakI = i;
      }
    }

    const tPeak = wrap01(tNow + peakI * dT);
    // 6 m either side of the peak: long enough for the turned angle to exceed
    // the spline's own sampling ripple, short enough not to straddle a chicane.
    const eps = 6 / L;
    course.tangentAt(wrap01(tPeak - eps), _tanA);
    course.tangentAt(wrap01(tPeak + eps), _tanB);
    const cross = _tanA.x * _tanB.z - _tanA.z * _tanB.x;

    this.cornerDist = entry * CORNER_STEP;
    this.cornerSev = clamp((peakK - CORNER_K_MIN) / (CORNER_K_MAX - CORNER_K_MIN), 0, 1);
    this.cornerSide = cross > 0 ? 1 : -1;
    return true;
  }

  /** Quantised blink. Cel UI blinks on a hard duty cycle, it does not pulse. */
  private blink(period: number, duty: number): boolean {
    return (this.t % period) / period < duty;
  }

  // ------------------------------------------------------------------ lap ----

  private drawLapPanel(player: Boat, status: RaceStatus): void {
    const ink = this.ink;
    const c = this.ctx;
    const s = ink.s;
    const x = M * s;
    const y = M * s;
    const w = 198 * s;
    const h = 60 * s;

    const f = this.lapFlash;
    c.save();
    if (f > 0) {
      // Punch about the panel's own centre so the flourish reads as the panel
      // being struck rather than as it sliding.
      const k = 1 + 0.10 * f * f;
      c.translate(x + w * 0.5, y + h * 0.5);
      c.scale(k, k);
      c.translate(-(x + w * 0.5), -(y + h * 0.5));
    }

    ink.panel(x, y, w, h, -0.14, 12 * s, CSS.panel, 3.4 * s, CSS.ink, 5 * s);

    // Flourish: a cream bar sweeps across the panel's interior once.
    if (f > 0) {
      c.save();
      ink.tracePanel(x, y, w, h, -0.14, 12 * s);
      c.clip();
      const sweep = (1 - f) * (w + 70 * s) - 44 * s;
      c.globalAlpha = c.globalAlpha * 0.55 * f;
      ink.panel(x + sweep, y - 6 * s, 26 * s, h + 12 * s, -0.85, 0, CSS.foam, 0, CSS.ink, 0);
      c.restore();
    }

    const lap = Math.min(player.progress.lap + 1, status.totalLaps);
    const hot = f > 0 && this.blink(0.12, 0.5);

    ink.font(17 * s, 800);
    ink.tracking = 3.0 * s;
    ink.mono = false;
    ink.style(CSS.dim, CSS.ink, 0);
    ink.draw('LAP', x + 16 * s, y + 24 * s, -1);

    ink.font(34 * s, 900);
    ink.tracking = 0.5 * s;
    ink.mono = true;
    ink.style(hot ? CSS.foam : CSS.cream, CSS.ink, 6 * s);
    const nx = x + 14 * s;
    const nw = ink.draw('' + lap, nx, y + 51 * s, -1);

    // The mono cell centres the numeral, so the "/3" is pulled back by half the
    // slack; otherwise "1/3" would sit visibly wider than "8/3" ever could.
    ink.font(20 * s, 800);
    ink.style(CSS.dim, CSS.ink, 4 * s);
    ink.draw('/' + status.totalLaps, nx + nw - 4 * s, y + 51 * s, -1);
    ink.mono = false;

    c.restore();
  }

  // --------------------------------------------------------------- splits ----

  /**
   * Current lap, best lap, and the gap to whoever is in front.
   *
   * The current lap time is `raceTime` minus the sum of the completed laps —
   * which is exactly how the race director defines it, so the two can never
   * disagree by a frame's worth of accumulation.
   */
  private drawSplits(boats: Boat[], player: Boat, status: RaceStatus, course: Course): void {
    const ink = this.ink;
    const s = ink.s;
    const x = M * s;
    const y = (M + 70) * s;
    const w = 236 * s;
    const h = 106 * s;

    ink.panel(x, y, w, h, 0.10, 13 * s, CSS.panel, 3.4 * s, CSS.ink, 5 * s);

    const laps = player.progress.lapTimes;
    let done = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < laps.length; i++) {
      const lt = laps[i] as number;
      done += lt;
      if (lt < best) best = lt;
    }
    // While running this is the lap in progress; once the flag is out the clock
    // freezes on the lap that finished the race rather than counting on forever.
    const live =
      player.progress.finishTime === null
        ? Math.max(0, status.raceTime - done)
        : laps.length > 0
        ? (laps[laps.length - 1] as number)
        : 0;

    const rowY = y + 31 * s;
    const rowH = 27 * s;
    const labX = x + 15 * s;
    const valX = x + w - 15 * s;

    // --- row 1: the lap running now ------------------------------------------
    ink.font(13 * s, 800);
    ink.tracking = 2.4 * s;
    ink.mono = false;
    ink.style(CSS.dim, CSS.ink, 0);
    ink.draw('LAP', labX, rowY, -1);

    ink.font(25 * s, 900);
    ink.tracking = 0.4 * s;
    ink.mono = true;
    ink.style(CSS.cream, CSS.ink, 5 * s);
    ink.draw(ink.fmtTime(live), valX, rowY + 2 * s, 1);

    // --- row 2: the best lap so far ------------------------------------------
    ink.font(13 * s, 800);
    ink.tracking = 2.4 * s;
    ink.mono = false;
    ink.style(CSS.dim, CSS.ink, 0);
    ink.draw('BEST', labX, rowY + rowH, -1);

    ink.font(20 * s, 900);
    ink.tracking = 0.4 * s;
    ink.mono = true;
    ink.style(Number.isFinite(best) ? CSS.warn : CSS.dim, CSS.ink, 4.4 * s);
    ink.draw(ink.fmtTime(Number.isFinite(best) ? best : -1), valX, rowY + rowH + 1 * s, 1);

    // --- row 3: gap ----------------------------------------------------------
    const gap = this.gapSeconds(boats, player, course);
    ink.font(13 * s, 800);
    ink.tracking = 2.4 * s;
    ink.mono = false;
    ink.style(CSS.dim, CSS.ink, 0);
    ink.draw(player.progress.place === 1 ? 'LEAD' : 'LEADER', labX, rowY + rowH * 2, -1);

    ink.font(20 * s, 900);
    ink.tracking = 0.4 * s;
    ink.mono = true;
    ink.style(gap < -0.005 ? CSS.good : gap > 0.005 ? CSS.accent : CSS.dim, CSS.ink, 4.4 * s);
    ink.draw(ink.fmtDelta(gap), valX, rowY + rowH * 2 + 1 * s, 1);
    ink.mono = false;
  }

  /**
   * Seconds behind the leader, or negative seconds of margin when the player is
   * the leader (in which case the reference is P2 — there is nobody in front of
   * the leader to measure against).
   *
   * Same estimate the race director publishes in `gaps`: for two racers still
   * running it is the distance still owed divided by the *chasing* racer's own
   * speed, which is the honest answer to "how long until they are where the
   * other one is now". The 6 m/s floor keeps a stationary boat from reporting an
   * unbounded gap the readout would then have to special-case.
   */
  private gapSeconds(boats: Boat[], player: Boat, course: Course): number {
    const n = boats.length;
    if (n < 2) return 0;
    const myPlace = player.progress.place;
    const wantPlace = myPlace === 1 ? 2 : 1;

    let other: Boat | null = null;
    for (let i = 0; i < n; i++) {
      const b = boats[i] as Boat;
      if (b.progress.place === wantPlace) {
        other = b;
        break;
      }
    }
    if (!other) return 0;

    const mine = player.progress;
    const theirs = other.progress;
    if (mine.finishTime !== null && theirs.finishTime !== null) {
      return mine.finishTime - theirs.finishTime;
    }

    if (myPlace === 1) {
      const metres = (mine.total - theirs.total) * course.totalLength;
      return -Math.max(0, metres) / Math.max(6, other.state.speed);
    }
    const metres = (theirs.total - mine.total) * course.totalLength;
    return Math.max(0, metres) / Math.max(6, player.state.speed);
  }

  // ------------------------------------------------------------- position ----

  private drawPosition(player: Boat): void {
    const ink = this.ink;
    const c = this.ctx;
    const s = ink.s;
    const w = 188 * s;
    const h = 136 * s;
    const x = M * s;
    const y = this.cssH - (M * s + h);

    const place = clamp(player.progress.place, 1, ORDINALS.length);
    const col = PLACE_CSS[Math.min(place - 1, PLACE_CSS.length - 1)] as string;
    const numStr = ORDINALS[place - 1] as string;
    const sufStr = ORDINAL_SUFFIX[place - 1] as string;

    const p = this.placePunch;
    c.save();
    if (p > 0) {
      const k = 1 + 0.24 * p * p;
      const px = x + w * 0.5;
      const py = y + h * 0.55;
      c.translate(px, py);
      c.scale(k, k);
      // A touch of rotation on the punch: a straight scale reads mechanical.
      c.rotate(-0.05 * p * p);
      c.translate(-px, -py);
    }

    // Colour slab behind the panel, offset the other way from the shadow, so the
    // place colour reads as a printed underlay rather than as a glow.
    ink.panel(x - 6 * s, y - 5 * s, w, h, 0.17, 20 * s, col, 0, CSS.ink, 0);
    ink.panel(x, y, w, h, 0.17, 20 * s, CSS.panel, 3.8 * s, CSS.ink, 6 * s);

    ink.font(14 * s, 800);
    ink.tracking = 3.4 * s;
    ink.mono = false;
    ink.style(CSS.dim, CSS.ink, 0);
    ink.draw('POSITION', x + 22 * s, y + 27 * s, -1);

    // The numeral and its ordinal suffix are drawn separately so the suffix can
    // sit small and high without dragging the numeral's baseline around.
    ink.font(78 * s, 900);
    ink.tracking = 0;
    ink.mono = true;
    ink.style(col, CSS.ink, 11 * s);
    const numW = ink.measure(numStr);
    const bx = x + w * 0.5 - (numW + 30 * s) * 0.5;
    ink.draw(numStr, bx, y + h - 22 * s, -1);
    ink.mono = false;

    // Suffix small and raised, hung off the numeral's shoulder.
    ink.font(30 * s, 900);
    ink.tracking = 0;
    ink.style(CSS.cream, CSS.ink, 6 * s);
    ink.draw(sufStr, bx + numW + 6 * s, y + h - 52 * s, -1);

    c.restore();
  }

  // --------------------------------------------------------------- speedo ----

  /**
   * The speedometer, the boost meter and the live drift charge, as three
   * concentric quantised rings on one dial.
   *
   * They are one instrument on purpose. Speed, stored boost and the charge
   * building in the current slide are the three numbers a player reads in the
   * same glance — splitting them across the screen would make the drift game
   * (slide, bank a tier, spend it) require two saccades instead of none.
   */
  private drawSpeedo(player: Boat): void {
    const ink = this.ink;
    const c = this.ctx;
    const s = ink.s;
    const st = player.state;

    const R = 108 * s;
    const cx = this.cssW - (M + 118) * s;
    const cy = this.cssH - (M + 112) * s;
    const col = racerCss(player.index);

    // --- dial body -----------------------------------------------------------
    c.beginPath();
    c.arc(cx + 5 * s, cy + 5 * s, R + 15 * s, 0, Math.PI * 2);
    c.fillStyle = CSS.ink;
    c.fill();
    c.beginPath();
    c.arc(cx, cy, R + 15 * s, 0, Math.PI * 2);
    c.fillStyle = CSS.panel;
    c.fill();
    c.lineWidth = 4 * s;
    c.strokeStyle = CSS.ink;
    c.stroke();

    // --- speed ring ----------------------------------------------------------
    const speedFrac = clamp(this.kmh / SPEEDO_MAX_KMH, 0, 1);
    const lit = Math.floor(speedFrac * SPEED_CHUNKS + 1e-4);
    // On boost the lit segments strobe to foam white on a hard 2-frame cycle.
    // Quantised, like everything else: a fade would read as a bloom, not a hit.
    const boostHot = this.boostPulse > 0 && this.blink(0.1, 0.5);
    ink.chunkArc(
      cx,
      cy,
      R,
      17 * s,
      GAUGE_A0,
      GAUGE_A1,
      SPEED_CHUNKS,
      lit,
      boostHot ? CSS.foam : col,
      CSS.deep,
      1.6 * s
    );

    // --- boost ring ----------------------------------------------------------
    const boostLit = Math.floor(clamp(st.boostMeter, 0, 1) * BOOST_CHUNKS + 1e-4);
    ink.chunkArc(
      cx,
      cy,
      R - 23 * s,
      12 * s,
      GAUGE_A0,
      GAUGE_A1,
      BOOST_CHUNKS,
      boostLit,
      this.boostPulse > 0 && this.blink(0.1, 0.5) ? CSS.foam : CSS.boost,
      CSS.deep,
      1.4 * s
    );

    // --- drift charge ring ---------------------------------------------------
    const chargeLit = Math.floor(clamp(st.driftCharge, 0, 1) * DRIFT_CHUNKS + 1e-4);
    const tf = this.tierFlash;
    ink.chunkArc(
      cx,
      cy,
      R - 40 * s,
      7 * s,
      GAUGE_A0,
      GAUGE_A1,
      DRIFT_CHUNKS,
      chargeLit,
      tf > 0 && this.blink(0.07, 0.5) ? CSS.foam : CSS.drift,
      CSS.deep,
      1.2 * s
    );

    // Tier thresholds, as ink teeth crossing the drift ring. These are the three
    // payout steps: a slide released before a tooth banks almost nothing.
    c.lineWidth = 2.6 * s;
    c.strokeStyle = CSS.ink;
    c.lineCap = 'butt';
    for (let i = 0; i < DRIFT_TIERS.length; i++) {
      const f = DRIFT_TIERS[i] as number;
      const a = GAUGE_A0 + (GAUGE_A1 - GAUGE_A0) * f;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const r0 = R - 48 * s;
      const r1 = R - 30 * s;
      c.beginPath();
      c.moveTo(cx + ca * r0, cy + sa * r0);
      c.lineTo(cx + ca * r1, cy + sa * r1);
      c.stroke();
      // A pip that lights once the tier is banked, so the earned tiers stay read.
      if (st.driftCharge >= f) {
        c.beginPath();
        c.arc(cx + ca * (r1 + 5 * s), cy + sa * (r1 + 5 * s), 3.2 * s, 0, Math.PI * 2);
        c.fillStyle = tf > 0 ? CSS.foam : CSS.drift;
        c.fill();
        c.lineWidth = 1.4 * s;
        c.stroke();
        c.lineWidth = 2.6 * s;
      }
    }

    // --- numerals ------------------------------------------------------------
    const shown = Math.round(this.kmh);
    ink.font(50 * s, 900);
    ink.tracking = -1 * s;
    ink.mono = true;
    ink.style(st.boosting ? CSS.foam : CSS.cream, CSS.ink, 9 * s);
    ink.draw('' + shown, cx, cy + 8 * s, 0);
    ink.mono = false;

    ink.font(14 * s, 800);
    ink.tracking = 3.2 * s;
    ink.style(CSS.dim, CSS.ink, 0);
    ink.draw('KM/H', cx, cy + 30 * s, 0);

    // Ring key, tiny, at the mouth of the gauge where there is dead space.
    ink.font(11 * s, 800);
    ink.tracking = 1.6 * s;
    ink.style(CSS.boost, CSS.ink, 2.4 * s);
    ink.draw('BOOST', cx - 4 * s, cy + R - 4 * s, 1);
    ink.style(CSS.drift, CSS.ink, 2.4 * s);
    ink.draw('DRIFT', cx + 4 * s, cy + R - 4 * s, -1);
  }

  // -------------------------------------------------------- corner preview ---

  /**
   * The corner ahead: which way it goes, how hard it is, how far away it is.
   *
   * Three redundant encodings of the same fact, because this is a gameplay aid
   * that has to land in peripheral vision: the arc bends the way the corner
   * bends, the chevron count and colour grade the severity, and the metre
   * countdown says when. Any one of them read alone is enough.
   */
  private drawCorner(): void {
    const b = this.cornerBlend;
    if (b < 0.02) return;

    const ink = this.ink;
    const c = this.ctx;
    const s = ink.s;
    const w = 280 * s;
    const h = 96 * s;
    const x = this.cssW * 0.5 - w * 0.5;
    const y = (M + 4) * s;

    const sev = this.cornerSev;
    const dir = this.cornerSide;
    const col = sev < 0.34 ? CSS.good : sev < 0.68 ? CSS.warn : CSS.accent;

    c.save();
    c.globalAlpha = c.globalAlpha * b;
    // Slides down into place rather than fading in flat.
    c.translate(0, (1 - b) * -18 * s);

    ink.panel(x, y, w, h, 0.09, 15 * s, CSS.panel, 3.4 * s, CSS.ink, 5 * s);

    ink.font(12 * s, 800);
    ink.tracking = 2.6 * s;
    ink.mono = false;
    ink.style(CSS.dim, CSS.ink, 0);
    ink.draw('NEXT CORNER', x + w * 0.5, y + 20 * s, 0);

    // --- the arc -------------------------------------------------------------
    // A drawn corner, not an icon: the arc's sweep is the turn's sweep. 67 deg
    // for the flattest bend the aid reports, 216 deg for the hairpin - which is
    // very nearly the 164 deg The Anchor actually turns through, plus the entry
    // and exit you carry into it. Mirrored horizontally for a left-hander.
    const ax = x + 56 * s;
    const ay = y + 62 * s;
    const ar = 26 * s;
    const sweep = (0.75 + 1.65 * sev) * (Math.PI * 0.5);
    c.save();
    c.translate(ax, ay);
    c.scale(dir, 1);
    c.beginPath();
    c.arc(0, 0, ar, Math.PI * 0.5, Math.PI * 0.5 - sweep, true);
    c.lineCap = 'butt';
    c.lineJoin = 'round';
    c.lineWidth = 18 * s;
    c.strokeStyle = CSS.ink;
    c.stroke();
    c.lineWidth = 11 * s;
    c.strokeStyle = col;
    c.stroke();
    // Arrowhead on the far end of the arc, pointing along it.
    const ea = Math.PI * 0.5 - sweep;
    c.save();
    c.translate(Math.cos(ea) * ar, Math.sin(ea) * ar);
    c.rotate(ea - Math.PI * 0.5);
    c.beginPath();
    c.moveTo(0, -15 * s);
    c.lineTo(13 * s, 6 * s);
    c.lineTo(-13 * s, 6 * s);
    c.closePath();
    c.fillStyle = col;
    c.fill();
    c.lineWidth = 3.2 * s;
    c.strokeStyle = CSS.ink;
    c.stroke();
    c.restore();
    c.restore();

    // --- chevrons ------------------------------------------------------------
    // One, two or three, in the corner's own colour. The redundancy is the
    // point: severity survives being read in peripheral vision as a count, as a
    // hue and as an arc, and no single one of them has to be looked at.
    const lit = 1 + Math.floor(sev * 2.999);
    for (let i = 0; i < 3; i++) {
      const cxx = x + (112 + i * 25) * s;
      if (i < lit) {
        ink.chevron(cxx, y + 62 * s, 18 * s, dir, col, 3 * s);
      } else {
        c.save();
        c.globalAlpha = c.globalAlpha * 0.22;
        ink.chevron(cxx, y + 62 * s, 18 * s, dir, CSS.dim, 2.4 * s);
        c.restore();
      }
    }

    // --- distance ------------------------------------------------------------
    const d = Math.max(0, Math.round(this.cornerDist));
    ink.font(34 * s, 900);
    ink.tracking = 0;
    ink.mono = true;
    // Inside 60 m the countdown goes hot: that is braking distance, not a heads-up.
    ink.style(d < 60 ? col : CSS.cream, CSS.ink, 6.5 * s);
    ink.draw('' + d, x + w - 32 * s, y + 74 * s, 1);
    ink.mono = false;
    ink.font(16 * s, 800);
    ink.tracking = 1.2 * s;
    ink.style(CSS.dim, CSS.ink, 3 * s);
    ink.draw('m', x + w - 28 * s, y + 74 * s, -1);

    c.restore();
  }

  // ----------------------------------------------------------- wrong way -----

  private drawWrongWay(): void {
    const ink = this.ink;
    const s = ink.s;
    // 6.7 Hz hard blink with a 60% duty: unmissable, and never off long enough
    // to be mistaken for having cleared.
    if (!this.blink(0.15, 0.62)) return;

    const cx = this.cssW * 0.5;
    const cy = this.cssH * 0.27;
    const w = 430 * s;
    const h = 86 * s;

    ink.panel(cx - w * 0.5, cy - h * 0.5, w, h, 0.13, 18 * s, CSS.accent, 4.5 * s, CSS.ink, 7 * s);

    ink.font(44 * s, 900);
    ink.tracking = 5 * s;
    ink.mono = false;
    ink.style(CSS.cream, CSS.ink, 9 * s);
    ink.draw('WRONG WAY', cx, cy + 15 * s, 0);

    // Chevrons flanking the slab, pointing inward — "come back this way".
    for (let i = 0; i < 3; i++) {
      const off = (w * 0.5 + (26 + i * 32) * s);
      ink.chevron(cx - off, cy, 20 * s, 1, CSS.warn, 3.4 * s);
      ink.chevron(cx + off, cy, 20 * s, -1, CSS.warn, 3.4 * s);
    }
  }

  // ---------------------------------------------------------------- debug ----

  private drawDebug(engine: Engine): void {
    const ink = this.ink;
    const s = ink.s;
    const info = engine.renderer.info;
    const ms = engine.frameMs;
    // frameMs is CPU time inside step(), so the honest headline is the frame
    // budget it fits in rather than a fabricated refresh rate.
    const fps = Math.round(1000 / Math.max(ms, 1));

    ink.font(11 * s, 700);
    ink.tracking = 0.8 * s;
    ink.mono = false;
    // Bottom-left corner, under the position panel and out of every other
    // element's way. Inked so it survives foam underneath, but held at low alpha
    // so it never competes with the gauges it is measuring.
    ink.style(CSS.dim, CSS.ink, 2.4 * s);
    this.ctx.save();
    this.ctx.globalAlpha = 0.7;
    ink.draw(
      ms.toFixed(2) + ' ms  ~' + fps + ' fps  res ' + engine.resolutionScale.toFixed(2) +
        '  ' + info.render.calls + ' dc  ' + info.render.triangles + ' tri',
      10 * s,
      this.cssH - 7 * s,
      -1
    );
    this.ctx.restore();
  }
}
