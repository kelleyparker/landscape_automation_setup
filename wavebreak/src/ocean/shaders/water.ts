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
 * A reduced-wave evaluator generated from the *same* source of truth.
 *
 * The disc's rings grow geometrically, so at 400 m they are about 7.5 m apart and
 * at 1000 m about 19 m. A wave shorter than roughly four ring spacings is past
 * what the mesh can carry: keeping it there buys nothing but aliased normals and
 * a height field that jumps between neighbouring rings, which the cel bands then
 * amplify into crawling speckle. Rather than approximate the wave with different
 * numbers - which would be a second definition, and would drift - we ask the
 * *generator* for a version built from the first `count` terms of `TERMS` and
 * rename its symbols so several evaluators can coexist in one translation unit.
 * Nothing about the maths is touched; only the term count differs.
 */
function lodGerstnerGLSL(count: number, suffix: string): string {
  const tag = suffix.toUpperCase();
  return patchGeneratedWaveGLSL(gerstnerGLSL(TERMS.slice(0, count)))
    .replace(/wbWaveSurface/g, `wbWaveSurface${suffix}`)
    .replace(/wbWaveDisplace/g, `wbWaveDisplace${suffix}`)
    .replace(/WB_WAVE_COUNT/g, `WB_${tag}_WAVE_COUNT`)
    .replace(/WB_MAX_WAVE_HEIGHT/g, `WB_${tag}_MAX_WAVE_HEIGHT`);
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
 * @param midWaveCount terms surviving the first (chop) fade
 * @param farWaveCount terms surviving the second (mid-wave) fade
 * @param maxInteractors interactor array length; must match the uniform
 */
export function buildWaterShaders(
  midWaveCount: number,
  farWaveCount: number,
  maxInteractors: number = WATER_MAX_INTERACTORS
): WaterShaderSource {
  const vertexShader = /* glsl */ `
precision highp float;

${patchGeneratedWaveGLSL(gerstnerGLSL())}
${lodGerstnerGLSL(midWaveCount, 'Mid')}
${lodGerstnerGLSL(farWaveCount, 'Far')}

/** Disc centre in world XZ: the camera, snapped to the finest ring spacing. */
uniform vec2  uOrigin;
uniform float uTime;
/** x = distance where the chop starts fading, y = where it is fully gone. */
uniform vec2  uChopFade;
/** The second stage: where the mid waves fade out in turn. */
uniform vec2  uSwellFade;

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

  // Two stages, not one. Ring spacing grows as roughly 0.018 * radius, so the
  // wavelength the mesh can still carry keeps falling all the way out: the two
  // chop layers (8.7 m, 4.9 m) run out first, then the two mid waves (27.5 m,
  // 16.3 m), leaving only the swells at the horizon. Doing it in one step meant
  // the surviving mid waves went on being sampled at two rings per wavelength
  // for the whole far field, which is where the far sea's normals - and with
  // them every band, foam and sparkle threshold keyed off them - broke up.
  //
  // Both ranges are long and they overlap, so no ring of the disc carries a
  // visible share of either transition and the two never coincide.
  float detailChop  = 1.0 - smoothstep(uChopFade.x,  uChopFade.y,  lodDist);
  float detailSwell = 1.0 - smoothstep(uSwellFade.x, uSwellFade.y, lodDist);
  vDetail = detailChop;

  vec3 pos;
  vec3 nrm;
  float jac;

  // Cost is paid only where a fade is actually in progress: the near rings take
  // one evaluation, the far rings take one, and only the two transition annuli
  // pay for a second (or, in the thin overlap between them, a third). The
  // branches are coherent across a ring, so there is no divergence cost worth
  // the name.
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
/** The sea's own aerial perspective, stepped through four painted layers. */
uniform vec3  uHazeA;
uniform vec3  uHazeB;
uniform vec3  uHazeC;
uniform vec3  uFogColor;
uniform vec4  uHazeEdges;
uniform float uHazeJitter;
/** uv per metre for the haze wobble. Far coarser than the band noise - see main(). */
uniform float uHazeNoiseScale;
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

/**
 * How well a repeating field is resolved at this pixel.
 *
 * The uv argument is the field's own sampling coordinate and cell is the size of its
 * largest meaningful feature in those same units. The result is 1 while several
 * pixels fall inside one feature and falls to 0 once a whole feature fits under
 * a pixel - past which no threshold on that field can produce anything but a
 * dither pattern, because the value it is thresholding is a point sample of
 * something that is already noise at this scale.
 *
 * The upper clamp inside wbStep is the other half of the same idea: it lets a
 * step widen past its own band so the result converges to the average of the two
 * colours. That works when the field itself is smooth. When the field is a
 * *texture* it does not, because the mip chain has already replaced the
 * high-frequency detail with its mean and what remains is a small residual that
 * still straddles the threshold. So marks driven by a texture scale their
 * contrast by this instead, and fade into their own local average rather than
 * breaking into per-pixel static.
 */
float wbResolve(vec2 uv, float cell) {
  float foot = max(fwidth(uv.x), fwidth(uv.y));
  return 1.0 - smoothstep(cell * 0.30, cell * 1.30, foot);
}

/**
 * Threshold width for a drawn mark, and the amount its bar may be biased down
 * to keep it drawn.
 *
 * x = half width of the step. Allowed to grow far past a band so a mark that has
 *     gone sub-pixel converges to its own coverage average.
 * y = the "keep it fat" bias, which applies only while the mark is *merely*
 *     thin. Fattening a mark that has already collapsed under a pixel does not
 *     rescue it - it just raises the dither's duty cycle - so the bias is
 *     withdrawn again once the field is genuinely unresolvable.
 */
vec2 wbMarkWidth(float field, float clampAmount) {
  float w = clamp(fwidth(field) * 0.6, 0.004, 1.1);
  float fat = smoothstep(0.03, 0.22, w) * (1.0 - smoothstep(0.34, 0.85, w)) * clampAmount;
  return vec2(w, fat);
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
  // The drawn blobs are about a tenth of the A tile across, so that is the
  // feature size the mark thresholds below have to still be able to see.
  float foamRes = wbResolve(uvA, 0.11);

  vec2 bandUv = (p + uFoamScrollA) * uNoiseScale;
  vec3 noise = texture(uNoiseTex, bandUv).rgb;
  float bandRes = wbResolve(bandUv, 0.25);

  // The haze wobble gets its own, far coarser sample of the same field.
  //
  // This is the one edge in the shader that has to stay coherent all the way to
  // the horizon, and it was the whole distance-aliasing defect: read at the
  // 14 m band-noise tile its features are about half a metre across, so past a
  // couple of hundred metres a dozen of them land inside one pixel and a hard
  // step through it can only ever return a coin toss. That is what covered the
  // mid-to-far field in pepper. Sampled at tens of metres instead, the same
  // field's features stay several pixels wide out to the fog plane - which is
  // also the right scale for the mark: a haze band should wobble like a painted
  // edge, not like grain - and wbResolve retires it smoothly where even that
  // finally goes under a pixel, so it dissolves instead of dithering.
  vec2 hazeUv = (p + uFoamScrollB) * uHazeNoiseScale;
  float hazeN = texture(uNoiseTex, hazeUv).r;
  float hazeRes = wbResolve(hazeUv, 0.25);

  // --------------------------------------------------------- height bands ----
  // Five flat colours keyed to the world height of the displaced surface. The
  // noise nudge is small - well under a band - but it is what stops the edges
  // reading as mathematical contour lines on a topographic map. It rides the same
  // scroll as the foam, so the wobble travels with the wave rather than sitting
  // still while the water moves under it, and it fades out at range where the
  // band edges are sub-pixel anyway.
  float h = vWorldPos.y / (WB_MAX_WAVE_HEIGHT * uBandFraction);
  h += (noise.r - 0.5) * uBandJitter * vDetail * near01 * bandRes;
  float h01 = clamp(h * 0.5 + 0.5, 0.0, 1.0);

  // Collapse the ramp with distance, in two overlapping stages: the outer pair of
  // bands folds into its neighbour first (five tones -> three), then the whole
  // ramp folds into the mid tone (three -> one). Because the two stages overlap
  // and both ride the shared far01 ramp, the far sea loses its steps gradually
  // and arrives at the horizon as a single flat colour - which is the only way a
  // band threshold can survive a hundred wave periods landing inside one pixel.
  //
  // Distance is only a proxy for the thing that actually matters, though, which
  // is how much of the height range this one pixel spans. A steep camera looking
  // down a wave face resolves the bands perfectly at 400 m; the same 400 m seen
  // edge-on puts a whole swell inside two pixel rows. So the collapse also
  // listens directly to h01's own screen gradient and folds the ramp wherever
  // that says a band has gone sub-pixel, whatever the distance. The bar is set
  // high on purpose - a quarter of the full height range inside one pixel - so
  // it fires only on genuine aliasing and leaves the legible far bands alone.
  float hFlat = smoothstep(0.24, 0.72, fwidth(h01));
  float m1 = max(smoothstep(0.05, 0.60, far01), hFlat);
  float m2 = max(smoothstep(0.40, 1.00, far01), smoothstep(0.45, 1.00, hFlat));
  vec3 bAbyss   = mix(mix(uBandAbyss,   uBandDeep, m1), uBandMid, m2);
  vec3 bDeep    = mix(uBandDeep,    uBandMid, m2);
  vec3 bMid     = uBandMid;
  vec3 bShallow = mix(uBandShallow, uBandMid, m2);
  vec3 bCrest   = mix(mix(uBandCrest, uBandShallow, m1), uBandMid, m2);

  vec3 albedo = bAbyss;
  albedo = mix(albedo, bDeep,    wbStep(uBandEdge0,   h01, 0.0004, 0.9));
  albedo = mix(albedo, bMid,     wbStep(uBandEdges.x, h01, 0.0004, 0.9));
  albedo = mix(albedo, bShallow, wbStep(uBandEdges.y, h01, 0.0004, 0.9));
  albedo = mix(albedo, bCrest,   wbStep(uBandEdges.z, h01, 0.0004, 0.9));

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
  col = mix(col, uSkyNear, wbStep(uFresnelEdges.x, fres, 0.0004, 0.9) * uFresnelStrength.x);
  col = mix(col, uSkyFar,  wbStep(uFresnelEdges.y, fres, 0.0004, 0.9) * uFresnelStrength.y);

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
  vec2 stwv = wbMarkWidth(strokeField, uFoamWidthClamp);
  float strokeMask = smoothstep(-stwv.x, stwv.x, strokeField + stwv.y);
  col = mix(col, uStrokeColor,
            strokeMask * uStrokeStrength * (1.0 - 0.85 * far01) * mix(0.35, 1.0, foamRes));

  // The far-field bar goes *up*, not down. The previous build lowered it past the
  // chop fade on the theory that the mipped tile needed help; what it actually did
  // was detonate the foam into big flat plates just beyond the LOD ring and then
  // into per-pixel white confetti at the horizon. Density is the thing that has to
  // fall with distance - the surviving marks then get *wider*, not thinner, via
  // the clamp below.
  float cut = mix(uFoamCut.x, uFoamCut.y, far01)
            + (noise.b - 0.5) * uFoamCutJitter * near01 * bandRes;
  // A third, small tile carves holes through the interior, so a whitecap is a
  // drawn cluster of marks rather than a solid untextured slab. The carve tile is
  // the finest thing in the shader (3.7 m) so it is the first to go sub-pixel;
  // holding it to its own resolve keeps it from becoming the noise it exists to
  // break up.
  float carveRes = wbResolve(uvC, 0.11);
  float shaped = crest * uFoamGain + foamTex
               - foamC * uFoamCarve * near01 * carveRes - cut;
  // Minimum drawn width, withdrawn again once the mark is past saving - see
  // wbMarkWidth. x = half width of the step, y = the bias that keeps it fat.
  vec2 swv = wbMarkWidth(shaped, uFoamWidthClamp);
  float sw = swv.x;
  float shapedW = shaped + swv.y;
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
  foamCol *= mix(0.90, 1.04, wbStep(uBandEdges.z, h01, 0.0004, 0.9));
  // Contrast, not coverage, is what has to fall once the blobs are under a pixel:
  // the surviving marks stay where they are and simply sink toward the water they
  // sit on, so the far field loses its whitecaps as a wash rather than as
  // confetti. Not zero at the limit - a trace of foam is what keeps the far swell
  // from reading as flat paper.
  col = mix(col, foamCol, foamMask * uFoamStrength * mix(0.28, 1.0, foamRes));

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
  vec2 spFacetUv = p * uSparkleFacetScale;
  vec3 spNoise = texture(uNoiseTex, spFacetUv).rgb;
  // A star is only a star while it is several pixels across. Past that the tile
  // has already been mipped to its mean and thresholding it returns a scatter of
  // fragments - the crawling specular noise the drawn-sparkle approach exists to
  // replace. Both inputs have to hold up: the star tile for the shape, and the
  // facet jitter that decides whether the star lights at all.
  float spRes = min(wbResolve(spUv, 0.035), wbResolve(spFacetUv, 0.25));
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
  vec2 spwv = wbMarkWidth(sparkVal, uSparkleWidthClamp);
  float spOn = smoothstep(-spwv.x, spwv.x, sparkVal - uSparkleCut + spwv.y);
  col = mix(col, uSparkleColor, spOn * uSparkleStrength * spRes);

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
  // Four layers rather than two, and they run to the scene's own fog far plane
  // rather than stopping short of it. Ending the ladder early was what produced
  // the hard waterline: the last few hundred metres of sea were all past the
  // final edge, so they were one flat slab of a single colour butting straight
  // into the sky, with the course furniture inside it still at near-field
  // contrast because *that* fades on THREE.Fog's range. Sharing the far plane
  // makes the sea and the things floating on it arrive at the horizon together,
  // and four steps means the last stretch is still visibly stepping when it gets
  // there - a dissolve made of bands, not a gradient and not a cut.
  //
  // The final tone is still held slightly under the sky's, so the horizon reads
  // as a line rather than vanishing - but by a hair now, not by the eighth of a
  // stop that was drawing the line in the first place.
  float fogT = clamp((vViewDepth - uFogRange.x) / max(uFogRange.y - uFogRange.x, 1e-3), 0.0, 1.0);
  float fog = pow(fogT, uFogCurve);
  float fq = fog + (hazeN - 0.5) * uHazeJitter * hazeRes * (1.0 - fog * 0.4);
  col = mix(col, uHazeA,    wbStep(uHazeEdges.x, fq, 0.0015, 0.9));
  col = mix(col, uHazeB,    wbStep(uHazeEdges.y, fq, 0.0015, 0.9));
  col = mix(col, uHazeC,    wbStep(uHazeEdges.z, fq, 0.0015, 0.9));
  col = mix(col, uFogColor, wbStep(uHazeEdges.w, fq, 0.0015, 0.9));
  // Anti-aliases the disc's own silhouette against the sky: by the time the sea
  // reaches its outer rings it is already within a hair of the horizon colour, so
  // the stair-stepped edge has nothing left to contrast against.
  col = mix(col, uFogColor, smoothstep(0.94, 1.0, fog));

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
