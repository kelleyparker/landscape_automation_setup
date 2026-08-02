import { CSS, RACER_CSS } from '../core/Palette';
import type { Boat } from '../boat/Boat';
import type { RaceStatus } from '../core/types';
import type { Ink } from './Hud';

/**
 * THE SCREENS — title card, countdown and results.
 *
 * All three are full-frame moments rather than panels, so they own their own
 * composition: a scrim to push the world back, radiating cel speed lines to
 * carry the energy, and a single heavy lockup in the middle. Nothing fades in
 * smoothly; everything punches, holds and cuts, because that is what a hand
 * animated title does and it is the same discipline the shading follows.
 *
 * Every timer here is fed the HUD's `dt`, which comes from `engine.elapsed`.
 * The countdown does not even need a timer: `RaceStatus.countdown` is a real
 * number counting 3 -> 0 and then on into negative through the GO window, so
 * both the numeral *and* its punch scale are pure functions of it. That is why
 * the countdown reproduces exactly under the harness.
 */

// ------------------------------------------------------------------ timing ---

/**
 * How long "GO" holds after the lights, mirrored from `RaceDirector.GO_HOLD`.
 * The director clamps `countdown` at exactly `-GO_HOLD`, so the test below is a
 * clean comparison with no epsilon.
 */
const GO_HOLD = 0.9;

/** Seconds for the results rows to finish arriving. */
const ROW_DELAY = 0.13;
const ROW_RISE = 0.26;
const ROW_LEAD_IN = 0.16;

// ------------------------------------------------------------------ layout ---

const RESULTS_W = 646;
const RESULTS_H = 414;
const ROW_H = 62;

const ORDINALS: readonly string[] = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
const PLACE_CSS: readonly string[] = [CSS.warn, CSS.cream, CSS.sky, CSS.accent];

/**
 * Control hints for the title card: the key, then what it does. Authored as a
 * flat array of pairs so the whole table is one module-scope allocation.
 */
const HINTS: readonly string[] = [
  'W  S', 'THROTTLE',
  'A  D', 'STEER',
  'SPACE', 'DRIFT',
  'E', 'BOOST',
  'R', 'RESTART',
];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class Screens {
  /** Seconds spent in the current phase. Reset on every phase change. */
  private phaseT = 0;
  private lastPhase = '';
  /** Preallocated column measurements for the control-hint row. */
  private readonly hintW = new Float32Array(8);
  /** Preallocated place -> racer slot map for the results table. */
  private readonly order = new Int32Array(8);
  /** Upper-cased racer names, so the results table does not rebuild four strings a frame. */
  private readonly caps = new Map<string, string>();

  private cap(name: string): string {
    let u = this.caps.get(name);
    if (u === undefined) {
      u = name.toUpperCase();
      this.caps.set(name, u);
    }
    return u;
  }

  render(
    ink: Ink,
    boats: Boat[],
    player: Boat,
    status: RaceStatus,
    dt: number,
    t: number
  ): void {
    if (status.phase !== this.lastPhase) {
      this.lastPhase = status.phase;
      this.phaseT = 0;
    }
    this.phaseT += dt;

    switch (status.phase) {
      case 'intro':
        this.drawTitle(ink, status, t);
        break;
      case 'countdown':
        this.drawCountdown(ink, status, t);
        break;
      case 'racing':
      case 'finished':
        // The GO card lives in the racing phase: the lights are already out and
        // the player already has control, which is exactly the point of it.
        if (status.countdown > -GO_HOLD) this.drawCountdown(ink, status, t);
        break;
      case 'results':
        this.drawResults(ink, boats, player, status, t);
        break;
    }
  }

  // ---------------------------------------------------------------- title ---

  /**
   * The title card.
   *
   * A designed lockup, not a centred string: a hot slab shears one way, the
   * wordmark sits on it sheared the other, and a fan of speed lines behind the
   * whole thing gives the composition somewhere to radiate from. The intro only
   * lasts 2.5 s, so the assembly animates in over the first third of a second
   * and then holds.
   */
  private drawTitle(ink: Ink, status: RaceStatus, t: number): void {
    const c = ink.ctx;
    const s = ink.s;
    const cx = ink.w * 0.5;
    const cy = ink.h * 0.42;
    // Snap in fast, then hold: a 2.5 s card cannot afford a slow build.
    const k = clamp(this.phaseT / 0.32, 0, 1);
    const ease = 1 - (1 - k) * (1 - k) * (1 - k);

    c.save();
    c.globalAlpha = 0.46 * ease;
    c.fillStyle = CSS.ink;
    c.fillRect(0, 0, ink.w, ink.h);
    c.restore();

    // --- speed lines ---------------------------------------------------------
    c.save();
    c.globalAlpha = 0.30 * ease;
    // A very slow spin keeps the fan alive without ever reading as a rotation.
    ink.speedLines(cx, cy, Math.max(ink.w, ink.h) * (0.42 + 0.14 * ease), CSS.crest, t * 0.06);
    c.restore();

    c.save();
    c.globalAlpha = c.globalAlpha * ease;
    c.translate(0, (1 - ease) * 26 * s);

    // --- the lockup ----------------------------------------------------------
    ink.font(96 * s, 900);
    ink.tracking = 9 * s;
    ink.mono = false;
    const titleW = ink.measure('WAVEBREAK');
    const slabW = titleW + 76 * s;
    const slabH = 122 * s;

    // Two slabs, sheared against each other. The offset pair is the whole trick:
    // one shape alone reads as a box, two disagreeing shapes read as print.
    ink.panel(cx - slabW * 0.5 + 10 * s, cy - slabH * 0.5 + 12 * s, slabW, slabH, -0.20, 26 * s, CSS.accent, 0, CSS.ink, 0);
    ink.panel(cx - slabW * 0.5, cy - slabH * 0.5, slabW, slabH, 0.16, 26 * s, CSS.panel, 4.5 * s, CSS.ink, 7 * s);

    ink.style(CSS.cream, CSS.ink, 13 * s);
    ink.draw('WAVEBREAK', cx, cy + 30 * s, 0);

    // Rule + strapline under the wordmark.
    const ry = cy + slabH * 0.5 + 24 * s;
    c.beginPath();
    c.moveTo(cx - slabW * 0.36, ry - 14 * s);
    c.lineTo(cx + slabW * 0.36, ry - 14 * s);
    c.lineCap = 'butt';
    c.lineWidth = 3.4 * s;
    c.strokeStyle = CSS.ink;
    c.stroke();

    ink.font(19 * s, 800);
    ink.tracking = 6 * s;
    ink.style(CSS.warn, CSS.ink, 4.5 * s);
    ink.draw('ANCHORLINE   ' + status.totalLaps + ' LAPS', cx, ry + 14 * s, 0);

    // --- control hints -------------------------------------------------------
    this.drawHints(ink, cx, ink.h - 118 * s);

    c.restore();
  }

  /**
   * A row of key chips.
   *
   * Both lines live *inside* the chip. A label sitting below the panel on open
   * water is unreadable the moment a foam crest passes under it, which is
   * exactly what a title card over a bright sea will do to you.
   *
   * Widths are measured into a preallocated array in a first pass so the row can
   * be centred without building anything.
   */
  private drawHints(ink: Ink, cx: number, y: number): void {
    const s = ink.s;
    const pairs = HINTS.length / 2;
    const gap = 12 * s;
    const chipH = 62 * s;
    let total = 0;

    for (let i = 0; i < pairs; i++) {
      ink.font(17 * s, 900);
      ink.tracking = 1.6 * s;
      ink.mono = false;
      const keyW = ink.measure(HINTS[i * 2] as string);
      ink.font(11 * s, 800);
      ink.tracking = 2.0 * s;
      const labW = ink.measure(HINTS[i * 2 + 1] as string);
      const w = Math.max(keyW, labW) + 30 * s;
      this.hintW[i] = w;
      total += w + (i > 0 ? gap : 0);
    }

    let x = cx - total * 0.5;
    for (let i = 0; i < pairs; i++) {
      const w = this.hintW[i] as number;
      ink.panel(x, y, w, chipH, 0.09, 10 * s, CSS.panel, 3 * s, CSS.ink, 5 * s);

      ink.font(17 * s, 900);
      ink.tracking = 1.6 * s;
      ink.mono = false;
      ink.style(CSS.cream, CSS.ink, 4.5 * s);
      ink.draw(HINTS[i * 2] as string, x + w * 0.5, y + 28 * s, 0);

      ink.font(11 * s, 800);
      ink.tracking = 2.0 * s;
      ink.style(CSS.warn, CSS.ink, 0);
      ink.draw(HINTS[i * 2 + 1] as string, x + w * 0.5, y + 48 * s, 0);

      x += w + gap;
    }
  }

  // ------------------------------------------------------------ countdown ---

  /**
   * 3 / 2 / 1 / GO, as pure functions of `status.countdown`.
   *
   * `f` is how much of the current second is left, so `1 - f` is the numeral's
   * age. The scale is a hard exponential decay from a 65% overshoot (the punch
   * in) plus a second expansion driven by the fade (the punch out), which is the
   * classic two-part hit: it slams in, sits, then blows apart as it leaves.
   */
  private drawCountdown(ink: Ink, status: RaceStatus, t: number): void {
    const c = ink.ctx;
    const s = ink.s;
    const cd = status.countdown;
    const cx = ink.w * 0.5;
    const cy = ink.h * 0.42;

    let label: string;
    let colour: string;
    let alpha: number;
    let age: number;

    if (status.phase === 'countdown') {
      const n = clamp(Math.ceil(cd), 1, 3);
      const f = clamp(cd - (n - 1), 0, 1);
      age = 1 - f;
      alpha = Math.min(1, f * 5);
      label = '' + n;
      colour = n === 1 ? CSS.warn : CSS.cream;
    } else {
      age = -cd;
      alpha = clamp((GO_HOLD - age) / 0.32, 0, 1);
      label = 'GO!';
      colour = CSS.good;
    }
    if (alpha <= 0.001) return;

    const scale = 1 + 0.65 * Math.exp(-age * 13) + 0.5 * (1 - alpha);

    c.save();
    c.globalAlpha = alpha;

    // Speed lines scale with the numeral, so the whole card breathes as one hit.
    c.save();
    c.globalAlpha = alpha * 0.42;
    ink.speedLines(cx, cy, Math.max(ink.w, ink.h) * 0.30 * scale, colour, t * 0.3);
    c.restore();

    c.translate(cx, cy);
    c.scale(scale, scale);

    ink.font(150 * s, 900);
    ink.tracking = label.length > 1 ? 6 * s : 0;
    ink.mono = false;
    // Ink slab behind the glyph so the numeral survives a bright sea underneath.
    const gw = ink.measure(label);
    ink.panel(-gw * 0.5 - 34 * s, -92 * s, gw + 68 * s, 152 * s, 0.18, 30 * s, CSS.panel, 5 * s, CSS.ink, 9 * s);

    ink.style(colour, CSS.ink, 18 * s);
    ink.draw(label, 0, 50 * s, 0);

    c.restore();
  }

  // -------------------------------------------------------------- results ---

  /**
   * The results table.
   *
   * Rows arrive staggered from the right, one every 130 ms, which is long
   * enough to read each name as it lands and short enough that the whole board
   * is up in under a second. The player's row inverts to a cream slab with ink
   * type — the strongest contrast available in this palette, so the eye finds it
   * before it has read a single word.
   */
  private drawResults(
    ink: Ink,
    boats: Boat[],
    player: Boat,
    status: RaceStatus,
    t: number
  ): void {
    const c = ink.ctx;
    const s = ink.s;
    const n = Math.min(boats.length, this.order.length);

    c.save();
    c.globalAlpha = 0.66;
    c.fillStyle = CSS.ink;
    c.fillRect(0, 0, ink.w, ink.h);
    c.restore();

    const w = RESULTS_W * s;
    const h = RESULTS_H * s;
    const x = ink.w * 0.5 - w * 0.5;
    const y = ink.h * 0.5 - h * 0.5;

    const intro = clamp(this.phaseT / 0.24, 0, 1);
    c.save();
    c.globalAlpha = intro;
    c.translate(0, (1 - intro) * 24 * s);

    ink.panel(x, y, w, h, 0.045, 24 * s, CSS.panel, 4.2 * s, CSS.ink, 8 * s);

    // --- header --------------------------------------------------------------
    ink.font(34 * s, 900);
    ink.tracking = 7 * s;
    ink.mono = false;
    ink.style(CSS.cream, CSS.ink, 8 * s);
    ink.draw('RESULTS', x + 30 * s, y + 50 * s, -1);

    ink.font(14 * s, 800);
    ink.tracking = 3 * s;
    ink.style(CSS.warn, CSS.ink, 0);
    ink.draw('ANCHORLINE   ' + status.totalLaps + ' LAPS', x + w - 30 * s, y + 46 * s, 1);

    // Column heads, aligned to the same right edges the values use.
    const colTotal = x + w - 176 * s;
    const colBest = x + w - 30 * s;
    ink.font(11 * s, 800);
    ink.tracking = 2.4 * s;
    ink.style(CSS.dim, CSS.ink, 0);
    ink.draw('RACER', x + 106 * s, y + 76 * s, -1);
    ink.draw('TOTAL', colTotal, y + 76 * s, 1);
    ink.draw('BEST LAP', colBest, y + 76 * s, 1);

    c.beginPath();
    c.moveTo(x + 26 * s, y + 84 * s);
    c.lineTo(x + w - 26 * s, y + 84 * s);
    c.lineCap = 'butt';
    c.lineWidth = 3 * s;
    c.strokeStyle = CSS.ink;
    c.stroke();

    // --- rows ----------------------------------------------------------------
    // `place` is unique per racer (the director assigns it from a total order),
    // so the table can be built by direct placement rather than by sorting.
    for (let i = 0; i < n; i++) this.order[i] = -1;
    for (let i = 0; i < n; i++) {
      const p = (boats[i] as Boat).progress.place;
      if (p >= 1 && p <= n) this.order[p - 1] = i;
    }

    const rowY0 = y + 96 * s;
    for (let r = 0; r < n; r++) {
      const bi = this.order[r] as number;
      if (bi < 0) continue;
      const b = boats[bi] as Boat;
      const k = clamp((this.phaseT - ROW_LEAD_IN - r * ROW_DELAY) / ROW_RISE, 0, 1);
      if (k <= 0) continue;
      const ease = 1 - (1 - k) * (1 - k) * (1 - k);
      this.drawRow(ink, b, b === player, r, x, rowY0 + r * ROW_H * s, w, ease);
    }

    // --- prompt --------------------------------------------------------------
    const promptK = clamp((this.phaseT - ROW_LEAD_IN - n * ROW_DELAY - 0.2) / 0.3, 0, 1);
    if (promptK > 0 && (t % 0.9) / 0.9 < 0.68) {
      c.save();
      c.globalAlpha = c.globalAlpha * promptK;
      ink.font(18 * s, 900);
      ink.tracking = 5 * s;
      ink.style(CSS.warn, CSS.ink, 5 * s);
      ink.draw('PRESS  R  TO RACE AGAIN', ink.w * 0.5, y + h - 24 * s, 0);
      c.restore();
    }

    c.restore();
  }

  /** One results row: place chip, hull colour, name, total, best lap. */
  private drawRow(
    ink: Ink,
    b: Boat,
    isPlayer: boolean,
    row: number,
    px: number,
    y: number,
    pw: number,
    k: number
  ): void {
    const c = ink.ctx;
    const s = ink.s;
    const h = (ROW_H - 8) * s;
    const x = px + 26 * s + (1 - k) * 54 * s;
    const w = pw - 52 * s;
    const col = RACER_CSS[((b.index % 4) + 4) % 4] as string;
    const placeCol = PLACE_CSS[Math.min(row, PLACE_CSS.length - 1)] as string;

    c.save();
    c.globalAlpha = c.globalAlpha * k;

    ink.panel(x, y, w, h, 0.05, 12 * s, isPlayer ? CSS.cream : CSS.deep, 3 * s, CSS.ink, 4 * s);

    const fg = isPlayer ? CSS.ink : CSS.cream;
    const sub = isPlayer ? CSS.inkSoft : CSS.dim;
    const strokeW = isPlayer ? 0 : 4 * s;

    // Place chip.
    ink.panel(x + 12 * s, y + 8 * s, 46 * s, h - 16 * s, 0.12, 8 * s, placeCol, 2.6 * s, CSS.ink, 3 * s);
    ink.font(20 * s, 900);
    ink.tracking = 0;
    ink.mono = false;
    ink.style(CSS.ink, CSS.ink, 0);
    ink.draw(ORDINALS[Math.min(row, ORDINALS.length - 1)] as string, x + 35 * s, y + h * 0.5 + 7 * s, 0);

    // Hull colour swatch: the same key the minimap dots and the speedo use.
    c.beginPath();
    c.rect(x + 68 * s, y + 12 * s, 9 * s, h - 24 * s);
    c.fillStyle = col;
    c.fill();
    c.lineWidth = 2.2 * s;
    c.strokeStyle = CSS.ink;
    c.stroke();

    ink.font(24 * s, 900);
    ink.tracking = 2.4 * s;
    ink.style(fg, CSS.ink, strokeW);
    ink.draw(this.cap(b.name), x + 88 * s, y + h * 0.5 + 8 * s, -1);

    // Times. Both mono, both right-aligned: a results table that shifts its
    // decimal points column to column is unreadable at a glance.
    let best = Number.POSITIVE_INFINITY;
    const laps = b.progress.lapTimes;
    for (let i = 0; i < laps.length; i++) {
      const lt = laps[i] as number;
      if (lt < best) best = lt;
    }

    const total = b.progress.finishTime;
    ink.font(23 * s, 900);
    ink.tracking = 0.4 * s;
    ink.mono = true;
    ink.style(total === null ? sub : fg, CSS.ink, strokeW);
    ink.draw(total === null ? 'DNF' : ink.fmtTime(total), x + w - 150 * s, y + h * 0.5 + 8 * s, 1);

    ink.font(17 * s, 800);
    ink.style(Number.isFinite(best) ? (isPlayer ? CSS.inkSoft : CSS.warn) : sub, CSS.ink, 0);
    ink.draw(ink.fmtTime(Number.isFinite(best) ? best : -1), x + w - 4 * s, y + h * 0.5 + 7 * s, 1);
    ink.mono = false;

    c.restore();
  }
}
