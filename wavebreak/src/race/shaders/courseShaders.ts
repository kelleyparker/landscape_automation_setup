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
 *     That includes the ocean's distance LOD, which is a two-stage cascade: the
 *     two chop layers go between `uChopFade.x` and `.y`, then the two mid waves
 *     between `uSwellFade.x` and `.y`. A ribbon that kept all six would visibly
 *     saw through the sea at range - and so did the ribbon that kept a
 *     *different* three. Both term counts and both fade ranges are now imported
 *     from `Ocean.ts` by the caller and the same three evaluators are generated
 *     here, so the two surfaces agree at every distance by construction rather
 *     than by two files being kept in step by hand.
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
 * The reduced-wave evaluators, generated from the *same* source of truth and
 * renamed so several can live in one translation unit. Character-for-character
 * the same helper `ocean/shaders/water.ts` uses, and it is called with the term
 * counts `Ocean.ts` exports - so "if that file's LOD changes, this must follow
 * it" is no longer a thing anyone has to remember.
 */
function lodGerstnerGLSL(count: number, suffix: string): string {
  const tag = suffix.toUpperCase();
  return patchGeneratedWaveGLSL(gerstnerGLSL(TERMS.slice(0, count)))
    .replace(/wbWaveSurface/g, `wbWaveSurface${suffix}`)
    .replace(/wbWaveDisplace/g, `wbWaveDisplace${suffix}`)
    .replace(/WB_WAVE_COUNT/g, `WB_${tag}_WAVE_COUNT`)
    .replace(/WB_MAX_WAVE_HEIGHT/g, `WB_${tag}_MAX_WAVE_HEIGHT`);
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
 * @param midWaveCount terms surviving the ocean's first (chop) fade
 * @param farWaveCount terms surviving the ocean's second (mid-wave) fade
 *
 * Both are imported straight from `Ocean.ts` by the caller, along with the two
 * fade ranges, so the ribbon and the sea cannot disagree by construction. They
 * used to: this file claimed "the two surfaces agree at every distance" while
 * the ribbon ran 3 waves over 110-430 m against the ocean's 4 over 100-400 m and
 * then 2 over 340-1000 m, with no second stage here at all. Worst case that is
 * 0.28 m of disagreement at mid range and 0.44 m past 430 m - the ribbon sawing
 * through the drawn swell exactly where the far side of the lap is.
 */
export function buildRaceLineShaders(
  midWaveCount: number,
  farWaveCount: number
): CourseShaderSource {
  const vertexShader = /* glsl */ `
precision highp float;

${patchGeneratedWaveGLSL(gerstnerGLSL())}
${lodGerstnerGLSL(midWaveCount, 'Mid')}
${lodGerstnerGLSL(farWaveCount, 'Far')}

/** -1 .. +1 across the ribbon. */
in float aSide;
/** Arc length along the ribbon in metres. Wraps at the seam by a whole number
    of chevron periods, so the pattern is continuous around the lap. */
in float aDist;

uniform float uTime;
/** x = where the ocean starts dropping its chop, y = where it is fully gone. */
uniform vec2  uChopFade;
/** The ocean's second stage: where the two mid waves fade out in turn. */
uniform vec2  uSwellFade;
/** Constant lift off the surface, and a per-metre term that buys depth-buffer
    headroom at range without ever reading as the line floating. */
uniform float uLift;
uniform float uLiftSlope;

out float vSide;
out float vDist;
out float vViewDepth;
out vec3  vViewNormal;
/** The *water's* normal in world space, so the ribbon can take the sea's own
    band shading instead of reading as a decal painted flat on top of it. */
out vec3  vWorldNormal;
/** Displaced height in metres: negative in a trough, positive on a crest. */
out float vHeight;
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

  // The same two-stage cascade the ocean runs, with the same term counts and the
  // same fade ranges, blended with the same smoothsteps. This block is a
  // deliberate transcription of the one in ocean/shaders/water.ts: a ribbon that
  // sheds a different number of waves at a different distance does not "nearly
  // agree" with the sea, it saws through it, and the difference is a third of a
  // metre at the far side of the lap.
  float detailChop  = 1.0 - smoothstep(uChopFade.x,  uChopFade.y,  viewDist);
  float detailSwell = 1.0 - smoothstep(uSwellFade.x, uSwellFade.y, viewDist);

  vec3 pos;
  vec3 nrm;
  float jac;

  if (detailChop >= 0.999) {
    wbWaveSurface(p, uTime, pos, nrm, jac);
  } else {
    vec3 posBase;
    vec3 nrmBase;
    float jacBase;
    if (detailSwell >= 0.999) {
      wbWaveSurfaceMid(p, uTime, posBase, nrmBase, jacBase);
    } else if (detailSwell <= 0.001) {
      wbWaveSurfaceFar(p, uTime, posBase, nrmBase, jacBase);
    } else {
      vec3 posFar;
      vec3 nrmFar;
      float jacFar;
      wbWaveSurfaceFar(p, uTime, posFar, nrmFar, jacFar);
      wbWaveSurfaceMid(p, uTime, posBase, nrmBase, jacBase);
      posBase = mix(posFar, posBase, detailSwell);
      nrmBase = normalize(mix(nrmFar, nrmBase, detailSwell));
      jacBase = mix(jacFar, jacBase, detailSwell);
    }

    if (detailChop <= 0.001) {
      pos = posBase;
      nrm = nrmBase;
      jac = jacBase;
    } else {
      wbWaveSurface(p, uTime, pos, nrm, jac);
      pos = mix(posBase, pos, detailChop);
      nrm = normalize(mix(nrmBase, nrm, detailChop));
      jac = mix(jacBase, jac, detailChop);
    }
  }

  // The lift is a depth-buffer allowance, not a look. 5 cm clears z-fighting out
  // to a couple of hundred metres; past that the buffer's resolution falls off as
  // the square of distance, and the linear term keeps ahead of it while staying
  // far under a pixel on screen (0.2 m at 500 m is ~0.05 px at our FOV).
  pos.y += uLift + viewDist * uLiftSlope;

  vec4 mv = viewMatrix * vec4(pos, 1.0);
  vViewDepth = -mv.z;
  vViewNormal = normalize(mat3(viewMatrix) * nrm);
  vWorldNormal = nrm;
  vHeight = pos.y;
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
in vec3  vWorldNormal;
in float vHeight;
in float vJac;

uniform float uTime;
uniform vec3  uLine;      // body colour
uniform vec3  uHot;       // core + chevron colour
uniform vec3  uInk;       // the dark checker square on the start strip
/** Key light, world space. Same vector the sea and the hulls are lit by. */
uniform vec3  uSun;
/** Band edges across |side|: x core, y body, z sheath, w where alpha reaches 0. */
uniform vec4  uBands;
/**
 * Where the ribbon counts as edge-on, read off abs(vViewNormal.z). The normal
 * is the *water's*, so this is the angle between the sea and the eye: ~0.15 from
 * the chase and low-water cameras, ~0.6 from altitude.
 */
uniform vec2  uGrazeEdges;
/**
 * How far the core and body bands grow when edge-on, and what comes with it.
 * x = core band scale, y = body band scale, z = added *body* gain, w = opacity
 * multiplier - all at full grazing, all inert from above.
 */
uniform vec4  uGrazeGain;
/** x = 1 / chevron period (per metre), y = how far the V is swept back. */
uniform vec2  uChevron;
/** Chevron travel in metres/second, in the direction of travel. */
uniform float uScroll;
uniform float uOpacity;
/** Alpha fade with distance: x = start, y = gone. */
uniform vec2  uFade;
/** Near fade: x = fully gone at or under this view depth, y = fully in by this. */
uniform vec2  uNearFade;
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
  // Three concentric hard colour bands, and a *soft* outer boundary.
  //
  // The band edges are still one-pixel steps - this is cel art and the interior
  // of the ribbon is drawn, not rendered. The silhouette is the exception. An
  // ink-bounded, fully opaque edge is right for an object; the racing line is
  // not an object, it is a hint projected onto water that already has foam,
  // spray and chop drawn over it. A hard edge there gives the triangle strip a
  // sawtooth boundary and lets the ribbon interlock with every foam island it
  // crosses, which is exactly the artefact this ramp removes: past uBands.z the
  // alpha simply runs out, so the ribbon dissolves under the churn instead of
  // fighting it for the same pixels.
  // --- the grazing term -----------------------------------------------------
  // From altitude the ribbon is a clean legible circuit; from the chase camera
  // it is a filament, because a 3.5 m strip seen almost edge-on covers a handful
  // of pixel rows and most of those rows are the soft sheath. Measured on the
  // reference frames: 1 662 pixels of race-line green anywhere on the water in
  // chase, out of 3.7 M.
  //
  // The fix has to be keyed to *that*, not applied globally, or it turns the
  // aerial view back into the green slab this ribbon has already been once. So
  // it is keyed to the water's own facing: the ribbon covers fewest pixels
  // exactly when it is edge-on and most when it faces the camera, which makes a
  // grazing-weighted boost self-limiting by construction. From altitude graze
  // is ~0.1 and every term below switches itself off.
  float face = abs(normalize(vViewNormal).z);
  float graze = 1.0 - smoothstep(uGrazeEdges.x, uGrazeEdges.y, face);

  // Widen the bright fraction, not the ribbon. Only the core and body edges move;
  // uBands.z and .w - the sheath and the alpha-zero point, i.e. the actual
  // silhouette - are left exactly where they are, so the line never gets *wider*
  // on screen, it just stops being mostly sheath. The clamps keep the ordering
  // core < body < sheath intact at any gain.
  vec4 bands = uBands;
  bands.x = min(uBands.x * mix(1.0, uGrazeGain.x, graze), uBands.y * 0.92);
  bands.y = min(uBands.y * mix(1.0, uGrazeGain.y, graze), uBands.z * 0.95);

  float mGlow = wbInside(uBands.z, a, 0.35);
  float mBody = wbInside(bands.y, a, 0.35);
  float mCore = wbInside(bands.x, a, 0.35);
  float mEdge = 1.0 - smoothstep(uBands.z, uBands.w, a);

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

  // Every band is kept *bright*. That is not a stylistic preference, it is what
  // makes the line disappear under foam: a light value composited over
  // whitewater moves it by almost nothing, and over the deep blue of an
  // untouched trough it is a clear filament. The line therefore fades out
  // exactly where the churn is, without ever being told where the churn is. A
  // dark band here does the opposite - it stains the foam grey, which is what
  // the old ink separator did.
  vec3 line = uLine * 0.62;
  line = mix(line, uLine * 0.84, mGlow);
  // The body is where the emissive lift goes, and it goes there rather than on
  // the core for a reason worth stating: uHot is a near-white mint and uLine is
  // the actual green, so brightening the core pushes the filament past white and
  // the line stops separating from foam by hue - which was the whole argument
  // for green over the visor cyan in the first place. Scaling uLine is a scalar
  // multiply, so the hue is exactly preserved while the luma goes from 0.85 to
  // 1.29 - across the composite's 0.85 bright-pass threshold, so the glow the
  // line picks up is a *green* glow.
  line = mix(line, uLine * (1.12 + uGrazeGain.z * graze), mBody);
  line = mix(line, uHot * 1.10, arrow * mBody);
  line = mix(line, uLine * 0.58, chevRule * mBody * 0.7);
  // The core filament runs unbroken through the arrows, so the line still reads
  // as one continuous path at a glance rather than as a row of separate marks.
  // It stays at 1.25 from every camera: it is already the palest thing in the
  // ribbon, and the only place it has left to go is white.
  line = mix(line, uHot * 1.25, mCore);

  // The line flares where the water is pinching itself together, i.e. exactly on
  // a crest. It is the same Jacobian the ocean's foam keys off, so the line
  // brightens on the same water that goes white - the two read as one surface.
  float crest = 1.0 - smoothstep(0.93, 1.01, vJac);
  line += uHot * crest * 0.14 * mBody;

  // A one-pixel outer contour, in a deep shade of the line's OWN green.
  //
  // Two things make this safe, and both are load-bearing, because a dark band on
  // this ribbon is a failure the project has already had: an ink separator here
  // once stained every whitecap it crossed grey. First, the colour is uLine
  // darkened - a dark *green*, which over foam reads as the line's own shadow
  // rather than as dirt. Second, it is switched off exactly where the foam is:
  // crest is the Jacobian pinch, the same field the ocean's whitecaps are
  // thresholded from, so on water that is about to go white the contour is gone
  // before it can stain it. It is also grazing-weighted, so it does not exist at
  // all in the view where the ribbon is already legible.
  float contour = clamp(wbInside(mix(uBands.z, uBands.w, 0.45), a, 0.35) - mGlow, 0.0, 1.0);
  line = mix(line, uLine * 0.34, contour * graze * 0.60 * (1.0 - crest));

  // --- the ribbon is lit by the sea it lies on -------------------------------
  // The vertices already ride the Gerstner surface, so the ribbon has the right
  // *shape*; without this it still has the wrong *value*, because a constant
  // fill over a banded sea is exactly what a decal looks like. Two hard steps
  // off the same key light the water uses, then a smooth trough term from the
  // displaced height, so the line goes dark in the hollows and comes up on the
  // lit faces along with the band under it.
  //
  // The floors matter as much as the steps. At 0.78 * 0.88 the darkest state was
  // 0.69 of the line's colour, and a stroke that loses a third of its value
  // every time it crosses a trough is a stroke that visibly *stops* in the
  // troughs - which is the dashed, patchy read this line had. The bands are now
  // a lift off a much higher floor: the swell still runs along the line, but the
  // line never drops far enough for the water to close over it.
  float ndl = dot(normalize(vWorldNormal), uSun);
  float shade = 0.88 + 0.13 * wbCrisp(0.62, ndl, 0.5) + 0.14 * wbCrisp(0.86, ndl, 0.5);
  shade *= 0.94 + 0.14 * smoothstep(-1.5, 1.3, vHeight);
  line *= shade;

  // ---------------------------------------------------- start/finish strip ---
  // A checker sized in metres, so the squares stay square however wide the
  // course is at the line. Two flat tones, no filtering, no texture.
  float chk = mod(floor(vDist / uCheck.x) + floor(across / uCheck.y + 64.0), 2.0);
  vec3 strip = mix(uInk, uHot, chk);
  float mStrip = wbInside(uBands.w, a, 0.35);

  vec3 col = mix(line, strip, uMode);

  // Alpha is not constant across the ribbon. The sheath is half the weight of
  // the body and the arrow heads carry a little extra, which is what gives the
  // line a soft animated leading edge without a second draw call - and what
  // keeps the whole thing sitting *under* the wake instead of punching through
  // it in saturated blocks.
  // The sheath floor is 0.62, not 0.44: below about half the body weight the
  // outer band stops carrying the line's width at any distance and the ribbon
  // narrows to its core, which is the two-pixel scratch it used to be from
  // altitude.
  float lineAlpha = mEdge * (0.62 + 0.38 * mBody) * (0.90 + 0.22 * arrow * mBody);
  // Edge-on the ribbon has far fewer pixels to say anything with, so each one is
  // allowed to say it harder. Clamped, and zero from altitude, so the peak the
  // aerial view sees is unchanged.
  lineAlpha = min(lineAlpha * mix(1.0, uGrazeGain.w, graze), 1.0);
  float alpha = mix(lineAlpha, mStrip, uMode) * uOpacity;

  // Fade out well before the fog does. A 2.7 km ribbon drawn all the way to the
  // horizon would be a bright stripe laid over the whole sea; it has to hand
  // over to the gates as the distance cue long before that.
  alpha *= 1.0 - smoothstep(uFade.x, uFade.y, vViewDepth);

  // And fade *in*, which matters more than the far fade does.
  //
  // A 3.5 m ribbon seen from ten metres away at deck height is not a line at
  // all - it is foreshortened into a wedge tens of degrees wide that fills the
  // bottom third of the frame, and it lands precisely on the boat's own wake,
  // so the wake foam cuts it into exactly the field of disconnected green
  // islands this line is meant not to be. It is also useless there: guidance is
  // about where you are going, and the water beside the hull is where you
  // already are. Letting it arrive over the next twenty-odd metres costs
  // nothing a driver reads and takes the whole artefact out of the frame.
  alpha *= smoothstep(uNearFade.x, uNearFade.y, vViewDepth);
  if (alpha < 0.004) discard;

  // 0.85 of a haze tuned for two-pixel pylons washed the ribbon to the horizon
  // colour by 600 m; on the line's own long range this only ever softens it.
  col = mix(col, uFogColor, wbFog(vViewDepth) * 0.72);

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

uniform float uTime;
/** Cloth wobble: x = twist amplitude, y = waves along the span, z = rate. */
uniform vec3  uWobble;

out vec2  vUv;
out vec3  vTint;
out vec2  vFlags;
out vec3  vViewNormal;
/** Shading normal in *world* space: the geometric normal on the structural
    faces, a bowed and slowly twisting cloth normal on the two long faces. */
out vec3  vClothNormal;
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
  vec3 worldNrm = normalize(mat3(model) * normal);
  vViewNormal = normalize(mat3(viewMatrix) * worldNrm);

  // --- the cloth read -------------------------------------------------------
  // The span is a bowed ribbon of fabric, and a ribbon's whole legibility is
  // that its surface turns: the light runs off the top edge and the underside
  // falls into shadow. A slab's two long faces have one normal between them, so
  // the shading normal is rebuilt here instead - bowed across the height, and
  // twisted slowly along the length by two out-of-phase waves so the shading
  // bands crawl along the banner the way cloth does in a breeze.
  //
  // Nothing here moves a vertex. The ink shell is a separate mesh drawn from the
  // same instance matrix; displacing this surface and not that one would tear
  // the outline off the banner. The wobble lives entirely in the normal, which
  // is what the cel bands key off, so the silhouette stays exactly where the
  // shell puts it.
  vec3 axV = normalize(mat3(model)[1]);
  vec3 axW = normalize(mat3(model)[2]);
  float s = uv.x;
  float twist = uWobble.x * (
      sin(s * uWobble.y + uTime * uWobble.z) * 0.66 +
      sin(s * uWobble.y * 1.73 - uTime * uWobble.z * 0.81) * 0.34);
  float bow = (uv.y - 0.5) * 2.0;
  // 1 on the two long faces, 0 on the hems and the ends.
  float longFace = step(0.5, abs(normal.z));
  vec3 cloth = normalize(axW * sign(normal.z + 1e-4) + axV * (bow * 0.66 + twist));
  vClothNormal = normalize(mix(worldNrm, cloth, longFace));

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
in vec3  vClothNormal;
in float vViewDepth;

uniform float uTime;
uniform vec3  uFrame;   // the pylon clamps and the banner's hem
uniform vec3  uInk;
uniform vec3  uHot;     // mark / checker highlight
uniform vec3  uSun;     // key light, world space
/** x = marks along the span, y = drift rate, z = chevron sweep-back. */
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

  // --- three cel bands off the cloth normal ---------------------------------
  // This is the whole point of rebuilding the normal in the vertex shader. The
  // banner is a curved surface a hundred and fifty feet wide; with one flat fill
  // across it, it is a highway barrier. Two hard steps against the key light
  // give it an upper face that catches the sun, a body, and an underside that
  // falls into a cooler shadow - and because the normal twists slowly along the
  // span, the boundaries between them travel, which is the cloth.
  float ndl = dot(normalize(vClothNormal), uSun);
  float bLit  = wbCrisp(0.34, ndl, 0.6);
  float bMid  = wbCrisp(-0.04, ndl, 0.6);

  // The tint arrives at full chroma so it can be read at a kilometre; on the
  // surface it is deliberately held well off the channel ceiling, because a
  // colour already at maximum has nowhere left to go and cannot carry a
  // highlight. Every band below is a fraction of it.
  vec3 shadeCol = vTint * 0.30 + uFrame * 0.20;
  vec3 bodyCol  = vTint * 0.55;
  vec3 litCol   = vTint * 0.76 + uHot * 0.06;

  vec3 field = shadeCol;
  field = mix(field, bodyCol, bMid);
  field = mix(field, litCol, bLit);

  // --- the course mark ------------------------------------------------------
  // A doubled chevron pointing *down*, repeated along the span: "the line runs
  // under here". The old pattern was a row of road-works arrows pointing across
  // the frame, which made the largest object in the picture the strongest
  // leading line in it, aimed at the edge of the screen. This one points at the
  // water the boats are about to cross.
  float cu = fract(u * uArrow.x - uTime * uArrow.y) - 0.5;
  float cv = v - 0.5;
  float ridge = abs(cu) * uArrow.z;
  // The cell mask is what makes these *marks* rather than a pattern. Without
  // it each V runs into its neighbours at the cell boundary and the whole span
  // becomes one continuous sawtooth ribbon - a texture, not a row of signs.
  float cell = wbInside(0.33, abs(cu), 0.3);
  float markA = wbInside(0.080, abs(cv + 0.14 - ridge), 0.3);
  float markB = wbInside(0.042, abs(cv - 0.10 - ridge), 0.3);
  float mark = max(markA, markB) * cell;

  // The start/finish banner is a checker instead. Generated here, not sampled -
  // two floors and a mod, which is crisper than any texture at any distance.
  float chk = mod(floor(u * uCheck.x) + floor(v * uCheck.y), 2.0);

  // The mark takes the same three bands as the field, one step brighter. Left
  // at flat uHot it clipped to white across the whole span and turned the
  // banner into two flat fills with a hard join.
  vec3 markCol = uHot * (0.52 + 0.16 * bMid + 0.22 * bLit);
  field = mix(field, markCol, mark);
  vec3 chkField = mix(uInk, uHot * 0.80, chk);
  field = mix(field, chkField, style);

  // --- hem, and the hardware that holds it up -------------------------------
  // One narrow hem, in a deep shade of the banner's own hue rather than in the
  // near-black the rail used to be. The banner already carries an ink shell at
  // the same weight as the boats'; a second dark band a fifth of the height
  // thick inside it read as a doubled outline eight times too heavy.
  float hem = max(wbCrisp(0.895, v, 0.25), wbInside(0.105, v, 0.25));
  vec3 hemCol = vTint * 0.20 + uFrame * 0.42;

  // Attachment at both masts: a clamp block over the last few percent of the
  // span, with a bright lug and two grommets punched through the cloth just
  // inboard of it. Small, but it is the difference between a banner that is
  // fastened to the gate and one that simply stops.
  float endU = min(u, 1.0 - u);
  float clampBlk = wbInside(0.022, endU, 0.2);
  float lug = clampBlk * wbCrisp(0.62, v, 0.3);
  float grommet = wbInside(0.010, abs(endU - 0.040), 0.2)
                * wbInside(0.13, abs(v - 0.5), 0.3);

  vec3 col = mix(field, hemCol, hem);
  col = mix(col, uFrame, clampBlk);
  col = mix(col, uFrame * 0.6 + uHot * 0.28, lug);
  col = mix(col, uInk, grommet);

  // Lit gates pulse. The rate is deliberately slow enough to read as a beacon
  // rather than as a flicker, and it only ever *adds* - a gate never goes dark.
  // The idle term is small on purpose: the gate has to sit under the racers in
  // the value hierarchy, and it was previously the brightest thing in frame.
  float pulse = 0.5 + 0.5 * sin(uTime * 3.1);
  float emissive = uEmissive.x + uEmissive.y * lit * (0.55 + 0.45 * pulse);
  col += field * emissive * (1.0 - max(hem, clampBlk));

  float fog = wbFog(vViewDepth);
  col = mix(col, uFogColor, fog);

  // Only the structure earns interior lines; the field would just get scribbled
  // on, and it fades out entirely into the haze.
  float edgeMask = (0.10 + 0.34 * hem + 0.40 * clampBlk) * (1.0 - fog);

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
