import { gerstnerGLSL, TERMS, MAX_WAVE_HEIGHT } from '../waveConfig';
import { GBUFFER_OUT, OCT_PACK, GBUFFER_WRITE, CEL_LIGHTING } from '../../render/shaders/celChunks';

/**
 * The ocean surface GLSL.
 *
 * Three ideas run through this file and are worth stating once rather than
 * restating at every use:
 *
 *  1. **The wave maths is never written here.** Both evaluators in the vertex
 *     shader are emitted by `gerstnerGLSL()` from `ocean/waveConfig.ts`, which is
 *     the same generator the CPU sampler mirrors. There is no second definition
 *     of a Gerstner wave anywhere in this project, so the drawn surface and the
 *     surface boats float on cannot drift apart.
 *
 *  2. **Displacement is a function of WORLD xz.** The mesh is a disc that slides
 *     under the camera, but the vertex shader reconstructs the world coordinate
 *     (`position.xz + uOrigin`) before evaluating anything. Moving the mesh
 *     therefore moves the tessellation and nothing else - no crest travels with
 *     the camera, which is the whole trick behind an infinite ocean with no tile.
 *
 *  3. **Every step is one screen pixel wide, at any distance.** Each hard band -
 *     colour, fresnel, foam, sparkle - is resolved with `smoothstep(e - w, e + w, x)`
 *     where `w = fwidth(x) * 0.5`. That makes the transition exactly one pixel
 *     regardless of how the surface is foreshortened, so the bands stay crisp in
 *     the foreground and converge to their own average at the horizon instead of
 *     aliasing into crawling noise. A fixed-width step cannot do both.
 */

/** Interactor slots (hull foam rings). Baked into the shader as a loop bound. */
export const WATER_MAX_INTERACTORS = 8;

/**
 * Compile shim for `gerstnerGLSL()`.
 *
 * The generator's derivative block writes the wave direction's Z component as
 * `d.z`, but `d` is declared `vec2(dirX, dirZ)` - so `.z` is out of range and
 * every water shader fails to link with "vector field selection out of range".
 * The intent is unambiguous: the CPU mirror in `GerstnerCPU.ts` uses `w.dz` in
 * exactly these terms, and on a vec2 that component is `.y`. This rewrites only
 * that swizzle, so the maths is still entirely waveConfig's - nothing is
 * re-derived here.
 *
 * The transform is a no-op once the generator is corrected (the pattern simply
 * stops occurring), so it is safe to leave in place.
 */
function patchGeneratedWaveGLSL(src: string): string {
  return src.replace(/\bd\.z\b/g, 'd.y');
}

/**
 * A second, reduced-wave evaluator generated from the *same* source of truth.
 *
 * Far from the camera the disc's rings are tens of metres apart, so the 8.7 m and
 * 4.9 m chop layers are below the Nyquist limit of the mesh: keeping them there
 * buys nothing but aliased normals, which the cel bands then amplify into a
 * crawling speckle. Rather than approximate the wave with different numbers -
 * which would be a second definition, and would drift - we ask the *generator*
 * for a version built from the first `count` terms of `TERMS` and rename its
 * symbols so both evaluators can coexist in one translation unit. Nothing about
 * the maths is touched; only the term count differs.
 */
function lodGerstnerGLSL(count: number): string {
  return patchGeneratedWaveGLSL(gerstnerGLSL(TERMS.slice(0, count)))
    .replace(/wbWaveSurface/g, 'wbWaveSurfaceLod')
    .replace(/wbWaveDisplace/g, 'wbWaveDisplaceLod')
    .replace(/WB_WAVE_COUNT/g, 'WB_LOD_WAVE_COUNT')
    .replace(/WB_MAX_WAVE_HEIGHT/g, 'WB_LOD_MAX_WAVE_HEIGHT');
}

/** GLSL float literal, always with a decimal point so the compiler sees a float. */
const f = (v: number): string => {
  const s = v.toFixed(6);
  return s.includes('.') ? s : s + '.0';
};

export interface WaterShaderSource {
  vertexShader: string;
  fragmentShader: string;
}

/**
 * @param lodWaveCount how many of the six waves survive at long range
 * @param maxInteractors interactor array length; must match the uniform
 */
export function buildWaterShaders(
  lodWaveCount: number,
  maxInteractors: number = WATER_MAX_INTERACTORS
): WaterShaderSource {
  const vertexShader = /* glsl */ `
precision highp float;

${patchGeneratedWaveGLSL(gerstnerGLSL())}
${lodGerstnerGLSL(lodWaveCount)}

/** Disc centre in world XZ: the camera, snapped to the finest ring spacing. */
uniform vec2  uOrigin;
uniform float uTime;
/** x = distance where the chop starts fading, y = where it is fully gone. */
uniform vec2  uChopFade;

out vec3  vWorldPos;
out vec3  vWorldNormal;
/** Undisplaced world XZ - the coordinate the wave phase is a function of. */
out vec2  vParam;
out float vViewDepth;
/** Horizontal Jacobian: < 1 where the surface is pinched, i.e. at a crest. */
out float vJac;
/** 1 where the full six-wave surface is drawn, 0 where only the swell survives. */
out float vDetail;

void main() {
  // Reconstruct the world coordinate. Everything downstream keys off this, which
  // is what makes the disc's own position invisible.
  vec2 p = position.xz + uOrigin;
  vParam = p;

  // Which detail level this vertex gets is decided by the ring spacing here, and
  // ring spacing is a function of the radius *within the disc* - not of view
  // distance, which is only a proxy for it and a poor one directly beneath a high
  // camera. Take the larger of the two so a camera looking steeply down still
  // sees full detail on the water it is closest to, and so the fade is monotonic
  // along any view ray.
  float radial = length(position.xz);
  float viewDist = distance(vec3(p.x, 0.0, p.y), cameraPosition);
  float lodDist = max(radial, viewDist);
  float detail = 1.0 - smoothstep(uChopFade.x, uChopFade.y, lodDist);
  vDetail = detail;

  vec3 pos;
  vec3 nrm;
  float jac;

  // Three-way branch rather than always evaluating both: the near rings and the
  // far rings each take a single evaluation, and only the transition annulus -
  // about a third of the rings - pays for two. The branch is coherent across a
  // ring, so there is no divergence cost worth the name.
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

  vWorldPos = pos;
  vWorldNormal = nrm;
  vJac = jac;

  // The surface is already in world space, so the model matrix is deliberately
  // never applied - the mesh stays at the origin and only uOrigin moves.
  vec4 mvPos = viewMatrix * vec4(pos, 1.0);
  vViewDepth = -mvPos.z;
  gl_Position = projectionMatrix * mvPos;
}
`;

  const fragmentShader = /* glsl */ `
precision highp float;

${GBUFFER_OUT}
${OCT_PACK}
${GBUFFER_WRITE}
${CEL_LIGHTING}

#define WB_MAX_INTERACTORS ${maxInteractors}

/** Sum of the six amplitudes; the same constant waveConfig exports. */
const float WB_MAX_WAVE_HEIGHT = ${f(MAX_WAVE_HEIGHT)};

in vec3  vWorldPos;
in vec3  vWorldNormal;
in vec2  vParam;
in float vViewDepth;
in float vJac;
in float vDetail;

uniform float uTime;

// --- water body ------------------------------------------------------------
/** Fifth, darkest band: the interior of a trough. See Ocean.ts. */
uniform vec3  uBandAbyss;
uniform vec3  uBandDeep;
uniform vec3  uBandMid;
uniform vec3  uBandShallow;
uniform vec3  uBandCrest;
/** Lowest band edge, splitting abyss from deep. */
uniform float uBandEdge0;
/** Band edges in 0..1 height space. Deliberately uneven - see Ocean.ts. */
uniform vec3  uBandEdges;
/** Fraction of WB_MAX_WAVE_HEIGHT that maps to the full 0..1 band range. */
uniform float uBandFraction;
/** How far the noise field is allowed to push a band edge, in height units. */
uniform float uBandJitter;

/** Subsurface tint painted into the up-facing floor of a trough. */
uniform vec3  uDeepTint;
uniform vec2  uDeepTintGate;
uniform float uDeepTintCut;
uniform float uDeepTintStrength;

/**
 * The one distance authority. x = where every drawn detail begins to thin out,
 * y = where the sea is a single flat tone. Every mark in this shader keys off
 * the *same* ramp, so no single screen row carries a whole transition.
 */
uniform vec2  uDetailFade;

// --- sky response ----------------------------------------------------------
uniform vec3  uSkyNear;
uniform vec3  uSkyFar;
uniform float uFresnelPower;
uniform vec2  uFresnelEdges;
uniform vec2  uFresnelStrength;

// --- backlit crest ---------------------------------------------------------
uniform vec3  uTranslucent;
uniform vec3  uTranslucentHot;
/** Two hard cuts: x = the jade band, y = the hotter lip inside it. */
uniform vec2  uTransCut;
uniform vec2  uTransStrength;
/** ndl window that counts as "the sun is behind this face". */
uniform vec2  uTransFacing;
/** h01 window that counts as "the water here is thin". */
uniform vec2  uTransThin;
uniform vec2  uTransFade;

// --- crest strokes ---------------------------------------------------------
/** The tier between mid-blue and foam white: drawn light-cyan crest marks. */
uniform vec3  uStrokeColor;
uniform float uStrokeGain;
uniform float uStrokeCut;
uniform float uStrokeStrength;

// --- foam ------------------------------------------------------------------
uniform sampler2D uFoamTex;
uniform vec3  uFoamColor;
uniform vec3  uFoamShadeColor;
/** Wave-locked scroll offsets, in metres. See Ocean.ts for the sign. */
uniform vec2  uFoamScrollA;
uniform vec2  uFoamScrollB;
uniform float uFoamScaleA;   // uv per metre
uniform float uFoamScaleB;
/** Third, small tile. Carves holes so a whitecap is never a solid plate. */
uniform float uFoamScaleC;
uniform float uFoamCarve;
/** Jacobian window: x = fully foaming at or below, y = no foam at or above. */
uniform vec2  uFoamJac;
uniform vec2  uFoamHeightGate;
uniform float uFoamGain;
/** Threshold on (crest * gain + texture). x = near, y = far (mipped) value. */
uniform vec2  uFoamCut;
/** How far the noise field may move the far-field foam threshold. */
uniform float uFoamCutJitter;
uniform float uFoamStrength;
/**
 * Shaded-rim width, as a bias on the foam field. x = the rim every patch gets,
 * y = the extra the rim grows by on the side turned away from the sun.
 */
uniform vec2  uFoamRim;
/**
 * Minimum drawn width. Below a few pixels a stroke degenerates into a dashed
 * speckle field, so once the field's screen gradient says the mark has shrunk
 * that far, the threshold is biased down and the mark fattens back up. Density
 * is cut instead, by the far-field term on the threshold itself.
 */
uniform float uFoamWidthClamp;
/** Ink contour drawn just outside every foam silhouette. */
uniform vec3  uFoamInk;
uniform float uFoamInkWidth;
uniform float uFoamInkStrength;

// --- sparkle ---------------------------------------------------------------
uniform sampler2D uSparkleTex;
uniform sampler2D uNoiseTex;
uniform float uNoiseScale;
uniform float uSparkleScale;
uniform vec3  uSparkleColor;
/** Facet-normal jitter scale (uv per metre) and strength. */
uniform float uSparkleFacetScale;
uniform float uSparkleRough;
/** Hard window on the facet's alignment with the sun's half vector. */
uniform vec2  uSparkleFacetEdges;
/** Sun track: x = half width at the camera, y = extra half width per metre. */
uniform vec2  uSparkleTrack;
/** Minimum drawn star width, same principle as the foam's. */
uniform float uSparkleWidthClamp;
uniform float uSparkleCut;
uniform float uSparkleRate;
uniform float uSparkleStrength;
uniform vec2  uSparkleFade;

// --- hull interaction ------------------------------------------------------
/** xy = world xz, z = radius (m), w = strength. w <= 0 means an empty slot. */
uniform vec4  uInteractors[WB_MAX_INTERACTORS];
uniform float uWakeCut;
uniform float uWakeDarken;
uniform float uWakeFoam;

// --- atmosphere / g-buffer --------------------------------------------------
/** The sea's own aerial perspective, stepped through three painted layers. */
uniform vec3  uHazeA;
uniform vec3  uHazeB;
uniform vec3  uFogColor;
uniform vec3  uHazeEdges;
uniform float uHazeJitter;
uniform float uFogCurve;
uniform vec2  uFogRange;
/** x = open-water interior line strength, y = extra allowed on the big crests. */
uniform vec2  uEdgeMask;

/**
 * One-pixel-wide hard step.
 *
 * fwidth(x) is how much x changes across this pixel, so half of it either
 * side of the edge is exactly one pixel of transition - no more, no less, at any
 * distance. The lower clamp stops a perfectly flat region (fwidth == 0) turning
 * the step into an undefined 0/0; the upper clamp is what makes the far field
 * degrade gracefully: once a band spans less than a pixel the "step" widens past
 * the band itself and the result converges to the average of the two colours,
 * which is the correct anti-aliased answer and never crawls.
 */
float wbStep(float edge, float x, float minW, float maxW) {
  float w = clamp(fwidth(x) * 0.5, minW, maxW);
  return smoothstep(edge - w, edge + w, x);
}

void main() {
  vec3 N = normalize(vWorldNormal);
  // The disc is DoubleSide so a camera that dips behind a crest sees water rather
  // than a hole punched through to the sky. Flip the normal there so the
  // underside shades like water instead of like an unlit cavity.
  if (!gl_FrontFacing) N = -N;

  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);
  vec2 p = vParam;

  float ndl = dot(N, L);
  float ndv = dot(N, V);

  // ------------------------------------------------------------- distance ----
  // One ramp, used by every drawn mark below. The previous build let each term
  // choose its own cut-off, which is why the detail all died within a few screen
  // rows of each other and read as a hard LOD ring: the fades were narrow *and*
  // they coincided. Sharing one wide, smoothstepped ramp spreads the loss of
  // detail across hundreds of metres, and because it is driven by view depth the
  // iso-lines are distance rings in world space rather than a screen-horizontal
  // cut - a high camera sees them curve away, not step.
  float far01 = clamp((vViewDepth - uDetailFade.x) / max(uDetailFade.y - uDetailFade.x, 1e-3), 0.0, 1.0);
  far01 = far01 * far01 * (3.0 - 2.0 * far01);
  float near01 = 1.0 - far01;

  // ------------------------------------------------------------- textures ----
  // Foam UVs are built from the *parameter* coordinate and scrolled with the two
  // swells, so the pattern rides the crests instead of sitting still in the world
  // while the crests travel through it. That is the difference between foam that
  // reads as water and foam that twinkles.
  vec2 uvA = (p + uFoamScrollA) * uFoamScaleA;
  vec2 uvB = (p + uFoamScrollB) * uFoamScaleB;
  vec2 uvC = (p + uFoamScrollB) * uFoamScaleC;
  float foamA = texture(uFoamTex, uvA).r;
  float foamB = texture(uFoamTex, uvB).r;
  float foamC = texture(uFoamTex, uvC).r;
  float foamTex = foamA * 0.58 + foamB * 0.46;

  vec3 noise = texture(uNoiseTex, (p + uFoamScrollA) * uNoiseScale).rgb;

  // --------------------------------------------------------- height bands ----
  // Five flat colours keyed to the world height of the displaced surface. The
  // noise nudge is small - well under a band - but it is what stops the edges
  // reading as mathematical contour lines on a topographic map. It rides the same
  // scroll as the foam, so the wobble travels with the wave rather than sitting
  // still while the water moves under it, and it fades out at range where the
  // band edges are sub-pixel anyway.
  float h = vWorldPos.y / (WB_MAX_WAVE_HEIGHT * uBandFraction);
  h += (noise.r - 0.5) * uBandJitter * vDetail * near01;
  float h01 = clamp(h * 0.5 + 0.5, 0.0, 1.0);

  // Collapse the ramp with distance, in two overlapping stages: the outer pair of
  // bands folds into its neighbour first (five tones -> three), then the whole
  // ramp folds into the mid tone (three -> one). Because the two stages overlap
  // and both ride the shared far01 ramp, the far sea loses its steps gradually
  // and arrives at the horizon as a single flat colour - which is the only way a
  // band threshold can survive a hundred wave periods landing inside one pixel.
  float m1 = smoothstep(0.05, 0.60, far01);
  float m2 = smoothstep(0.40, 1.00, far01);
  vec3 bAbyss   = mix(mix(uBandAbyss,   uBandDeep, m1), uBandMid, m2);
  vec3 bDeep    = mix(uBandDeep,    uBandMid, m2);
  vec3 bMid     = uBandMid;
  vec3 bShallow = mix(uBandShallow, uBandMid, m2);
  vec3 bCrest   = mix(mix(uBandCrest, uBandShallow, m1), uBandMid, m2);

  vec3 albedo = bAbyss;
  albedo = mix(albedo, bDeep,    wbStep(uBandEdge0,   h01, 0.0004, 0.5));
  albedo = mix(albedo, bMid,     wbStep(uBandEdges.x, h01, 0.0004, 0.5));
  albedo = mix(albedo, bShallow, wbStep(uBandEdges.y, h01, 0.0004, 0.5));
  albedo = mix(albedo, bCrest,   wbStep(uBandEdges.z, h01, 0.0004, 0.5));

  // ------------------------------------------------------------- lighting ----
  // Same ramp path every other surface in the game uses, with the water's harder
  // three-step ramp: the sun contribution is quantised, not smooth.
  vec3 col = wbCelDiffuse(albedo, N, L);
  col += wbCelSpecular(N, V, L);

  // -------------------------------------------------------------- fresnel ----
  // Grazing water takes the sky's colour. Two hard steps, never a falloff - a
  // smooth fresnel is the single fastest way to make stylised water look like a
  // render. The far step is what carries the sea into the horizon haze.
  float fres = pow(1.0 - clamp(ndv, 0.0, 1.0), uFresnelPower);
  col = mix(col, uSkyNear, wbStep(uFresnelEdges.x, fres, 0.0004, 0.4) * uFresnelStrength.x);
  col = mix(col, uSkyFar,  wbStep(uFresnelEdges.y, fres, 0.0004, 0.4) * uFresnelStrength.y);

  // ------------------------------------------------------------ deep water ---
  // The floor of a trough, turned up at the sun, carries a subsurface tint: the
  // deep band then has a deep/mid read of its own instead of being one navy fill
  // over a fifth of the frame. Hard-stepped like everything else.
  float troughFloor = (1.0 - smoothstep(uDeepTintGate.x, uDeepTintGate.y, h01))
                    * smoothstep(0.42, 0.86, ndl);
  col = mix(col, uDeepTint,
            wbStep(uDeepTintCut, troughFloor, 0.003, 0.4) * uDeepTintStrength * near01);

  // --------------------------------------------------- backlit translucency ---
  // Light entering the sun-facing back of a thin crest and coming out toward the
  // eye. The gate is geometric, so it fires on any crest oriented that way rather
  // than only when the camera happens to face the sun: the face must be turned
  // further into the sun than flat water is (which is what makes it land on one
  // side of a crest and not the other), and it must be near the top of a wave
  // where the water is thin.
  //
  // The previous build multiplied the whole term by a view-into-sun factor that
  // floors at 0.30 - below the 0.33 cut - so on any camera not pointed at the sun
  // the band was arithmetically unreachable and the crest lips shaded identically
  // on both faces. Looking into the sun now *strengthens* the term rather than
  // being a precondition for it, and it is thresholded into its own two hard
  // bands: jade, then a hotter lip inside it.
  float backLook = clamp(-dot(V, L), 0.0, 1.0) * 0.5 + 0.5;
  float lipward = 1.0 - smoothstep(0.12, 0.72, ndv);
  float thin = smoothstep(uTransFacing.x, uTransFacing.y, ndl)
             * smoothstep(uTransThin.x, uTransThin.y, h01)
             * (1.0 - smoothstep(uTransFade.x, uTransFade.y, vViewDepth));
  float trans = thin * (0.52 + 0.48 * lipward) * (0.62 + 0.38 * backLook);
  col = mix(col, uTranslucent,    wbStep(uTransCut.x, trans, 0.002, 0.3) * uTransStrength.x);
  col = mix(col, uTranslucentHot, wbStep(uTransCut.y, trans, 0.002, 0.3) * uTransStrength.y);

  // ------------------------------------------------------------------ foam ---
  // The Jacobian is the honest crest signal: it is < 1 exactly where the Gerstner
  // map is compressing the surface horizontally, which is the pinch at the top of
  // a wave and nowhere else. Thresholding it alone would give a smooth ridge, so
  // the foam texture is added *before* the threshold - the shapes and holes then
  // come out of the drawn alphabet rather than out of a falloff.
  float crest = 1.0 - smoothstep(uFoamJac.x, uFoamJac.y, vJac);
  crest *= smoothstep(uFoamHeightGate.x, uFoamHeightGate.y, h01);

  // ------------------------------------------------------- crest strokes -----
  // The tier the ramp was missing. Held to a *lower* bar than the foam and
  // painted in the crest cyan rather than white, it forms a shoulder around and
  // below every whitecap, so the sea steps mid-blue -> crest cyan -> foam instead
  // of jumping straight to 100% white. It also seeds mark density across the
  // whole near-to-mid field, which is what the empty blue quadrants were short of.
  float strokeField = crest * uStrokeGain + foamTex * 0.9 - uStrokeCut;
  float stw = clamp(fwidth(strokeField) * 0.6, 0.004, 0.35);
  float strokeFat = smoothstep(0.03, 0.22, stw) * uFoamWidthClamp;
  float strokeMask = smoothstep(-stw, stw, strokeField + strokeFat);
  col = mix(col, uStrokeColor, strokeMask * uStrokeStrength * (1.0 - 0.85 * far01));

  // The far-field bar goes *up*, not down. The previous build lowered it past the
  // chop fade on the theory that the mipped tile needed help; what it actually did
  // was detonate the foam into big flat plates just beyond the LOD ring and then
  // into per-pixel white confetti at the horizon. Density is the thing that has to
  // fall with distance - the surviving marks then get *wider*, not thinner, via
  // the clamp below.
  float cut = mix(uFoamCut.x, uFoamCut.y, far01)
            + (noise.b - 0.5) * uFoamCutJitter * near01;
  // A third, small tile carves holes through the interior, so a whitecap is a
  // drawn cluster of marks rather than a solid untextured slab.
  float shaped = crest * uFoamGain + foamTex - foamC * uFoamCarve * near01 - cut;
  float sw = clamp(fwidth(shaped) * 0.6, 0.004, 0.35);
  // Minimum drawn width. fwidth is large exactly when the mark has shrunk under a
  // few pixels, so biasing the threshold down there keeps the survivor fat: the
  // far water resolves into fewer, larger, still-readable marks instead of a
  // crawling field of 1px dashes. Same principle as an outline width clamp.
  float fat = smoothstep(0.03, 0.22, sw) * uFoamWidthClamp;
  float shapedW = shaped + fat;
  float foamMask = smoothstep(-sw, sw, shapedW);

  // Ink contour, drawn just outside the silhouette and under the fill, so the
  // whitecap reads as a drawn shape with an edge rather than as a hole in the
  // render. Fades on the same curve as everything else.
  float foamOuter = smoothstep(-sw, sw, shapedW + uFoamInkWidth);
  col = mix(col, uFoamInk,
            clamp(foamOuter - foamMask, 0.0, 1.0) * uFoamInkStrength * near01);

  // Form. The core is the *same* field held to a higher bar, so it is a strict
  // subset of the patch by construction and a shaded rim always survives.
  //
  // The obvious alternative - re-threshold the field one step down-sun and call
  // the difference the lip - fails badly: the drawn blobs are only a metre or two
  // across in world terms, so any shift big enough to see at range walks off a
  // small blob entirely and flattens the whole thing to the shade colour, which
  // reads as a grey pill floating on the sea. Biasing the threshold instead can
  // never do that.
  //
  // The asymmetry comes from the water's own orientation: the bar is raised
  // further where the surface turns away from the sun, so the rim is thin on the
  // lit side of a crest and fat on the down-sun side. That is the same cue the
  // texture shift was after, sourced from the geometry rather than from a guess,
  // and it costs two fewer texture fetches.
  float rimBias = uFoamRim.x + uFoamRim.y * (1.0 - smoothstep(-0.05, 0.45, ndl));
  float foamCore = smoothstep(-sw, sw, shapedW - rimBias);
  vec3 foamCol = mix(uFoamShadeColor, uFoamColor, foamCore);
  // One hard light step on the foam itself, so it sits in the same lighting as
  // the water instead of floating above it, plus the water's own band edge run
  // through it at reduced contrast - that is what carries the swell's contour
  // across a whitecap instead of letting it flatten into a blank plate.
  foamCol *= mix(0.86, 1.06, smoothstep(-0.02, 0.16, ndl));
  foamCol *= mix(0.90, 1.04, wbStep(uBandEdges.z, h01, 0.0004, 0.5));
  col = mix(col, foamCol, foamMask * uFoamStrength);

  // ------------------------------------------------------------ hull rings ---
  // Up to eight boats disturbing the water. Trivial cost: a distance per slot and
  // no texture work of its own - it reuses the foam tile already fetched above, so
  // a busy start line costs the same as an empty sea.
  //
  // Two profiles per slot: a filled disc that darkens the churned water, and a
  // ring hugging the rim that carries the foam. A filled foam disc reads as a
  // paint splat; the ring reads as a hull pushing water aside.
  float wakeFill = 0.0;
  float wakeRing = 0.0;
  for (int i = 0; i < WB_MAX_INTERACTORS; i++) {
    vec4 it = uInteractors[i];
    float d = distance(p, it.xy) / max(it.z, 0.01);
    wakeFill = max(wakeFill, it.w * (1.0 - smoothstep(0.25, 1.0, d)));
    wakeRing = max(wakeRing, it.w * (1.0 - smoothstep(0.04, 0.20, abs(d - 0.80))));
  }
  float wakeVal = wakeRing * (0.42 + 0.9 * foamTex) - uWakeCut;
  col = mix(col, uBandDeep * 0.78, clamp(wakeFill, 0.0, 1.0) * uWakeDarken);
  col = mix(col, uFoamColor, wbStep(0.0, wakeVal, 0.004, 0.6) * uWakeFoam);

  // --------------------------------------------------------------- sparkle ---
  // Sun glitter, drawn rather than shaded. Three things have to agree before a
  // star lights up, and all three are functions of WORLD position, so the field
  // is nailed to the sea and cannot crawl with the camera:
  //
  //  1. The star tile - four-point manga twinkles - says a mark may exist here.
  //  2. A high-frequency facet normal, jittered out of the noise field, is turned
  //     close enough to the sun's half vector. This is the "specular", and it is
  //     read through a hard window rather than a power lobe: the previous build
  //     used pow(dot(N,H), 10) against a nearly flat sea, which for any camera
  //     not staring into the sun evaluates to about 3e-4 and could never clear
  //     the threshold. That is why not one highlight appeared in eight frames.
  //  3. The fragment lies in the sun track - the elongated corridor running from
  //     the sun's azimuth toward the camera, widening with distance. Density
  //     falls off away from its axis rather than stopping at an edge.
  //
  // The result is thresholded to full-on / full-off. No falloff: a soft sparkle
  // is a render, a hard one is a drawing.
  vec2 spUv = p * uSparkleScale;
  float sp = texture(uSparkleTex, spUv).r;
  vec3 spNoise = texture(uNoiseTex, p * uSparkleFacetScale).rgb;
  float blink = 0.5 + 0.5 * sin(uTime * uSparkleRate + spNoise.b * 41.0);

  vec3 Nd = normalize(N + vec3(spNoise.r - 0.5, 0.0, spNoise.g - 0.5) * uSparkleRough);
  float facet = smoothstep(uSparkleFacetEdges.x, uSparkleFacetEdges.y, dot(Nd, H));

  vec2 sunAz = normalize(uSunDir.xz + vec2(1e-5, 1e-5));
  vec2 rel = vWorldPos.xz - cameraPosition.xz;
  float along = dot(rel, sunAz);
  float across = abs(dot(rel, vec2(-sunAz.y, sunAz.x)));
  float trackW = uSparkleTrack.x + uSparkleTrack.y * max(along, 0.0);
  float track = (1.0 - smoothstep(0.55, 1.25, across / max(trackW, 1.0)))
              * smoothstep(-14.0, 16.0, along);

  float sparkVal = sp
    * (0.30 + 0.70 * blink)
    * facet
    * (0.18 + 0.92 * track)
    * smoothstep(0.34, 0.66, h01)
    * (1.0 - smoothstep(uSparkleFade.x, uSparkleFade.y, vViewDepth));
  // Width clamp, exactly as on the foam. Without it the star tile minifies, the
  // threshold clips into the mip's soft shoulder, and what reaches the screen is
  // a 1px scatter of star *fragments* - which is the crawling specular noise the
  // whole graphic-sparkle approach exists to avoid.
  float spw = clamp(fwidth(sparkVal) * 0.6, 0.002, 0.4);
  float spFat = smoothstep(0.02, 0.20, spw) * uSparkleWidthClamp;
  float spOn = smoothstep(-spw, spw, sparkVal - uSparkleCut + spFat);
  col = mix(col, uSparkleColor, spOn * uSparkleStrength);

  // ------------------------------------------------------------------- haze ---
  // Aerial perspective, painted in layers rather than dissolved. The water steps
  // through two progressively desaturated tones and then into the sky's own
  // horizon colour, so the far sea loses chroma before it loses value and the
  // waterline dissolves instead of terminating at a cut.
  //
  // It is quantised because the sky is quantised and the two have to read as the
  // same painting - but a purely radial hard step would stamp perfect concentric
  // rings on an open sea, so the same low-frequency field that wobbles the band
  // edges wobbles the haze edges too. That is the difference between a painted
  // horizon and a target pattern.
  //
  // The final tone is deliberately held a little under the sky's, so the horizon
  // is always readable as a line even where a pale foam band runs up against it.
  float fogT = clamp((vViewDepth - uFogRange.x) / max(uFogRange.y - uFogRange.x, 1e-3), 0.0, 1.0);
  float fog = pow(fogT, uFogCurve);
  float fq = fog + (noise.g - 0.5) * uHazeJitter * (1.0 - fog);
  col = mix(col, uHazeA,    wbStep(uHazeEdges.x, fq, 0.0015, 0.35));
  col = mix(col, uHazeB,    wbStep(uHazeEdges.y, fq, 0.0015, 0.35));
  col = mix(col, uFogColor, wbStep(uHazeEdges.z, fq, 0.0015, 0.35));
  // Anti-aliases the disc's own silhouette against the sky: by the time the sea
  // reaches its outer rings it is already within a hair of the horizon colour, so
  // the stair-stepped edge has nothing left to contrast against.
  col = mix(col, uFogColor, smoothstep(0.88, 1.0, fog));

  // --------------------------------------------------------------- g-buffer --
  // Low but non-zero: the Sobel pass must not scribble a line over every wave,
  // but the biggest crests earn a faint one. Foam shapes are already drawn art,
  // so they pull it down further, and the horizon drops to zero so the sea's far
  // edge is never inked against the sky.
  float edgeMask = uEdgeMask.x + uEdgeMask.y * smoothstep(0.70, 0.95, h01);
  edgeMask *= 1.0 - 0.55 * foamMask;
  edgeMask *= 1.0 - fog;
  // The ink has to die on the same curve as the marks it would otherwise be
  // outlining, or the line advertises exactly the cut the haze is dissolving.
  edgeMask *= near01;

  gColor = vec4(col, 1.0);
  wbWriteGBuffer(normalize(mat3(viewMatrix) * N), vViewDepth, edgeMask);
}
`;

  return { vertexShader, fragmentShader };
}
