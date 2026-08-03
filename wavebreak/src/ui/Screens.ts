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

/**
 * Results row stagger.
 *
 * These used to be 0.16 lead-in + 0.13 per row + 0.26 rise, which put the last
 * row at 1.02 s and the prompt at 1.18 s. A results board that takes over a
 * second to assemble is not a card, it is a loading screen — and it meant the
 * screen had never once been seen complete under the capture harness, which
 * renders 13 frames (0.217 s) after a phase change. At 35 ms a row the fourth
 * name lands at 0.185 s: still a legible cascade, but the board is *up*.
 */
const ROW_DELAY = 0.035;
const ROW_RISE = 0.08;
const ROW_LEAD_IN = 0;

/** Vertical centre of the countdown card, as a fraction of frame height. */
const COUNT_CY = 0.32;

// ------------------------------------------------------------------ layout ---

const RESULTS_W = 712;
/**
 * Panel height. Sized from the contents rather than picked: 108 to the first
 * row, four 60 px rows, then the prompt chip's 44 px plus a margin either side.
 * At 396 the chip landed on top of the fourth row.
 */
const RESULTS_H = 438;
const ROW_H = 60;

/**
 * Column right edges, measured in from the *row's* right edge in design pixels.
 * One table of three numbers so the heads and the values can never drift apart.
 */
const COL_BEST = 6;
const COL_TOTAL = 152;
const COL_GAP = 292;

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
    // Raised off the rider's head: at 0.42 the slab landed square on the helmet
    // in the chase framing, which is the one place on screen it must not sit.
    const cy = ink.h * COUNT_CY;

    let label: string;
    let colour: string;
    let alpha: number;
    let age: number;
    /** Pips still lit under the numeral: 3, 2, 1, then none once the flag drops. */
    let pips: number;

    if (status.phase === 'countdown') {
      const n = clamp(Math.ceil(cd), 1, 3);
      const f = clamp(cd - (n - 1), 0, 1);
      age = 1 - f;
      alpha = Math.min(1, f * 5);
      label = '' + n;
      // Heat ramp. The count is a temperature as much as a number: cool at three,
      // gold at two, hot at one, green on the flag. The colour alone tells you
      // how close the start is without reading the numeral at all.
      colour = n === 3 ? CSS.cream : n === 2 ? CSS.warn : CSS.accent;
      pips = n;
    } else {
      age = -cd;
      alpha = clamp((GO_HOLD - age) / 0.32, 0, 1);
      label = 'GO!';
      colour = CSS.good;
      pips = 0;
    }
    if (alpha <= 0.001) return;

    const scale = 1 + 0.65 * Math.exp(-age * 13) + 0.5 * (1 - alpha);

    c.save();
    c.globalAlpha = alpha;

    // --- speed lines ---------------------------------------------------------
    // Inked, not tinted. These used to be flat cream wedges at 0.42 alpha over a
    // bright sea, which read as haze; every ray now carries the same indigo edge
    // every other mark in this HUD does, so it reads as a cut shape.
    // Held well below the old 0.42 *fill* alpha, because the ink edge is doing
    // the work now: an outlined ray reads as a drawn mark at a third of the
    // opacity a bare wedge needed, and at any more than this the fan buries the
    // boat, the gate and half the HUD.
    c.save();
    c.globalAlpha = alpha * 0.34;
    ink.speedLines(
      cx,
      cy,
      Math.max(ink.w, ink.h) * 0.30 * scale,
      colour,
      t * 0.3,
      2.2 * s
    );
    c.restore();

    c.translate(cx, cy);
    c.scale(scale, scale);

    ink.font(150 * s, 900);
    ink.tracking = label.length > 1 ? 6 * s : 0;
    ink.mono = false;
    const gw = ink.measure(label);
    const pw = gw + 68 * s;
    const px = -gw * 0.5 - 34 * s;

    // Double slab, sheared against each other — the title card's treatment, which
    // the countdown was the only one of the three moments not to get. One shape
    // reads as a box; two disagreeing shapes read as print. The underlay takes
    // the *opposite* end of the heat ramp from the numeral so the pair always
    // contrasts, rather than going cream-on-cream at three.
    const slabCol = colour === CSS.accent ? CSS.warn : CSS.accent;
    ink.panel(px + 13 * s, -92 * s + 14 * s, pw, 152 * s, -0.24, 30 * s, slabCol, 0, CSS.ink, 0);
    ink.panel(px, -92 * s, pw, 152 * s, 0.18, 30 * s, CSS.panel, 5 * s, CSS.ink, 9 * s);

    ink.style(colour, CSS.ink, 18 * s);
    ink.draw(label, 0, 50 * s, 0);

    // --- tally pips ----------------------------------------------------------
    // Three lights that go out as the count runs. Inside the scale, so they punch
    // with the numeral and the card reads as one designed object rather than as a
    // number sitting on a box.
    const py = 88 * s;
    for (let i = 0; i < 3; i++) {
      const bx = (i - 1) * 36 * s;
      const on = i < pips;
      c.beginPath();
      c.arc(bx, py, 12 * s, 0, Math.PI * 2);
      c.fillStyle = on ? colour : CSS.panel;
      c.fill();
      // Thin enough that the lit fill is what you see; a heavy ring on a 9 px pip
      // ate the pip and the row read as three dark dots whatever the count was.
      c.lineWidth = 3.4 * s;
      c.strokeStyle = CSS.ink;
      c.stroke();
    }

    c.restore();
  }

  // -------------------------------------------------------------- results ---

  /**
   * The results table.
   *
   * Composed as a card rather than printed as a table: a fan of speed lines
   * behind it (the same device the title and the countdown use, so the three
   * full-frame moments share one language), a hot slab sheared behind the panel,
   * and a chequered strip under the masthead. Rows cascade in from the right at
   * 35 ms apiece and the whole board is standing in under a fifth of a second.
   *
   * The player's row inverts to a cream slab with ink type — the strongest
   * contrast available in this palette, so the eye finds it before it has read a
   * single word.
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
    c.globalAlpha = 0.72;
    c.fillStyle = CSS.ink;
    c.fillRect(0, 0, ink.w, ink.h);
    c.restore();

    const w = RESULTS_W * s;
    const h = RESULTS_H * s;
    const x = ink.w * 0.5 - w * 0.5;
    const y = ink.h * 0.5 - h * 0.5;
    const cx = ink.w * 0.5;
    const cy = ink.h * 0.5;

    const intro = clamp(this.phaseT / 0.18, 0, 1);
    const ease = 1 - (1 - intro) * (1 - intro) * (1 - intro);

    // --- speed lines ---------------------------------------------------------
    // Behind everything, inked like the countdown's. This is what stops the card
    // reading as a dialog box dropped on top of the world.
    c.save();
    c.globalAlpha = 0.20 * ease;
    ink.speedLines(cx, cy, Math.max(ink.w, ink.h) * (0.40 + 0.12 * ease), CSS.crest, t * 0.05, 2.0 * s);
    c.restore();

    c.save();
    c.globalAlpha = ease;
    c.translate(0, (1 - ease) * 20 * s);

    // Hot slab behind the panel, sheared the other way and offset opposite the
    // shadow, so the board reads as printed rather than as a floating rectangle.
    ink.panel(x - 11 * s, y + 13 * s, w, h, -0.055, 24 * s, CSS.accent, 0, CSS.ink, 0);
    ink.panel(x, y, w, h, 0.045, 24 * s, CSS.panel, 4.2 * s, CSS.ink, 8 * s);

    // --- masthead ------------------------------------------------------------
    ink.font(34 * s, 900);
    ink.tracking = 7 * s;
    ink.mono = false;
    ink.style(CSS.cream, CSS.ink, 8 * s);
    const titleW = ink.draw('RESULTS', x + 30 * s, y + 50 * s, -1);

    ink.font(14 * s, 800);
    ink.tracking = 3 * s;
    ink.style(CSS.warn, CSS.ink, 0);
    ink.draw('ANCHORLINE   ' + status.totalLaps + ' LAPS', x + w - 30 * s, y + 46 * s, 1);

    // Chequer strip under the wordmark: the flag, as a graphic rule.
    this.drawChequer(ink, x + 30 * s, y + 60 * s, titleW + 24 * s, 13 * s);

    // Column heads, aligned to the same right edges the values use.
    const rowX = x + 26 * s;
    const rowW = w - 52 * s;
    const colGap = rowX + rowW - COL_GAP * s;
    const colTotal = rowX + rowW - COL_TOTAL * s;
    const colBest = rowX + rowW - COL_BEST * s;
    ink.font(11 * s, 800);
    ink.tracking = 2.4 * s;
    ink.style(CSS.dim, CSS.ink, 0);
    ink.draw('RACER', x + 114 * s, y + 90 * s, -1);
    ink.draw('GAP', colGap, y + 90 * s, 1);
    ink.draw('TOTAL', colTotal, y + 90 * s, 1);
    ink.draw('BEST LAP', colBest, y + 90 * s, 1);

    c.beginPath();
    c.moveTo(rowX, y + 98 * s);
    c.lineTo(x + w - 26 * s, y + 98 * s);
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

    // The winner's time is the reference every gap is measured from, and the
    // fastest lap of the race gets flagged wherever it was set. Both are one
    // pass over four racers, so neither needs the director passed in.
    let winTime = Number.NaN;
    const lead = this.order[0] as number;
    if (lead >= 0) {
      const ft = (boats[lead] as Boat).progress.finishTime;
      if (ft !== null) winTime = ft;
    }
    let fastest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const laps = (boats[i] as Boat).progress.lapTimes;
      for (let j = 0; j < laps.length; j++) {
        const lt = laps[j] as number;
        if (lt < fastest) fastest = lt;
      }
    }

    const rowY0 = y + 108 * s;
    for (let r = 0; r < n; r++) {
      const bi = this.order[r] as number;
      if (bi < 0) continue;
      const b = boats[bi] as Boat;
      const k = clamp((this.phaseT - ROW_LEAD_IN - r * ROW_DELAY) / ROW_RISE, 0, 1);
      if (k <= 0) continue;
      const re = 1 - (1 - k) * (1 - k) * (1 - k);
      this.drawRow(
        ink, b, b === player, r, x, rowY0 + r * ROW_H * s, w, re,
        winTime, fastest, status.totalLaps
      );
    }

    // --- prompt --------------------------------------------------------------
    // The chip is persistent; only the text blinks. The old version blinked the
    // whole thing, which left a 70 px band of empty panel for a third of every
    // second — and, at 1.18 s to arrive, usually forever.
    const promptK = clamp((this.phaseT - n * ROW_DELAY - 0.01) / 0.06, 0, 1);
    if (promptK > 0) {
      c.save();
      c.globalAlpha = c.globalAlpha * promptK;
      ink.font(18 * s, 900);
      ink.tracking = 5 * s;
      ink.mono = false;
      const label = 'PRESS  R  TO RACE AGAIN';
      const lw = ink.measure(label);
      const chipW = lw + 52 * s;
      const chipH = 44 * s;
      const chipX = cx - chipW * 0.5;
      const chipY = y + h - chipH - 18 * s;
      ink.panel(chipX, chipY, chipW, chipH, -0.11, 12 * s, CSS.deep, 3.2 * s, CSS.ink, 5 * s);
      // Hard duty cycle, like every other blink in this HUD — but the off beat
      // steps down to cream rather than to `CSS.dim`, so the prompt flicks
      // between two readable colours instead of dropping out of contrast for a
      // third of every second.
      ink.style((t % 0.9) / 0.9 < 0.7 ? CSS.warn : CSS.cream, CSS.ink, 4.5 * s);
      ink.draw(label, cx, chipY + 29 * s, 0);
      c.restore();
    }

    c.restore();
  }

  /**
   * A chequered strip: two offset rows of alternating cream and ink cells,
   * sheared with the card.
   *
   * Two rows, not one. A single row of alternating cells on a dark panel reads
   * as a dashed rule — the ink cells simply disappear into the backing and only
   * the cream ones are marks. Offsetting a second row by one cell is what makes
   * the eye see a chequered flag instead, and it is the same figure the minimap's
   * start/finish bar and the in-world banner already use.
   *
   * Drawn as filled parallelograms rather than rects so it leans with everything
   * else on the panel instead of being the one axis-aligned thing on it.
   */
  private drawChequer(ink: Ink, x: number, y: number, w: number, h: number): void {
    const c = ink.ctx;
    const cells = Math.max(6, Math.round(w / (h * 0.62)));
    const cw = w / cells;
    const rowH = h * 0.5;
    const lean = h * 0.5;

    for (let r = 0; r < 2; r++) {
      const y0 = y + r * rowH;
      for (let i = 0; i < cells; i++) {
        const x0 = x + i * cw;
        // The shear is taken from the row's own height, so the two rows stack
        // into one continuous parallelogram rather than stepping apart.
        const l0 = lean * (1 - (r * rowH) / h);
        const l1 = lean * (1 - ((r + 1) * rowH) / h);
        c.beginPath();
        c.moveTo(x0 + l0, y0);
        c.lineTo(x0 + cw + l0, y0);
        c.lineTo(x0 + cw + l1, y0 + rowH);
        c.lineTo(x0 + l1, y0 + rowH);
        c.closePath();
        c.fillStyle = (i + r) % 2 === 0 ? CSS.cream : CSS.ink;
        c.fill();
      }
    }
  }

  /**
   * One results row: place chip, hull colour, name, gap to the winner, total,
   * best lap — with the race's fastest lap flagged wherever it was set.
   *
   * The gap column is the number a results board exists to show. "Second, and
   * 0.68 off" is a race; "second" on its own is a list.
   */
  private drawRow(
    ink: Ink,
    b: Boat,
    isPlayer: boolean,
    row: number,
    px: number,
    y: number,
    pw: number,
    k: number,
    winTime: number,
    fastest: number,
    totalLaps: number
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
    // Secondary text. `CSS.dim` on `CSS.deep` was the low-contrast pair that made
    // "DNF" and "--:--.--" read as unfinished rendering rather than as content;
    // crest on deep, and inkSoft on the cream player slab, both hold up.
    const sub = isPlayer ? CSS.inkSoft : CSS.crest;
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

    let best = Number.POSITIVE_INFINITY;
    const laps = b.progress.lapTimes;
    for (let i = 0; i < laps.length; i++) {
      const lt = laps[i] as number;
      if (lt < best) best = lt;
    }

    const total = b.progress.finishTime;
    const baseY = y + h * 0.5;

    // --- gap -----------------------------------------------------------------
    // The winner gets an em dash, not "+0.00" — there is nothing to be behind.
    // A racer who never finished gets the laps they did complete, which is the
    // honest thing to put there and stops the cell reading as missing data.
    ink.font(19 * s, 900);
    ink.tracking = 0.4 * s;
    if (total === null) {
      ink.mono = false;
      ink.style(sub, CSS.ink, 0);
      ink.draw(b.progress.lap + '/' + totalLaps + ' LAPS', x + w - COL_GAP * s, baseY + 7 * s, 1);
    } else if (row === 0 || !Number.isFinite(winTime)) {
      ink.mono = false;
      ink.style(sub, CSS.ink, 0);
      ink.draw('—', x + w - COL_GAP * s, baseY + 7 * s, 1);
    } else {
      ink.mono = true;
      ink.style(isPlayer ? CSS.inkSoft : CSS.accent, CSS.ink, strokeW * 0.75);
      ink.draw('+' + (total - winTime).toFixed(2), x + w - COL_GAP * s, baseY + 7 * s, 1);
    }

    // --- total ---------------------------------------------------------------
    // Mono and right-aligned: a results table that shifts its decimal points
    // column to column is unreadable at a glance.
    ink.font(23 * s, 900);
    ink.tracking = 0.4 * s;
    ink.mono = total !== null;
    ink.style(total === null ? sub : fg, CSS.ink, strokeW);
    ink.draw(total === null ? 'DNF' : ink.fmtTime(total), x + w - COL_TOTAL * s, baseY + 8 * s, 1);

    // --- best lap ------------------------------------------------------------
    const hasBest = Number.isFinite(best);
    // The fastest lap of the whole race, flagged where it was set. Pink is the
    // drift colour, which is the only other place in this HUD that means "this
    // one is special" — and it is the flag every real results board carries.
    const isFastest = hasBest && best <= fastest + 1e-6;
    ink.font(17 * s, 800);
    ink.tracking = 0.4 * s;
    ink.mono = hasBest;
    const bestX = x + w - COL_BEST * s;
    if (isFastest) {
      // Measured under the exact font, tracking and mono setting it is drawn
      // with, so the chip fits the glyphs rather than an estimate of them.
      const bw = ink.measure(ink.fmtTime(best));
      ink.panel(
        bestX - bw - 30 * s, y + 11 * s, bw + 32 * s, h - 22 * s,
        0.1, 6 * s, CSS.drift, 2.2 * s, CSS.ink, 3 * s
      );
      ink.style(CSS.ink, CSS.ink, 0);
    } else {
      ink.style(hasBest ? (isPlayer ? CSS.inkSoft : CSS.warn) : sub, CSS.ink, 0);
    }
    ink.draw(ink.fmtTime(hasBest ? best : -1), bestX - (isFastest ? 8 * s : 0), baseY + 7 * s, 1);
    ink.mono = false;

    c.restore();
  }
}
