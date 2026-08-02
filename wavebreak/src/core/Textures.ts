import * as THREE from 'three';
import { PALETTE } from './Palette';

/**
 * Every texture in WAVEBREAK is generated here. Nothing is loaded from disk.
 *
 * Ramps are `DataTexture`s with `NearestFilter` and no mips - interpolation is
 * the enemy of a cel look, and a linear-filtered ramp is exactly how "toon"
 * shading turns back into a gradient.
 */

// -------------------------------------------------------------- helpers -----

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 2D canvas helper. Canvases are disposed by GC once uploaded. */
function canvas(size: number): { cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d', { willReadFrequently: false })!;
  return { cv, ctx };
}

function finishCanvas(cv: HTMLCanvasElement, opts: { srgb?: boolean; linearFilter?: boolean } = {}): THREE.Texture {
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  const f = opts.linearFilter === false ? THREE.NearestFilter : THREE.LinearFilter;
  tex.minFilter = f;
  tex.magFilter = f;
  tex.generateMipmaps = opts.linearFilter !== false;
  if (tex.generateMipmaps) tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------- ramp ---------

export interface RampBand {
  /** Upper bound of this band in 0..1 lighting space. */
  upto: number;
  /** Multiplier applied to albedo inside the band. >1 blows the highlight out. */
  value: number;
  /** Hue push: colour the band is tinted toward, and how far. */
  tint?: THREE.Color;
  tintAmount?: number;
}

/**
 * The lighting ramp. Hard bands, no interpolation, cool shadows and a warm
 * top step - the tint shift is what stops quantised shading reading as grey mush.
 *
 * These thresholds were tuned against captured frames, not chosen by default:
 * the terminator sits at 0.50 so it lands mid-form on a round hull, the deep
 * band is narrow so shadows stay graphic, and the top band is small so the hot
 * step reads as a highlight rather than a second base colour.
 */
export const DEFAULT_BANDS: RampBand[] = [
  { upto: 0.34, value: 0.34, tint: new THREE.Color(0.24, 0.42, 0.86), tintAmount: 0.52 },
  { upto: 0.50, value: 0.60, tint: new THREE.Color(0.36, 0.55, 0.95), tintAmount: 0.26 },
  { upto: 0.80, value: 0.94, tint: new THREE.Color(1.0, 1.0, 1.0), tintAmount: 0.0 },
  { upto: 1.01, value: 1.14, tint: new THREE.Color(1.0, 0.96, 0.80), tintAmount: 0.22 },
];

const RAMP_W = 128;

/**
 * Builds an RGBA ramp: rgb = per-band tint premultiplied by value, a = raw value.
 * Shaders do `albedo * rampRGB` for the tinted result, or use `.a` alone when a
 * neutral step is wanted (foam, ink).
 */
export function makeRampTexture(bands: RampBand[] = DEFAULT_BANDS): THREE.DataTexture {
  const data = new Uint8Array(RAMP_W * 4);
  for (let i = 0; i < RAMP_W; i++) {
    const x = (i + 0.5) / RAMP_W;
    const band = bands.find((b) => x < b.upto) ?? bands[bands.length - 1]!;
    const tint = band.tint ?? new THREE.Color(1, 1, 1);
    const amt = band.tintAmount ?? 0;
    const r = (1 - amt + amt * tint.r) * band.value;
    const g = (1 - amt + amt * tint.g) * band.value;
    const b = (1 - amt + amt * tint.b) * band.value;
    data[i * 4 + 0] = Math.min(255, Math.round(r * 200));
    data[i * 4 + 1] = Math.min(255, Math.round(g * 200));
    data[i * 4 + 2] = Math.min(255, Math.round(b * 200));
    data[i * 4 + 3] = Math.min(255, Math.round(band.value * 200));
  }
  const tex = new THREE.DataTexture(data, RAMP_W, 1, THREE.RGBAFormat);
  // NearestFilter is mandatory - this is the whole point of the ramp.
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace; // ramp is a multiplier, not a colour
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------ matcap --------

/**
 * A hand-painted-looking matcap: two hard sky bands top, a warm bounce band at
 * the bottom, and a hot rim arc. This is the *only* form of environment
 * reflection in the game - there is no cubemap probe anywhere.
 */
export function makeMatcap(kind: 'gloss' | 'metal' | 'skin' = 'gloss'): THREE.Texture {
  const S = 256;
  const { cv, ctx } = canvas(S);
  const R = S / 2;

  const stops: { r: number; col: string }[] =
    kind === 'metal'
      ? [
          { r: 1.00, col: '#0e1a38' },
          { r: 0.92, col: '#22407e' },
          { r: 0.74, col: '#3f74c8' },
          { r: 0.50, col: '#8fc4f2' },
          { r: 0.24, col: '#ffffff' },
        ]
      : kind === 'skin'
      ? [
          { r: 1.00, col: '#5b3a5e' },
          { r: 0.9, col: '#8a5570' },
          { r: 0.66, col: '#c08a86' },
          { r: 0.36, col: '#ffd9bd' },
        ]
      : [
          { r: 1.00, col: '#152a4e' },
          { r: 0.9, col: '#1d3a72' },
          { r: 0.68, col: '#2f6fbb' },
          { r: 0.42, col: '#9fd8f5' },
          { r: 0.2, col: '#ffffff' },
        ];

  ctx.fillStyle = '#0b1530';
  ctx.fillRect(0, 0, S, S);

  // Hard concentric bands, drawn largest first. No gradients anywhere.
  for (const s of stops) {
    ctx.beginPath();
    // The band centre is pushed up-left so the "light" agrees with SUN_DIR.
    ctx.arc(R - S * 0.16, R - S * 0.18, R * s.r, 0, Math.PI * 2);
    ctx.fillStyle = s.col;
    ctx.fill();
  }

  // Bottom bounce: a crescent of warm light from the water.
  ctx.save();
  ctx.beginPath();
  ctx.arc(R, R, R * 0.99, 0, Math.PI * 2);
  ctx.clip();
  ctx.beginPath();
  ctx.ellipse(R, R + S * 0.34, R * 0.86, R * 0.42, 0, 0, Math.PI * 2);
  ctx.fillStyle = kind === 'skin' ? '#ff9e7a' : '#3ee0d6';
  ctx.globalAlpha = 0.55;
  ctx.fill();
  ctx.restore();

  // Hot specular pip.
  ctx.beginPath();
  ctx.arc(R - S * 0.22, R - S * 0.25, R * 0.12, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // Mask everything outside the unit disc so the edge stays clean.
  ctx.globalCompositeOperation = 'destination-in';
  ctx.beginPath();
  ctx.arc(R, R, R, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  return finishCanvas(cv);
}

// -------------------------------------------------------------- noise -------

/** Seeded value noise, tileable, used for foam breakup and sparkle placement. */
export function makeNoiseTexture(size = 256, octaves = 4, seed = 7): THREE.Texture {
  const { cv, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);

  // Simple seeded hash-based value noise with bilinear interpolation.
  const hash = (x: number, y: number): number => {
    let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const smooth = (t: number): number => t * t * (3 - 2 * t);

  const noiseAt = (x: number, y: number, period: number): number => {
    const fx = x / size * period;
    const fy = y / size * period;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = smooth(fx - x0), ty = smooth(fy - y0);
    const wrap = (v: number): number => ((v % period) + period) % period;
    const a = hash(wrap(x0), wrap(y0));
    const b = hash(wrap(x0 + 1), wrap(y0));
    const c = hash(wrap(x0), wrap(y0 + 1));
    const d = hash(wrap(x0 + 1), wrap(y0 + 1));
    return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0, amp = 0.5, per = 4, norm = 0;
      for (let o = 0; o < octaves; o++) {
        v += noiseAt(x, y, per) * amp;
        norm += amp;
        amp *= 0.5;
        per *= 2;
      }
      v /= norm;
      const i = (y * size + x) * 4;
      // R: fbm, G: sharper high-frequency, B: cellular-ish, A: 1
      img.data[i] = Math.round(v * 255);
      img.data[i + 1] = Math.round(noiseAt(x, y, 32) * 255);
      img.data[i + 2] = Math.round(Math.abs(noiseAt(x, y, 12) - 0.5) * 2 * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = finishCanvas(cv, { srgb: false });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ------------------------------------------------------------ sparkle -------

/**
 * Anime light-glitter: sparse four-point stars at quantised sizes. Sampled by
 * the water shader and thresholded, so what reaches the screen is a scatter of
 * hard white shapes rather than specular noise.
 */
export function makeSparkleTexture(size = 512, seed = 3): THREE.Texture {
  const { cv, ctx } = canvas(size);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);

  let s = seed >>> 0;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const star = (cx: number, cy: number, r: number, a: number): void => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    // Four-point star with pinched waist - the classic manga twinkle.
    ctx.moveTo(0, -r);
    ctx.quadraticCurveTo(r * 0.13, -r * 0.13, r, 0);
    ctx.quadraticCurveTo(r * 0.13, r * 0.13, 0, r);
    ctx.quadraticCurveTo(-r * 0.13, r * 0.13, -r, 0);
    ctx.quadraticCurveTo(-r * 0.13, -r * 0.13, 0, -r);
    ctx.fill();
    ctx.restore();
  };

  // Draw wrapped copies so the tile is seamless.
  const count = 190;
  for (let i = 0; i < count; i++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const r = [3, 4.5, 7, 11][Math.floor(rand() * 4)]!;
    const a = rand() * Math.PI;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        if (Math.abs(cx + ox - size / 2) > size || Math.abs(cy + oy - size / 2) > size) continue;
        star(cx + ox, cy + oy, r, a);
      }
    }
  }

  const tex = finishCanvas(cv, { srgb: false });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// -------------------------------------------------------------- foam --------

/**
 * Foam alphabet: a tile of hard-edged blobby shapes. The foam shader thresholds
 * this instead of using a soft gradient, which is what makes the foam read as
 * drawn shapes rather than as static.
 */
export function makeFoamTexture(size = 512, seed = 21): THREE.Texture {
  const { cv, ctx } = canvas(size);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);

  let s = seed >>> 0;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Metaball-ish clusters drawn as solid overlapping discs, then eroded with
  // black discs to punch holes. Result: organic, hard-edged foam islands.
  const blob = (cx: number, cy: number, r: number, colour: string): void => {
    ctx.fillStyle = colour;
    const lobes = 5 + Math.floor(rand() * 5);
    for (let i = 0; i < lobes; i++) {
      const a = rand() * Math.PI * 2;
      const d = rand() * r * 0.7;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.42 + rand() * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
  };

  for (let i = 0; i < 26; i++) {
    const cx = rand() * size, cy = rand() * size, r = 22 + rand() * 46;
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) blob(cx + ox, cy + oy, r, '#fff');
  }
  for (let i = 0; i < 46; i++) {
    const cx = rand() * size, cy = rand() * size, r = 8 + rand() * 22;
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) blob(cx + ox, cy + oy, r, '#000');
  }
  // A dusting of small bubbles so the interior isn't a dead flat mass.
  ctx.fillStyle = '#fff';
  for (let i = 0; i < 700; i++) {
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, 0.8 + rand() * 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = finishCanvas(cv, { srgb: false });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ------------------------------------------------------------- shared -------

/** Lazily-built shared textures. One instance each, reused by every material. */
class TextureCache {
  private _ramp?: THREE.DataTexture;
  private _rampWater?: THREE.DataTexture;
  private _matcapGloss?: THREE.Texture;
  private _matcapMetal?: THREE.Texture;
  private _matcapSkin?: THREE.Texture;
  private _noise?: THREE.Texture;
  private _sparkle?: THREE.Texture;
  private _foam?: THREE.Texture;

  get ramp(): THREE.DataTexture { return (this._ramp ??= makeRampTexture()); }

  /** Water uses a harder 3-step ramp - the sea reads flatter than a hull. */
  get rampWater(): THREE.DataTexture {
    return (this._rampWater ??= makeRampTexture([
      { upto: 0.46, value: 0.46, tint: new THREE.Color(0.28, 0.44, 0.98), tintAmount: 0.5 },
      { upto: 0.72, value: 0.86, tint: new THREE.Color(0.55, 0.85, 1.0), tintAmount: 0.18 },
      { upto: 1.01, value: 1.2, tint: new THREE.Color(1.0, 1.0, 0.92), tintAmount: 0.18 },
    ]));
  }

  get matcapGloss(): THREE.Texture { return (this._matcapGloss ??= makeMatcap('gloss')); }
  get matcapMetal(): THREE.Texture { return (this._matcapMetal ??= makeMatcap('metal')); }
  get matcapSkin(): THREE.Texture { return (this._matcapSkin ??= makeMatcap('skin')); }
  get noise(): THREE.Texture { return (this._noise ??= makeNoiseTexture()); }
  get sparkle(): THREE.Texture { return (this._sparkle ??= makeSparkleTexture()); }
  get foam(): THREE.Texture { return (this._foam ??= makeFoamTexture()); }
}

export const TEX = new TextureCache();
