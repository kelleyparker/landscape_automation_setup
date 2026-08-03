/**
 * Player-facing settings.
 *
 * Deliberately tiny: a plain state object plus a change callback. Every entry
 * here has to be wired to something that already exists and visibly do
 * something - a settings screen whose controls change nothing is worse than
 * having no settings screen, because it teaches the player their input does not
 * matter.
 *
 * Not persisted. Nothing is written to localStorage, so settings reset each
 * session; adding persistence is a few lines here and nowhere else.
 */

export interface SettingsState {
  /** Cap on devicePixelRatio, 0.5..2. The single biggest performance lever. */
  resolutionScale: number;
  /** Screen-space Sobel interior lines. */
  edges: boolean;
  /** Stylised bloom on emissive surfaces. */
  bloom: boolean;
  /** 0..1, applied to the audio master gain. */
  masterVolume: number;
  muted: boolean;
  /** 0..1 multiplier on impact screenshake. Some players want none. */
  cameraShake: number;
  /** 0..1 multiplier on the speed/boost FOV kick. */
  fovKick: number;
}

export const DEFAULT_SETTINGS: SettingsState = {
  resolutionScale: 1,
  edges: true,
  bloom: true,
  masterVolume: 0.8,
  muted: false,
  cameraShake: 1,
  fovKick: 1,
};

export type SettingsKey = keyof SettingsState;

/** A single row in the settings UI, describing how to render and edit one key. */
export interface SettingSpec {
  key: SettingsKey;
  label: string;
  kind: 'toggle' | 'range';
  /** For ranges: the discrete steps the player can select. */
  steps?: number[];
  /** Renders the current value as text. */
  format(v: SettingsState[SettingsKey]): string;
}

const pct = (v: number): string => Math.round(v * 100) + '%';

export const SETTING_SPECS: SettingSpec[] = [
  {
    key: 'resolutionScale', label: 'RESOLUTION', kind: 'range',
    steps: [0.5, 0.66, 0.75, 0.85, 1, 1.25, 1.5, 2],
    format: (v) => (v as number).toFixed(2) + 'x',
  },
  { key: 'edges', label: 'INK LINES', kind: 'toggle', format: (v) => (v ? 'ON' : 'OFF') },
  { key: 'bloom', label: 'GLOW', kind: 'toggle', format: (v) => (v ? 'ON' : 'OFF') },
  {
    key: 'masterVolume', label: 'VOLUME', kind: 'range',
    steps: [0, 0.2, 0.4, 0.6, 0.8, 1],
    format: (v) => pct(v as number),
  },
  {
    key: 'cameraShake', label: 'SCREEN SHAKE', kind: 'range',
    steps: [0, 0.25, 0.5, 0.75, 1],
    format: (v) => ((v as number) === 0 ? 'OFF' : pct(v as number)),
  },
  {
    key: 'fovKick', label: 'SPEED FOV', kind: 'range',
    steps: [0, 0.25, 0.5, 0.75, 1],
    format: (v) => ((v as number) === 0 ? 'OFF' : pct(v as number)),
  },
];

export class Settings {
  readonly state: SettingsState = { ...DEFAULT_SETTINGS };
  private readonly listeners: ((s: SettingsState) => void)[] = [];

  onChange(fn: (s: SettingsState) => void): void {
    this.listeners.push(fn);
    fn(this.state); // apply immediately so nothing depends on a first edit
  }

  set<K extends SettingsKey>(key: K, value: SettingsState[K]): void {
    if (this.state[key] === value) return;
    this.state[key] = value;
    for (const fn of this.listeners) fn(this.state);
  }

  /** Steps a range setting by +/-1 along its discrete steps, or flips a toggle. */
  nudge(spec: SettingSpec, dir: number): void {
    if (spec.kind === 'toggle') {
      this.set(spec.key, !this.state[spec.key] as never);
      return;
    }
    const steps = spec.steps!;
    const current = this.state[spec.key] as number;
    // Nearest step, so a value that is not exactly on the ladder still moves
    // sensibly rather than jumping to an end.
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < steps.length; i++) {
      const d = Math.abs(steps[i]! - current);
      if (d < best) { best = d; idx = i; }
    }
    const next = Math.max(0, Math.min(steps.length - 1, idx + dir));
    this.set(spec.key, steps[next] as never);
  }
}
