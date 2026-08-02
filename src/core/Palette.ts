import * as THREE from 'three';

/**
 * WAVEBREAK palette - "Tropic Ink".
 *
 * One palette, committed to, used by water, sky, hulls, riders, VFX and HUD.
 * High saturation, limited hue set, deep indigo ink instead of pure black so
 * lines read as drawn rather than as missing pixels.
 *
 * RULE FOR ALL CONTRIBUTORS: never hardcode a hex literal in a subsystem.
 * Import from here. If a colour is missing, add it here first.
 */

const c = (hex: string) => new THREE.Color(hex).convertSRGBToLinear();

export const PALETTE = {
  // --- Ink -----------------------------------------------------------------
  /** Outline / edge ink. Deep indigo, never pure black. */
  ink: c('#101a35'),
  /** Softer ink for interior screen-space lines. */
  inkSoft: c('#22335e'),

  // --- Ocean ---------------------------------------------------------------
  /** Deepest trough band. */
  waterDeep: c('#0a3a78'),
  /** Body of the wave. */
  waterMid: c('#1873cf'),
  /** Upper shoulder, catching sky. */
  waterShallow: c('#2fb3e6'),
  /** Crest band just under the foam line. */
  waterCrest: c('#7ee8f5'),
  /** Foam / whitewater. Very slightly cool, never pure white. */
  foam: c('#eefcff'),
  /** Foam's shadowed side, keeps foam from reading as a flat blob. */
  foamShade: c('#a8dcf0'),
  /** Subsurface glow through a thin crest, backlit by the sun. */
  waterTranslucent: c('#4cf0d8'),

  // --- Sky -----------------------------------------------------------------
  skyZenith: c('#0f4fbd'),
  skyMid: c('#3fa2ee'),
  skyHorizon: c('#c4f2ff'),
  cloudLit: c('#ffffff'),
  cloudShade: c('#a9cdf0'),
  cloudRim: c('#ffe9a8'),
  sunCore: c('#fffbe0'),
  sunGlow: c('#ffd166'),

  // --- Racers --------------------------------------------------------------
  /** Player. Hot coral. */
  racerP1: c('#ff3d6e'),
  /** AI "Vex" - aggressive. Acid green. */
  racerP2: c('#3dff92'),
  /** AI "Nori" - clean/precise. Violet. */
  racerP3: c('#a366ff'),
  /** AI "Gus" - erratic. Tangerine. */
  racerP4: c('#ff9424'),

  /** Shared hull secondary + trim. */
  hullTrim: c('#ffd23f'),
  hullDark: c('#1c2a52'),
  hullLight: c('#f6f9ff'),
  metal: c('#8fa7d4'),

  // --- Characters ----------------------------------------------------------
  skinA: c('#ffcfa8'),
  skinB: c('#c98a5e'),
  skinC: c('#8a5a3c'),
  suitDark: c('#243356'),
  visor: c('#5ce6ff'),

  // --- Course / VFX --------------------------------------------------------
  /** Glowing green racing line. */
  raceLine: c('#5cff9d'),
  raceLineHot: c('#c8ffe0'),
  gateLit: c('#5cff9d'),
  gateIdle: c('#ff8ab0'),
  boostFlame: c('#ffe36b'),
  boostFlameHot: c('#ffffff'),
  driftSpark: c('#ff5ea8'),
  /**
   * Identity multiplier, for materials whose actual colour arrives per-vertex or
   * per-instance (course pylons and buoys paint their bands into the `color`
   * attribute). Not a colour choice - it is the absence of one, and it exists so
   * those call sites never have to write a literal.
   */
  neutral: c('#ffffff'),

  // --- HUD -----------------------------------------------------------------
  hudInk: '#101a35',
  hudPanel: '#16244a',
  hudCream: '#fff4d6',
  hudAccent: '#ff3d6e',
  hudGood: '#5cff9d',
  hudWarn: '#ffd23f',
  hudDim: '#6d84b8',
} as const;

/** CSS-space (non-linear) versions for the 2D HUD canvas. */
export const CSS = {
  ink: '#101a35',
  inkSoft: '#22335e',
  panel: '#16244a',
  panelEdge: '#3355a0',
  cream: '#fff4d6',
  accent: '#ff3d6e',
  good: '#5cff9d',
  warn: '#ffd23f',
  dim: '#6d84b8',
  p1: '#ff3d6e',
  p2: '#3dff92',
  p3: '#a366ff',
  p4: '#ff9424',
  sky: '#3fa2ee',
  water: '#1873cf',
  /** Drift-charge pink. CSS twin of `PALETTE.driftSpark`. */
  drift: '#ff5ea8',
  /** Boost gold. CSS twin of `PALETTE.boostFlame`. */
  boost: '#ffe36b',
  /** Deep-water blue, for HUD wells such as the minimap ground. Twin of `waterDeep`. */
  deep: '#0a3a78',
  /** Crest cyan, for HUD highlights. Twin of `waterCrest`. */
  crest: '#7ee8f5',
  /** Foam white, for HUD chequers and hot flashes. Twin of `foam`. */
  foam: '#eefcff',
} as const;

/** Racer body colours indexed by racer slot 0..3. */
export const RACER_COLORS = [
  PALETTE.racerP1,
  PALETTE.racerP2,
  PALETTE.racerP3,
  PALETTE.racerP4,
] as const;

export const RACER_CSS = [CSS.p1, CSS.p2, CSS.p3, CSS.p4] as const;

/** Key light direction (world, normalised). Sun sits high-left-behind. */
export const SUN_DIR = new THREE.Vector3(-0.42, 0.68, 0.6).normalize();

/** Ambient fill tint used by every cel material for the darkest band. */
export const AMBIENT = c('#5f86c9');
