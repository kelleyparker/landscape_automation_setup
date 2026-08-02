import type { BoatInput } from './types';

/**
 * Keyboard + gamepad input, smoothed into a `BoatInput`.
 *
 * Steering is ramped rather than binary so keyboard play still feels analogue;
 * a gamepad stick overrides the ramp with its raw value when present.
 */
export class Input {
  private readonly keys = new Set<string>();
  private steerAxis = 0;
  private throttleAxis = 0;

  readonly value: BoatInput = { throttle: 0, steer: 0, drift: false, boost: false };

  /** Set while the harness is driving input synthetically. */
  scripted: BoatInput | null = null;

  private restartHandlers: (() => void)[] = [];

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
  }

  onRestart(fn: () => void): void { this.restartHandlers.push(fn); }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);
    if (e.code === 'KeyR') for (const h of this.restartHandlers) h();
    // Stop the page scrolling under the game.
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => { this.keys.delete(e.code); };

  private held(...codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  update(dt: number): BoatInput {
    if (this.scripted) {
      Object.assign(this.value, this.scripted);
      return this.value;
    }

    const pad = navigator.getGamepads?.().find((p) => p && p.connected) ?? null;

    // --- steering: ramp toward the held direction, spring back to centre ----
    let steerTarget = 0;
    if (this.held('ArrowLeft', 'KeyA')) steerTarget -= 1;
    if (this.held('ArrowRight', 'KeyD')) steerTarget += 1;
    if (pad) {
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > 0.12) steerTarget = ax;
    }
    const steerRate = steerTarget === 0 ? 9.0 : 5.5;
    this.steerAxis += (steerTarget - this.steerAxis) * Math.min(1, steerRate * dt);

    // --- throttle ----------------------------------------------------------
    let throttleTarget = 0;
    if (this.held('ArrowUp', 'KeyW')) throttleTarget += 1;
    if (this.held('ArrowDown', 'KeyS')) throttleTarget -= 1;
    if (pad) {
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      if (rt > 0.05 || lt > 0.05) throttleTarget = rt - lt;
    }
    this.throttleAxis += (throttleTarget - this.throttleAxis) * Math.min(1, 6.5 * dt);

    this.value.steer = Math.max(-1, Math.min(1, this.steerAxis));
    this.value.throttle = Math.max(-1, Math.min(1, this.throttleAxis));
    this.value.drift = this.held('Space', 'ShiftLeft', 'ShiftRight') || !!pad?.buttons[0]?.pressed;
    this.value.boost = this.held('KeyE', 'ControlLeft') || !!pad?.buttons[1]?.pressed;
    return this.value;
  }
}
