import { CSS } from '../core/Palette';
import { SETTING_SPECS, type Settings, type SettingSpec } from '../core/Settings';

/**
 * Pause and settings, drawn on the same 2D overlay canvas as the HUD and in the
 * same visual language: chunky ink outlines, flat fills, hard offset shadows and
 * panels rotated a degree or two off square so it reads as designed anime UI
 * rather than a stack of rectangles.
 *
 * It draws AFTER the HUD each frame, over a live but un-ticked scene - the world
 * stays on screen behind a dim, which keeps the player oriented and is much
 * cheaper than rendering a separate menu state.
 */

type Page = 'main' | 'settings';

const MAIN_ITEMS = ['RESUME', 'RESTART RACE', 'SETTINGS'] as const;

export class PauseMenu {
  visible = false;
  private page: Page = 'main';
  private index = 0;
  /** Eased 0..1 open animation, so the panel punches in rather than appearing. */
  private open = 0;
  private t = 0;

  constructor(
    private readonly settings: Settings,
    private readonly onResume: () => void,
    private readonly onRestart: () => void
  ) {}

  show(): void { this.visible = true; this.page = 'main'; this.index = 0; }
  hide(): void { this.visible = false; this.open = 0; }
  toggle(): void { if (this.visible) { this.hide(); this.onResume(); } else this.show(); }

  /** Discrete key handling. Returns true if the key was consumed by the menu. */
  handleKey(code: string): boolean {
    if (!this.visible) return false;
    const items = this.page === 'main' ? MAIN_ITEMS.length : SETTING_SPECS.length + 1;

    switch (code) {
      case 'ArrowUp': case 'KeyW':
        this.index = (this.index - 1 + items) % items; return true;
      case 'ArrowDown': case 'KeyS':
        this.index = (this.index + 1) % items; return true;
      case 'ArrowLeft': case 'KeyA':
        if (this.page === 'settings' && this.index < SETTING_SPECS.length) {
          this.settings.nudge(SETTING_SPECS[this.index]!, -1);
        }
        return true;
      case 'ArrowRight': case 'KeyD':
        if (this.page === 'settings' && this.index < SETTING_SPECS.length) {
          this.settings.nudge(SETTING_SPECS[this.index]!, +1);
        }
        return true;
      case 'Enter': case 'Space':
        this.activate(); return true;
      case 'Escape':
        if (this.page === 'settings') { this.page = 'main'; this.index = 2; }
        else { this.hide(); this.onResume(); }
        return true;
      default:
        return false;
    }
  }

  private activate(): void {
    if (this.page === 'main') {
      if (this.index === 0) { this.hide(); this.onResume(); }
      else if (this.index === 1) { this.hide(); this.onRestart(); }
      else { this.page = 'settings'; this.index = 0; }
      return;
    }
    // Settings page: the last row is BACK; toggles flip on Enter too.
    if (this.index === SETTING_SPECS.length) { this.page = 'main'; this.index = 2; return; }
    const spec = SETTING_SPECS[this.index]!;
    if (spec.kind === 'toggle') this.settings.nudge(spec, 1);
  }

  /**
   * @param ctx  the HUD canvas context, already scaled to CSS pixels
   * @param w,h  CSS-pixel viewport size
   */
  render(ctx: CanvasRenderingContext2D, w: number, h: number, dt: number): void {
    if (!this.visible && this.open <= 0) return;
    this.t += dt;
    const target = this.visible ? 1 : 0;
    this.open += (target - this.open) * Math.min(1, dt * 14);
    const k = this.open;

    // Dim the world. Not black - a navy wash keeps the palette intact.
    ctx.save();
    ctx.globalAlpha = 0.72 * k;
    ctx.fillStyle = CSS.ink;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    const rows = this.page === 'main' ? MAIN_ITEMS.length : SETTING_SPECS.length + 1;
    const rowH = 54;
    const panelW = this.page === 'main' ? 420 : 620;
    const panelH = rows * rowH + 132;
    const cx = w / 2;
    const cy = h / 2;

    ctx.save();
    ctx.translate(cx, cy);
    // Overshoot on open, then settle - the same punch the HUD uses.
    const s = 0.94 + k * 0.06 + Math.sin(Math.min(1, k) * Math.PI) * 0.03;
    ctx.scale(s, s);
    ctx.rotate(-0.012);
    ctx.globalAlpha = k;

    this.panel(ctx, -panelW / 2, -panelH / 2, panelW, panelH);

    // Title
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.stickerText(ctx, this.page === 'main' ? 'PAUSED' : 'SETTINGS', 0, -panelH / 2 + 46, 38, CSS.cream);

    const top = -panelH / 2 + 104;
    if (this.page === 'main') {
      MAIN_ITEMS.forEach((label, i) => {
        this.row(ctx, label, '', i === this.index, 0, top + i * rowH, panelW - 72);
      });
    } else {
      SETTING_SPECS.forEach((spec: SettingSpec, i) => {
        const value = spec.format(this.settings.state[spec.key]);
        this.row(ctx, spec.label, value, i === this.index, 0, top + i * rowH, panelW - 72, spec.kind === 'range');
      });
      this.row(ctx, 'BACK', '', this.index === SETTING_SPECS.length, 0,
        top + SETTING_SPECS.length * rowH, panelW - 72);
    }

    ctx.restore();

    // Footer hint, outside the panel transform so it stays level.
    ctx.save();
    ctx.globalAlpha = k * 0.85;
    ctx.textAlign = 'center';
    ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
    ctx.letterSpacing = '2px';
    ctx.fillStyle = CSS.dim;
    ctx.fillText(
      this.page === 'settings'
        ? 'W/S SELECT     A/D ADJUST     ENTER CONFIRM     ESC BACK'
        : 'W/S SELECT     ENTER CONFIRM     ESC RESUME',
      cx, cy + panelH / 2 + 34
    );
    ctx.restore();
  }

  // ------------------------------------------------------------- drawing ----

  /** Flat fill, chunky ink outline, hard offset shadow. No blur anywhere. */
  private panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    const r = 14;
    ctx.save();
    ctx.fillStyle = CSS.accent;
    this.roundRect(ctx, x + 9, y + 10, w, h, r);
    ctx.fill();
    ctx.fillStyle = CSS.panel;
    ctx.strokeStyle = CSS.ink;
    ctx.lineWidth = 4;
    this.roundRect(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private row(
    ctx: CanvasRenderingContext2D, label: string, value: string,
    selected: boolean, cx: number, y: number, w: number, showArrows = false
  ): void {
    const h = 42;
    const x = cx - w / 2;
    ctx.save();
    if (selected) {
      // Selected row gets a coral plate and a small nudge right, so selection
      // reads by shape and position, not by colour alone.
      ctx.translate(6, 0);
      ctx.fillStyle = CSS.accent;
      ctx.strokeStyle = CSS.ink;
      ctx.lineWidth = 3;
      this.roundRect(ctx, x, y - h / 2, w, h, 8);
      ctx.fill();
      ctx.stroke();
    }
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = '800 19px ui-sans-serif, system-ui, sans-serif';
    ctx.letterSpacing = '1.5px';
    ctx.fillStyle = selected ? CSS.ink : CSS.cream;
    ctx.fillText(label, x + 18, y);

    if (value) {
      ctx.textAlign = 'right';
      ctx.fillStyle = selected ? CSS.ink : CSS.warn;
      ctx.fillText(value, x + w - (showArrows ? 34 : 18), y);
      if (showArrows && selected) {
        // Chevrons only on the selected range row - a permanent pair on every
        // row turns the list into visual noise.
        ctx.fillStyle = CSS.ink;
        ctx.textAlign = 'center';
        ctx.font = '800 15px ui-sans-serif, system-ui, sans-serif';
        const pulse = 1 + Math.sin(this.t * 7) * 0.12;
        ctx.save(); ctx.translate(x + w - 18, y); ctx.scale(pulse, pulse);
        ctx.fillText('>', 0, 0); ctx.restore();
        ctx.save(); ctx.translate(x + 4 + w * 0 - 0, y); ctx.restore();
      }
    }
    ctx.restore();
  }

  private stickerText(
    ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, fill: string
  ): void {
    ctx.save();
    ctx.font = `900 ${size}px ui-sans-serif, system-ui, sans-serif`;
    ctx.letterSpacing = `${size * 0.06}px`;
    ctx.lineJoin = 'round';
    ctx.lineWidth = size * 0.22;
    ctx.strokeStyle = CSS.ink;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  private roundRect(
    ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
