import { gerstnerGLSL, TERMS } from '../../ocean/waveConfig';
import { GBUFFER_OUT, OCT_PACK, GBUFFER_WRITE } from '../../render/shaders/celChunks';

/**
 * GLSL for the course furniture: the racing line ribbon, the gate banners and
 * the gate lamps.
 *
 * Three ideas run through this file.
 *
 *  1. **The racing line is water, not a decal.** Its vertices are displaced by
 *     the *generated* Gerstner evaluator from `ocean/waveConfig.ts` - the same
 *     function the ocean's own vertex shader calls, at the same `uTime`. It is
 *     therefore not "close to" the surface, it is a curve drawn *in the same
 *     parameter space* and pushed through the same map, so it lands exactly on
 *     the water by construction. Nothing here re-derives a wave.
 *
 *     That includes the ocean's distance LOD. Past `uChopFade.x` the ocean drops
 *     the three short waves (0.49 m of amplitude between them); a ribbon that
 *     kept all six would visibly saw through the sea at range. The same two
 *     evaluators are generated here and blended with the same smoothstep, so the
 *     two surfaces agree at every distance, not just up close.
 *
 *  2. **A cel glow is concentric hard bands.** Not a gaussian, not an additive
 *     smear. The line is an ink edge, an outer band, a body band and a hot core,
 *     each separated by a one-pixel `fwidth` step, with a chevron pattern cut out
 *     of the body by the same kind of step. At any distance the boundaries stay
 *     exactly one pixel wide, so the line reads as drawn rather than as a bloom.
 *
 *  3. **The G-buffer contract under blending.** The ribbon blends
 *     SRC_ALPHA / ONE_MINUS_SRC_ALPHA, and WebGL applies that equation to *every*
 *     attachment using that attachment's own alpha as the source factor.
 *     Attachment 1's alpha is `edgeMask`; writing 0 there provably leaves the
 *     normal/depth buffer bit-identical, so the Sobel pass inks the water under
 *     the line exactly as if the line were not there. The line carries its own
 *     drawn edge instead.
 */

/**
 * Compile shim for `gerstnerGLSL()` - identical to the one in
 * `ocean/shaders/water.ts` and for the identical reason.
 *
 * The generator's derivative block writes the wave direction's Z component as
 * `d.z`, but `d` is declared `vec2(dirX, dirZ)`, so `.z` is out of range and the
 * shader fails to link. On a vec2 that component is `.y` - which is exactly what
 * the CPU mirror in `GerstnerCPU.ts` uses in the same terms. Only that swizzle
 * is rewritten; the maths is still entirely waveConfig's. The transform is a
 * no-op once the generator is corrected, so it is safe to leave in place.
 */
function patchGeneratedWaveGLSL(src: string): string {
  return src.replace(/\bd\.z\b/g, 'd.y');
}

/**
 * The reduced-wave evaluator, generated from the *same* source of truth and
 * renamed so both can live in one translation unit. Mirrors `lodGerstnerGLSL`
 * in `ocean/shaders/water.ts` - if that file's LOD changes, this must follow it
 * or the line and the sea stop agreeing beyond the fade.
 */
function lodGerstnerGLSL(count: number): string {
  return patchGeneratedWaveGLSL(gerstnerGLSL(TERMS.slice(0, count)))
    .replace(/wbWaveSurface/g, 'wbWaveSurfaceLod')
    .replace(/wbWaveDisplace/g, 'wbWaveDisplaceLod')
    .replace(/WB_WAVE_COUNT/g, 'WB_LOD_WAVE_COUNT')
    .replace(/WB_MAX_WAVE_HEIGHT/g, 'WB_LOD_MAX_WAVE_HEIGHT');
}

/**
 * One-pixel-wide hard step, shared by everything in this file.
 *
 * `fwidth(x)` is how much x changes across this fragment, so half of it either
 * side of the edge is exactly one pixel of transition at any distance and any
 * foreshortening. The floor stops a perfectly flat region (fwidth == 0) turning
 * the step into an undefined 0/0; the ceiling is what makes the far field
 * degrade gracefully - once a band is thinner than a pixel the step widens past
 * it and the result converges to the average of the two colours instead of
 * crawling.
 */
const CRISP = /* glsl */ `
float wbCrisp(float edge, float x, float maxW) {
  float w = clamp(fwidth(x) * 0.5, 1e-5, maxW);
  return smoothstep(edge - w, edge + w, x);
}
/** Inside-out form: 1 below the edge, 0 above it. */
float wbInside(float edge, float x, float maxW) {
  return 1.0 - wbCrisp(edge, x, maxW);
}
`;

/**
 * Distance haze, applied by hand so the course arrives at the same horizon
 * colour the sea and the sky do. Smooth, not banded: this is atmosphere, and
 * quantising a purely distance-driven term stamps concentric rings on the world.
 */
const COURSE_FOG = /* glsl */ `
uniform vec3 uFogColor;
uniform vec2 uFogRange;
float wbFog(float viewDepth) {
  float f = clamp((viewDepth - uFogRange.x) / max(uFogRange.y - uFogRange.x, 1e-3), 0.0, 1.0);
  return f * f * (3.0 - 2.0 * f);
}
`;

// ------------------------------------------------------- racing line ---------

export interface CourseShaderSource {
  vertexShader: string;
  fragmentShader: string;
}

/**
 * The racing line ribbon and the start/finish strip share one program; `uMode`
 * picks between them (0 = line, 1 = strip). They are the same object - a dense
 * strip of quads laid along the spline in *parameter* space and pushed onto the
 * sea in the vertex shader - and giving them two programs would only cost a
 * second compile and a second pipeline switch for a dozen ALU ops of difference.
 *
 * @param lodWaveCount how many of the six waves survive at long range; MUST be
 *        the same value `Ocean.ts` passes to `buildWaterShaders`.
 */
export function buildRaceLineShaders(lodWaveCount: number): CourseShaderSource {
  const vertexShader = /* glsl */ `
precision highp float;

${patchGeneratedWaveGLSL(gerstnerGLSL())}
${lodGerstnerGLSL(lodWaveCount)}

/** -1 .. +1 across the ribbon. */
in float aSide;
/** Arc length along the ribbon in metres. Wraps at the seam by a whole number
    of chevron periods, so the pattern is continuous around the lap. */
in float aDist;

uniform float uTime;
/** x = where the ocean starts dropping its chop, y = where it is fully gone. */
uniform vec2  uChopFade;
/** Constant lift off the surface, and a per-metre term that buys depth-buffer
    headroom at range without ever reading as the line floating. */
uniform float uLift;
uniform float uLiftSlope;

out float vSide;
out float vDist;
out float vViewDepth;
out vec3  vViewNormal;
/** Horizontal Jacobian: < 1 where the surface is being pinched, i.e. at a crest. */
out float vJac;

void main() {
  // The mesh carries an identity transform and its positions are already world
  // XZ, exactly like the ocean disc - so the model matrix is deliberately never
  // applied. position.xz is the *parameter* point the wave phase is a function of.
  vec2 p = position.xz;

  // The ocean picks its detail level from max(discRadius, viewDist). The disc is
  // centred on the camera's XZ, so discRadius is the horizontal distance and
  // viewDist the 3D one - and the camera is above the water, so viewDist is
  // always the larger. Evaluating it the same way from the *undisplaced* point,
  // as the ocean does, makes the two fades identical rather than merely similar.
  float viewDist = distance(vec3(p.x, 0.0, p.y), cameraPosition);
  float detail = 1.0 - smoothstep(uChopFade.x, uChopFade.y, viewDist);

  vec3 pos;
  vec3 nrm;
  float jac;
  if (detail >= 0.999) {
    wbWaveSurface(p, uTime, pos, nrm, jac);
  } else if (detail <= 0.001) {
    wbWaveSurfaceLod(p, uTime, pos, nrm, jac);
  } else {
    vec3 posLod;
    vec3 nrmLod;
    float jacLod;
    wbWaveSurfaceLod(p, uTime, posLod, nrmLod, jacLod);
    wbWaveSurface(p, uTime, pos, nrm, jac);
    pos = mix(posLod, pos, detail);
    nrm = normalize(mix(nrmLod, nrm, detail));
    jac = mix(jacLod, jac, detail);
  }

  // The lift is a depth-buffer allowance, not a look. 5 cm clears z-fighting out
  // to a couple of hundred metres; past that the buffer's resolution falls off as
  // the square of distance, and the linear term keeps ahead of it while staying
  // far under a pixel on screen (0.2 m at 500 m is ~0.05 px at our FOV).
  pos.y += uLift + viewDist * uLiftSlope;

  vec4 mv = viewMatrix * vec4(pos, 1.0);
  vViewDepth = -mv.z;
  vViewNormal = normalize(mat3(viewMatrix) * nrm);
  vSide = aSide;
  vDist = aDist;
  vJac = jac;
  gl_Position = projectionMatrix * mv;
}
`;

  const fragmentShader = /* glsl */ `
precision highp float;
${GBUFFER_OUT}
${OCT_PACK}
${GBUFFER_WRITE}
${CRISP}
${COURSE_FOG}

in float vSide;
in float vDist;
in float vViewDepth;
in vec3  vViewNormal;
in float vJac;

uniform float uTime;
uniform vec3  uLine;      // body colour
uniform vec3  uHot;       // core + chevron colour
uniform vec3  uInk;       // the drawn edge, and the dark checker square
/** Band edges across |side|: x core, y body, z outer glow, w silhouette. */
uniform vec4  uBands;
/** x = 1 / chevron period (per metre), y = how far the V is swept back. */
uniform vec2  uChevron;
/** Chevron travel in metres/second, in the direction of travel. */
uniform float uScroll;
uniform float uOpacity;
/** Alpha fade with distance: x = start, y = gone. */
uniform vec2  uFade;
/** 0 = racing line, 1 = start/finish strip. */
uniform float uMode;
/** Half-width of this mesh in metres, so the checker can be sized in metres. */
uniform float uHalfWidth;
/** Checker cell size in metres: x along the course, y across it. */
uniform vec2  uCheck;

void main() {
  float a = abs(vSide);
  float across = vSide * uHalfWidth;

  // --------------------------------------------------------- racing line ----
  // Four concentric hard bands. The outermost is ink, not transparency: a glow
  // that fades out at its edge is a render, a glow bounded by a drawn line is a
  // cel. Everything below is a step, never a gradient.
  float mEdge = wbInside(uBands.w, a, 0.35);
  float mGlow = wbInside(uBands.z, a, 0.35);
  float mBody = wbInside(uBands.y, a, 0.35);
  float mCore = wbInside(uBands.x, a, 0.35);

  // Chevrons. Skewing the phase by |side| turns a band across the ribbon into a
  // V pointing the way the boats travel; scrolling the same phase with time
  // makes the V's run forward. The period divides the lap length exactly (see
  // Course.ts), so the pattern is continuous across the seam.
  //
  // Two cuts, not one: a bright chevron body, and a narrow ink separator at its
  // leading edge - and the ink is what actually
  // carries the pattern. raceLine and raceLineHot are both bright greens a step
  // apart, so at any real viewing angle a hot-on-body chevron washes out to a
  // flat ribbon; a drawn dark edge between them survives foreshortening, which
  // is the whole reason cel art outlines its shapes instead of relying on value.
  float phase = fract((vDist - uTime * uScroll) * uChevron.x + a * uChevron.y);
  float arrow = wbInside(0.44, phase, 0.35);
  float chevRule = wbInside(0.07, phase, 0.35);

  vec3 line = uInk;
  line = mix(line, uLine * 0.42, mGlow);
  line = mix(line, uLine * 0.74, mBody);
  line = mix(line, uHot, arrow * mBody);
  line = mix(line, uInk, chevRule * mBody * 0.82);
  // The core filament runs unbroken through the arrows, so the line still reads
  // as one continuous path at a glance rather than as a row of separate marks.
  line = mix(line, uHot * 1.1, mCore);

  // The line flares where the water is pinching itself together, i.e. exactly on
  // a crest. It is the same Jacobian the ocean's foam keys off, so the line
  // brightens on the same water that goes white - the two read as one surface.
  float crest = 1.0 - smoothstep(0.93, 1.01, vJac);
  line += uHot * crest * 0.22 * mBody;

  // ---------------------------------------------------- start/finish strip ---
  // A checker sized in metres, so the squares stay square however wide the
  // course is at the line. Two flat tones, no filtering, no texture.
  float chk = mod(floor(vDist / uCheck.x) + floor(across / uCheck.y + 64.0), 2.0);
  vec3 strip = mix(uInk, uHot, chk);
  float mStrip = wbInside(uBands.w, a, 0.35);

  vec3 col = mix(line, strip, uMode);
  float alpha = mix(mEdge, mStrip, uMode) * uOpacity;

  // Fade out well before the fog does. A 2.7 km ribbon drawn all the way to the
  // horizon would be a bright stripe laid over the whole sea; it has to hand
  // over to the gates as the distance cue long before that.
  alpha *= 1.0 - smoothstep(uFade.x, uFade.y, vViewDepth);
  if (alpha < 0.004) discard;

  col = mix(col, uFogColor, wbFog(vViewDepth) * 0.85);

  gColor = vec4(col, alpha);
  // edgeMask = 0. Under SRC_ALPHA blending this leaves attachment 1 untouched,
  // so the Sobel pass keeps inking the swell straight through the line. The
  // line's own silhouette is already drawn, in ink, above.
  wbWriteGBuffer(normalize(vViewNormal), vViewDepth, 0.0);
}
`;

  return { vertexShader, fragmentShader };
}

// -------------------------------------------------------- gate banner --------

/**
 * The banner slung between a gate's two pylons. One instanced draw for every
 * gate on the lap; the instance matrix carries the gate's width, its bob and the
 * roll it picks up from its two ends riding different parts of the swell.
 *
 * `aTint` is the gate's state colour and `aFlags` is (lit, style) - style 1 is
 * the start/finish banner, which swaps the arrow field for a checker.
 */
export const GATE_BANNER_VERT = /* glsl */ `
in vec3 aTint;
in vec2 aFlags;   // x = lit 0/1, y = style (0 = gate, 1 = start/finish)

out vec2  vUv;
out vec3  vTint;
out vec2  vFlags;
out vec3  vViewNormal;
out float vViewDepth;

void main() {
  mat4 model = modelMatrix * instanceMatrix;
  vec4 world = model * vec4(position, 1.0);
  vec4 mv = viewMatrix * world;
  vViewDepth = -mv.z;

  // The instance matrix is non-uniformly scaled (a banner is wide, short and
  // thin), so this is not the inverse transpose. It does not need to be: every
  // face of the slab has an axis-aligned normal, and scaling an axis-aligned
  // vector by a diagonal matrix changes its length but not its direction.
  vViewNormal = normalize(mat3(viewMatrix) * mat3(model) * normal);

  vUv = uv;
  vTint = aTint;
  vFlags = aFlags;
  gl_Position = projectionMatrix * mv;
}
`;

export const GATE_BANNER_FRAG = /* glsl */ `
precision highp float;
${GBUFFER_OUT}
${OCT_PACK}
${GBUFFER_WRITE}
${CRISP}
${COURSE_FOG}

in vec2  vUv;
in vec3  vTint;
in vec2  vFlags;
in vec3  vViewNormal;
in float vViewDepth;

uniform float uTime;
uniform vec3  uFrame;   // the banner's structural rail
uniform vec3  uInk;
uniform vec3  uHot;     // arrow / checker highlight
/** x = arrows per unit width, y = scroll rate, z = chevron sweep-back. */
uniform vec3  uArrow;
/** Checker cells across the start/finish banner: x along, y up. */
uniform vec2  uCheck;
/** Emissive gain for an idle gate and the extra a lit one gets. */
uniform vec2  uEmissive;

void main() {
  float u = vUv.x;
  float v = vUv.y;
  float lit = vFlags.x;
  float style = vFlags.y;

  // Rails top and bottom, glowing field between. The rails are structure - they
  // take an ink line from the Sobel pass - and the field is light, which does not.
  float railT = wbCrisp(0.80, v, 0.25);
  float railB = wbInside(0.20, v, 0.25);
  float rail = max(railT, railB);
  float lip = max(wbCrisp(0.955, v, 0.25), wbInside(0.045, v, 0.25));

  // Arrows: a band across the banner, swept back at the edges into a chevron,
  // running the way the boats go through the gate.
  float phase = fract(u * uArrow.x - uTime * uArrow.y + abs(v - 0.5) * uArrow.z);
  float arrow = wbInside(0.36, phase, 0.35);

  // The start/finish banner is a checker instead. Generated here, not sampled -
  // two floors and a mod, which is crisper than any texture at any distance.
  float chk = mod(floor(u * uCheck.x) + floor(v * uCheck.y), 2.0);

  vec3 field = mix(vTint * 0.45, vTint, 1.0);
  field = mix(field, uHot, arrow * 0.75);
  vec3 chkField = mix(uInk, uHot, chk);
  field = mix(field, chkField, style);

  vec3 col = mix(field, uFrame, rail);
  col = mix(col, uInk, lip);

  // Lit gates pulse. The rate is deliberately slow enough to read as a beacon
  // rather than as a flicker, and it only ever *adds* - a gate never goes dark.
  float pulse = 0.5 + 0.5 * sin(uTime * 3.1);
  float emissive = uEmissive.x + uEmissive.y * lit * (0.55 + 0.45 * pulse);
  col += field * emissive * (1.0 - rail);

  float fog = wbFog(vViewDepth);
  col = mix(col, uFogColor, fog);

  // Only the structure earns interior lines; the glowing field would just get
  // scribbled on, and it fades out entirely into the haze.
  float edgeMask = (0.15 + 0.55 * rail) * (1.0 - fog);

  gColor = vec4(col, 1.0);
  wbWriteGBuffer(normalize(vViewNormal), vViewDepth, edgeMask);
}
`;

// --------------------------------------------------------- gate lamp ---------

/**
 * The lamp drum on top of each pylon. Pure cel glow: three concentric hard
 * bands plus a hotter rim where the drum turns away from the eye, which is the
 * standard anime read for "this object is emitting light" and costs one dot
 * product. No bloom is done here - the composite's bright pass finds it because
 * the colours are pushed above 1.0 on purpose.
 */
export const GATE_LAMP_VERT = /* glsl */ `
in vec3 aTint;
in vec2 aFlags;   // x = lit 0/1, y = unused

out vec2  vUv;
out vec3  vTint;
out float vLit;
out vec3  vViewNormal;
out float vViewDepth;

void main() {
  mat4 model = modelMatrix * instanceMatrix;
  vec4 world = model * vec4(position, 1.0);
  vec4 mv = viewMatrix * world;
  vViewDepth = -mv.z;
  vViewNormal = normalize(mat3(viewMatrix) * mat3(model) * normal);
  vUv = uv;
  vTint = aTint;
  vLit = aFlags.x;
  gl_Position = projectionMatrix * mv;
}
`;

export const GATE_LAMP_FRAG = /* glsl */ `
precision highp float;
${GBUFFER_OUT}
${OCT_PACK}
${GBUFFER_WRITE}
${CRISP}
${COURSE_FOG}

in vec2  vUv;
in vec3  vTint;
in float vLit;
in vec3  vViewNormal;
in float vViewDepth;

uniform float uTime;
uniform vec3  uHot;
uniform vec3  uInk;
uniform vec2  uEmissive;  // idle gain, extra when lit

void main() {
  // vUv.y runs 0..1 up the drum. Two symmetric bands and a core stripe.
  float h = abs(vUv.y - 0.5) * 2.0;
  vec3 col = vTint * 0.5;
  col = mix(col, vTint, wbInside(0.78, h, 0.3));
  col = mix(col, uHot, wbInside(0.30, h, 0.3));

  // Grazing silhouette gets hotter, not darker - a light source has no shaded
  // side. The view normal's z component is the facing term - no extra varying.
  float face = abs(normalize(vViewNormal).z);
  col = mix(col + vTint * 0.55, col, wbCrisp(0.42, face, 0.4));

  // A thin ink cap top and bottom keeps the drum from dissolving into its own
  // glow against a bright sky.
  col = mix(col, uInk, wbCrisp(0.955, h, 0.3));

  float pulse = 0.5 + 0.5 * sin(uTime * 3.1);
  col *= 1.0 + uEmissive.x + uEmissive.y * vLit * (0.55 + 0.45 * pulse);

  float fog = wbFog(vViewDepth);
  col = mix(col, uFogColor, fog);

  gColor = vec4(col, 1.0);
  // Nearly opted out of interior lines: the drum's own bands are the drawing.
  wbWriteGBuffer(normalize(vViewNormal), vViewDepth, 0.12 * (1.0 - fog));
}
`;
