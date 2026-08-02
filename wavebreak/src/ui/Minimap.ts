import * as THREE from 'three';
import { CSS, RACER_CSS } from '../core/Palette';
import type { Boat } from '../boat/Boat';
import type { Course } from '../race/Course';
import type { Ink } from './Hud';

/**
 * THE MINIMAP — the circuit as a drawn object, not a radar sweep.
 *
 * ## North-up, not heading-up
 *
 * A heading-up map has to be rebuilt (or at least re-transformed) every frame
 * and, worse, it never lets the player learn the circuit: the same corner looks
 * different every lap. "Anchorline" is a fixed 2.68 km loop with a hairpin, a
 * chicane and a very distinctive long left — it is a shape worth memorising. So
 * the map is locked north-up with a heading arrow on the player's dot, which is
 * the arrangement that answers *both* questions a minimap is asked: "where am I
 * on the lap" (the shape) and "which way am I pointing" (the arrow).
 *
 * The consequence is that the spline can be baked into a single `Path2D` in
 * world coordinates exactly once, and every frame is one `stroke()` per pass
 * plus four dots.
 *
 * ## What it shows
 *
 * The track ribbon (ink shell, blue body, green centre line — the same reading
 * as the in-world racing line), all twelve gates as ticks with the player's next
 * checkpoint lit, a chequered start/finish bar, and the four racers in their
 * hull colours. The player's dot is larger, inked, and carries the heading
 * arrow; it draws last so it is never hidden under a pack.
 */

// --------------------------------------------------------------- layout -----

/** Panel size in design pixels, portrait because the circuit is taller than it is wide. */
const PANEL_W = 216;
const PANEL_H = 250;
/** Screen margin, matching the rest of the HUD. */
const MARGIN = 22;
/** Inset from the panel edge to the map's drawing area. */
const PAD = 16;
/** Header strip height, where the circuit name and the compass live. */
const HEADER = 26;

/** A whole-panel tilt. Small, but it is what stops the HUD reading as a grid. */
const TILT = -0.022;

// ---------------------------------------------------------------- course -----

/**
 * Spline samples used to build the polyline. 260 points over 2.68 km is one
 * every 10 m, which at any sane minimap scale is well under a pixel of chord
 * error even through the 30 m hairpin.
 */
const SPLINE_SAMPLES = 260;

/** Track ribbon widths, in design pixels: ink shell, body, centre line. */
const TRACK_INK = 8.5;
const TRACK_BODY = 5.2;
const TRACK_LINE = 1.6;

/** Racer dot radii, design pixels. */
const DOT_AI = 3.6;
const DOT_PLAYER = 5.6;

// --------------------------------------------------------------- scratch -----

const _p = new THREE.Vector3();

export class Minimap {
  /** The circuit polyline in world XZ, mapped to canvas axes. Built once. */
  private path: Path2D | null = null;
  private midX = 0;
  private midY = 0;
  private spanX = 1;
  private spanY = 1;

  /** Gate midpoints and tick directions, flattened. Gates are moored: XZ never moves. */
  private gateX = new Float32Array(0);
  private gateY = new Float32Array(0);
  /** Unit vector *across* the gate, i.e. perpendicular to the direction of travel. */
  private gateAX = new Float32Array(0);
  private gateAY = new Float32Array(0);
  /** Index of the gate on the start/finish line. */
  private startGate = 0;

  // ------------------------------------------------------------- building ---

  /**
   * Bakes the circuit.
   *
   * `course.curve` is sampled rather than the arc-length table because the curve
   * is the authoritative shape and a minimap does not care about uniform
   * spacing — it cares that the drawn loop is the loop. World XZ maps to canvas
   * XY as (x, -z), so world +Z points up the panel; that direction is what the
   * compass calls north.
   */
  private build(course: Course): void {
    const p = new Path2D();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i <= SPLINE_SAMPLES; i++) {
      course.curve.getPoint(i / SPLINE_SAMPLES, _p);
      const x = _p.x;
      const y = -_p.z;
      if (i === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    p.closePath();

    this.path = p;
    this.midX = (minX + maxX) * 0.5;
    this.midY = (minY + maxY) * 0.5;
    this.spanX = Math.max(1, maxX - minX);
    this.spanY = Math.max(1, maxY - minY);

    const gates = course.gates;
    const n = gates.length;
    this.gateX = new Float32Array(n);
    this.gateY = new Float32Array(n);
    this.gateAX = new Float32Array(n);
    this.gateAY = new Float32Array(n);

    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const g = gates[i]!;
      this.gateX[i] = g.center.x;
      this.gateY[i] = -g.center.z;
      // The gate normal points along the direction of travel; the bar across the
      // gate is its world perpendicular (-nz, nx), mapped through the same
      // (x, -z) flip the polyline used, which lands on (-nz, -nx).
      this.gateAX[i] = -g.normal.z;
      this.gateAY[i] = -g.normal.x;
      // Same rule the race director uses: the lap line is the gate nearest the
      // spline seam, measured circularly so t = 0.998 counts as being at it.
      const t = g.t - Math.floor(g.t);
      const d = Math.min(t, 1 - t);
      if (d < bestD) {
        bestD = d;
        this.startGate = i;
      }
    }
  }

  // ---------------------------------------------------------------- draw ----

  render(ink: Ink, boats: Boat[], player: Boat, course: Course, t: number): void {
    if (!this.path) this.build(course);
    const path = this.path;
    if (!path) return;

    const c = ink.ctx;
    const s = ink.s;
    const w = PANEL_W * s;
    const h = PANEL_H * s;
    const x = ink.w - MARGIN * s - w;
    const y = MARGIN * s;

    c.save();
    // Tilt about the panel's own centre so it stays anchored to its corner.
    c.translate(x + w * 0.5, y + h * 0.5);
    c.rotate(TILT);
    c.translate(-(x + w * 0.5), -(y + h * 0.5));

    ink.panel(x, y, w, h, 0.05, 16 * s, CSS.panel, 3.6 * s, CSS.ink, 6 * s);

    // --- header --------------------------------------------------------------
    ink.font(12 * s, 800);
    ink.tracking = 3 * s;
    ink.mono = false;
    ink.style(CSS.dim, CSS.ink, 0);
    ink.draw('ANCHORLINE', x + PAD * s, y + 19 * s, -1);

    // Compass. World +Z is up the panel by construction, and the panel is tilted,
    // so the needle is drawn inside the same transform and stays honest.
    const nx = x + w - PAD * s - 4 * s;
    const ny = y + 15 * s;
    c.beginPath();
    c.moveTo(nx, ny - 7 * s);
    c.lineTo(nx + 4.2 * s, ny + 5 * s);
    c.lineTo(nx, ny + 2 * s);
    c.lineTo(nx - 4.2 * s, ny + 5 * s);
    c.closePath();
    c.fillStyle = CSS.crest;
    c.fill();
    c.lineWidth = 1.6 * s;
    c.lineJoin = 'round';
    c.strokeStyle = CSS.ink;
    c.stroke();
    ink.font(10 * s, 900);
    ink.tracking = 0;
    ink.style(CSS.dim, CSS.ink, 0);
    ink.draw('N', nx - 13 * s, ny + 5 * s, 0);

    // --- map well ------------------------------------------------------------
    const wellX = x + PAD * s;
    const wellY = y + (HEADER + 4) * s;
    const wellW = w - PAD * 2 * s;
    const wellH = h - (HEADER + 4 + PAD) * s;

    c.save();
    ink.tracePanel(wellX, wellY, wellW, wellH, 0.03, 10 * s);
    c.fillStyle = CSS.deep;
    c.fill();
    c.clip();

    // Fit the circuit into the well with a little breathing room; aspect is
    // preserved, so the shape of the lap is never lied about.
    const sc = Math.min(wellW / (this.spanX * 1.1), wellH / (this.spanY * 1.1));
    const cx = wellX + wellW * 0.5;
    const cy = wellY + wellH * 0.5;

    // --- track ribbon --------------------------------------------------------
    c.save();
    c.translate(cx, cy);
    c.scale(sc, sc);
    c.translate(-this.midX, -this.midY);
    c.lineJoin = 'round';
    c.lineCap = 'round';
    // Widths are divided by the scale so they land as the authored pixel count
    // no matter how the circuit had to be squeezed into the panel.
    c.lineWidth = (TRACK_INK * s) / sc;
    c.strokeStyle = CSS.ink;
    c.stroke(path);
    c.lineWidth = (TRACK_BODY * s) / sc;
    c.strokeStyle = CSS.sky;
    c.stroke(path);
    c.lineWidth = (TRACK_LINE * s) / sc;
    c.strokeStyle = CSS.good;
    c.stroke(path);
    c.restore();

    // --- gates ---------------------------------------------------------------
    const litGate = player.progress.finishTime === null ? player.progress.nextGate : -1;
    const gatePulse = (t % 0.6) / 0.6 < 0.55;
    for (let i = 0; i < this.gateX.length; i++) {
      const gx = cx + ((this.gateX[i] as number) - this.midX) * sc;
      const gy = cy + ((this.gateY[i] as number) - this.midY) * sc;
      const ax = this.gateAX[i] as number;
      const ay = this.gateAY[i] as number;
      if (i === this.startGate) continue; // drawn as the chequered bar below
      const len = (i === litGate ? 8.5 : 6) * s;
      c.beginPath();
      c.moveTo(gx - ax * len, gy - ay * len);
      c.lineTo(gx + ax * len, gy + ay * len);
      c.lineCap = 'butt';
      c.lineWidth = (i === litGate ? 5.4 : 3.2) * s;
      c.strokeStyle = CSS.ink;
      c.stroke();
      c.lineWidth = (i === litGate ? 3.2 : 1.6) * s;
      c.strokeStyle = i === litGate ? (gatePulse ? CSS.foam : CSS.good) : CSS.dim;
      c.stroke();
    }

    // --- start / finish ------------------------------------------------------
    this.drawStartMarker(ink, cx, cy, sc);

    // --- racers --------------------------------------------------------------
    // AI first, player last: in a pack the dot that matters must be on top.
    for (let i = 0; i < boats.length; i++) {
      const b = boats[i] as Boat;
      if (b.isPlayer) continue;
      this.drawDot(ink, b, cx, cy, sc, false);
    }
    this.drawDot(ink, player, cx, cy, sc, true);

    c.restore(); // well clip

    // Border on top of the clipped contents, so the ink is never half-covered.
    ink.tracePanel(wellX, wellY, wellW, wellH, 0.03, 10 * s);
    c.lineJoin = 'miter';
    c.lineWidth = 2.6 * s;
    c.strokeStyle = CSS.ink;
    c.stroke();

    c.restore(); // tilt
  }

  /**
   * The chequered start/finish bar.
   *
   * Six alternating cells laid across the gate, drawn as short thick strokes
   * rather than as rectangles so the bar keeps a constant pixel width whichever
   * way the line happens to be oriented on the map.
   */
  private drawStartMarker(ink: Ink, cx: number, cy: number, sc: number): void {
    const i = this.startGate;
    if (i >= this.gateX.length) return;
    const c = ink.ctx;
    const s = ink.s;
    const gx = cx + ((this.gateX[i] as number) - this.midX) * sc;
    const gy = cy + ((this.gateY[i] as number) - this.midY) * sc;
    const ax = this.gateAX[i] as number;
    const ay = this.gateAY[i] as number;

    const CELLS = 6;
    const half = 10 * s;
    const cell = (half * 2) / CELLS;

    c.lineCap = 'butt';
    c.lineWidth = 8 * s;
    c.strokeStyle = CSS.ink;
    c.beginPath();
    c.moveTo(gx - ax * half, gy - ay * half);
    c.lineTo(gx + ax * half, gy + ay * half);
    c.stroke();

    c.lineWidth = 5 * s;
    for (let k = 0; k < CELLS; k++) {
      const t0 = -half + k * cell;
      const t1 = t0 + cell;
      c.beginPath();
      c.moveTo(gx + ax * t0, gy + ay * t0);
      c.lineTo(gx + ax * t1, gy + ay * t1);
      c.strokeStyle = k % 2 === 0 ? CSS.foam : CSS.ink;
      c.stroke();
    }
  }

  /** One racer. The player gets a bigger disc, heavier ink and a heading arrow. */
  private drawDot(ink: Ink, b: Boat, cx: number, cy: number, sc: number, isPlayer: boolean): void {
    const c = ink.ctx;
    const s = ink.s;
    const px = cx + (b.state.position.x - this.midX) * sc;
    const py = cy + (-b.state.position.z - this.midY) * sc;
    const col = RACER_CSS[((b.index % 4) + 4) % 4] as string;
    const r = (isPlayer ? DOT_PLAYER : DOT_AI) * s;

    if (isPlayer) {
      // Heading arrow. BoatState.heading is a yaw with 0 = +Z, and +Z is up the
      // panel, so the world direction (sin h, cos h) becomes (sin h, -cos h)
      // here — which points straight up at heading 0, as it must.
      const hx = Math.sin(b.state.heading);
      const hy = -Math.cos(b.state.heading);
      const sx = -hy;
      const sy = hx;
      const tip = 15 * s;
      const wing = 6.5 * s;
      const back = 2 * s;
      c.beginPath();
      c.moveTo(px + hx * tip, py + hy * tip);
      c.lineTo(px + sx * wing - hx * back, py + sy * wing - hy * back);
      c.lineTo(px - sx * wing - hx * back, py - sy * wing - hy * back);
      c.closePath();
      c.fillStyle = col;
      c.fill();
      c.lineJoin = 'round';
      c.lineWidth = 2.4 * s;
      c.strokeStyle = CSS.ink;
      c.stroke();
    }

    c.beginPath();
    c.arc(px, py, r, 0, Math.PI * 2);
    c.fillStyle = col;
    c.fill();
    c.lineWidth = (isPlayer ? 2.6 : 1.8) * s;
    c.strokeStyle = CSS.ink;
    c.stroke();

    if (isPlayer) {
      // A cream pip in the middle: at a glance the player's dot reads as a
      // target rather than as the fourth colour in a row of four.
      c.beginPath();
      c.arc(px, py, r * 0.38, 0, Math.PI * 2);
      c.fillStyle = CSS.cream;
      c.fill();
    }
  }
}
