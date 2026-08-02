/**
 * THE wave contract.
 *
 * This file is the single source of truth for ocean displacement. The GLSL used
 * by the water vertex shader is *generated* from this same array (see
 * `gerstnerGLSL()`), and the CPU sampler in `GerstnerCPU.ts` evaluates the same
 * maths. There is therefore no way for the visual water and the physical water
 * to drift apart - boats float on exactly the surface you can see.
 *
 * Do not duplicate these numbers anywhere else.
 */

export interface GerstnerWave {
  /** Peak-to-mean height in metres. */
  amplitude: number;
  /** Crest-to-crest distance in metres. */
  wavelength: number;
  /**
   * 0..1. Horizontal pinch. Higher = sharper crest, flatter trough.
   * The sum of (steepness) across waves must stay under ~1 or the surface
   * self-intersects and produces visible looping artefacts on crests.
   */
  steepness: number;
  /** Travel direction in the XZ plane; normalised at build time. */
  dirX: number;
  dirZ: number;
  /** Metres/second along `dir`. */
  speed: number;
}

/**
 * Six waves: two long swells that carry the boat, two mid waves that give the
 * silhouette its shape, two chop layers that break up the surface so the eye
 * never finds a repeat. Directions are deliberately non-parallel and the
 * wavelengths are mutually irrational-ish so the pattern does not tile.
 */
export const WAVES: readonly GerstnerWave[] = [
  // --- swell: long, slow, low steepness. This is what the boat rides. ------
  { amplitude: 1.15, wavelength: 78.0, steepness: 0.30, dirX: 1.0, dirZ: 0.16, speed: 5.6 },
  { amplitude: 0.82, wavelength: 51.0, steepness: 0.26, dirX: 0.62, dirZ: -0.78, speed: 4.7 },
  // --- mid: shapes the crests, gives the horizon its sawtooth --------------
  { amplitude: 0.44, wavelength: 27.5, steepness: 0.22, dirX: -0.35, dirZ: 0.94, speed: 3.9 },
  { amplitude: 0.28, wavelength: 16.3, steepness: 0.18, dirX: 0.88, dirZ: 0.47, speed: 3.1 },
  // --- chop: high frequency detail, breaks up banding into ink-like shapes --
  { amplitude: 0.135, wavelength: 8.7, steepness: 0.14, dirX: -0.72, dirZ: -0.69, speed: 2.4 },
  { amplitude: 0.075, wavelength: 4.9, steepness: 0.10, dirX: 0.19, dirZ: -0.98, speed: 1.8 },
] as const;

/**
 * Global sea-state multiplier. 1.0 = the tuned race condition.
 * Kept as a uniform so the CPU and GPU can be scaled together (e.g. calm water
 * during the results screen).
 */
export const SEA_STATE = 1.0;

/** Derived per-wave constants shared by both evaluators. */
export interface WaveTerms {
  /** Angular wavenumber, 2pi / wavelength. */
  k: number;
  /** Normalised direction. */
  dx: number;
  dz: number;
  /** Amplitude in metres. */
  a: number;
  /** Phase speed in radians/second = speed * k. */
  phase: number;
  /** Q = steepness / (k * a * waveCount), pre-divided so crests stay sane. */
  q: number;
}

export function buildTerms(waves: readonly GerstnerWave[] = WAVES): WaveTerms[] {
  const n = waves.length;
  return waves.map((w) => {
    const len = Math.hypot(w.dirX, w.dirZ) || 1;
    const k = (Math.PI * 2) / w.wavelength;
    const a = w.amplitude * SEA_STATE;
    return {
      k,
      dx: w.dirX / len,
      dz: w.dirZ / len,
      a,
      phase: w.speed * k,
      q: w.steepness / (k * a * n),
    };
  });
}

export const TERMS: WaveTerms[] = buildTerms();

/** Sum of amplitudes - the theoretical max displacement, used for LOD bounds. */
export const MAX_WAVE_HEIGHT = WAVES.reduce((s, w) => s + w.amplitude, 0) * SEA_STATE;

/**
 * Emits the GLSL for the shared Gerstner evaluator. The constants are baked in
 * as literals so the shader compiler can unroll the loop and constant-fold -
 * measurably cheaper than a uniform array on Apple GPUs.
 *
 * Provides:
 *   vec3 wbWaveDisplace(vec2 p, float t)                  // xyz offset
 *   void wbWaveSurface(vec2 p, float t, out vec3 pos, out vec3 nrm, out float jac)
 *
 * `jac` is the horizontal Jacobian determinant: < 1 where the surface is being
 * pinched together, i.e. exactly at the crests. Foam masks key off it.
 */
export function gerstnerGLSL(terms: WaveTerms[] = TERMS): string {
  const f = (v: number) => {
    const s = v.toFixed(6);
    return s.includes('.') ? s : s + '.0';
  };

  const displaceBody = terms
    .map(
      (t, i) => `  { // wave ${i}  lambda=${f((Math.PI * 2) / t.k)}m
    vec2 d = vec2(${f(t.dx)}, ${f(t.dz)});
    float ph = ${f(t.k)} * dot(d, p) + ${f(t.phase)} * t;
    float c = cos(ph), s = sin(ph);
    off.xz += ${f(t.q * t.a)} * d * c;
    off.y  += ${f(t.a)} * s;
  }`
    )
    .join('\n');

  // Analytic partial derivatives of the displaced surface (Tessendorf/Finch).
  const surfaceBody = terms
    .map(
      (t, i) => `  { // wave ${i}
    vec2 d = vec2(${f(t.dx)}, ${f(t.dz)});
    float ph = ${f(t.k)} * dot(d, p) + ${f(t.phase)} * t;
    float c = cos(ph), s = sin(ph);
    float wa = ${f(t.k * t.a)};
    off.xz += ${f(t.q * t.a)} * d * c;
    off.y  += ${f(t.a)} * s;
    // dP/dx and dP/dz accumulators
    tangent   += vec3(-${f(t.q)} * d.x * d.x * wa * s,  d.x * wa * c, -${f(t.q)} * d.x * d.z * wa * s);
    binormal  += vec3(-${f(t.q)} * d.x * d.z * wa * s,  d.z * wa * c, -${f(t.q)} * d.z * d.z * wa * s);
  }`
    )
    .join('\n');

  return /* glsl */ `
// ---- generated from src/ocean/waveConfig.ts - do not hand-edit -------------
#define WB_WAVE_COUNT ${terms.length}
#define WB_MAX_WAVE_HEIGHT ${f(MAX_WAVE_HEIGHT)}

vec3 wbWaveDisplace(vec2 p, float t) {
  vec3 off = vec3(0.0);
${displaceBody}
  return off;
}

void wbWaveSurface(vec2 p, float t, out vec3 pos, out vec3 nrm, out float jac) {
  vec3 off = vec3(0.0);
  vec3 tangent  = vec3(1.0, 0.0, 0.0);
  vec3 binormal = vec3(0.0, 0.0, 1.0);
${surfaceBody}
  pos = vec3(p.x, 0.0, p.y) + off;
  nrm = normalize(cross(binormal, tangent));
  // Horizontal compression: 1.0 flat, < 1.0 pinched (crest), > 1.0 stretched.
  jac = tangent.x * binormal.z - tangent.z * binormal.x;
}
// ---------------------------------------------------------------------------
`;
}
