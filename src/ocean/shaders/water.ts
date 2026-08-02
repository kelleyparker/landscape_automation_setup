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
uniform vec3  uBandDeep;
uniform vec3  uBandMid;
uniform vec3  uBandShallow;
uniform vec3  uBandCrest;
/** Band edges in 0..1 height space. Deliberately uneven - see Ocean.ts. */
uniform vec3  uBandEdges;
/** Fraction of WB_MAX_WAVE_HEIGHT that maps to the full 0..1 band range. */
uniform float uBandFraction;
/** How far the noise field is allowed to push a band edge, in height units. */
uniform float uBandJitter;

// --- sky response ----------------------------------------------------------
uniform vec3  uSkyNear;
uniform vec3  uSkyFar;
uniform float uFresnelPower;
uniform vec2  uFresnelEdges;
uniform vec2  uFresnelStrength;

// --- backlit crest ---------------------------------------------------------
uniform vec3  uTranslucent;
uniform float uTransCut;
uniform float uTransStrength;
uniform vec2  uTransFade;

// --- foam ------------------------------------------------------------------
uniform sampler2D uFoamTex;
uniform vec3  uFoamColor;
uniform vec3  uFoamShadeColor;
/** Wave-locked scroll offsets, in metres. See Ocean.ts for the sign. */
uniform vec2  uFoamScrollA;
uniform vec2  uFoamScrollB;
uniform float uFoamScaleA;   // uv per metre
uniform float uFoamScaleB;
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

// --- sparkle ---------------------------------------------------------------
uniform sampler2D uSparkleTex;
uniform sampler2D uNoiseTex;
uniform float uNoiseScale;
uniform float uSparkleScale;
uniform float uSparkleLobe;
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
uniform vec3  uFogColor;
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
  vec2 p = vParam;

  float ndl = dot(N, L);
  float ndv = dot(N, V);

  // ------------------------------------------------------------- textures ----
  // Foam UVs are built from the *parameter* coordinate and scrolled with the two
  // swells, so the pattern rides the crests instead of sitting still in the world
  // while the crests travel through it. That is the difference between foam that
  // reads as water and foam that twinkles.
  vec2 uvA = (p + uFoamScrollA) * uFoamScaleA;
  vec2 uvB = (p + uFoamScrollB) * uFoamScaleB;
  float foamA = texture(uFoamTex, uvA).r;
  float foamB = texture(uFoamTex, uvB).r;
  float foamTex = foamA * 0.58 + foamB * 0.46;

  vec3 noise = texture(uNoiseTex, (p + uFoamScrollA) * uNoiseScale).rgb;

  // --------------------------------------------------------- height bands ----
  // Four flat colours keyed to the world height of the displaced surface. The
  // noise nudge is small - well under a band - but it is what stops the edges
  // reading as mathematical contour lines on a topographic map. It rides the same
  // scroll as the foam, so the wobble travels with the wave rather than sitting
  // still while the water moves under it, and it fades out at range where the
  // band edges are sub-pixel anyway.
  float h = vWorldPos.y / (WB_MAX_WAVE_HEIGHT * uBandFraction);
  h += (noise.r - 0.5) * uBandJitter * vDetail;
  float h01 = clamp(h * 0.5 + 0.5, 0.0, 1.0);

  vec3 albedo = uBandDeep;
  albedo = mix(albedo, uBandMid,     wbStep(uBandEdges.x, h01, 0.0004, 0.5));
  albedo = mix(albedo, uBandShallow, wbStep(uBandEdges.y, h01, 0.0004, 0.5));
  albedo = mix(albedo, uBandCrest,   wbStep(uBandEdges.z, h01, 0.0004, 0.5));

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

  // --------------------------------------------------- backlit translucency ---
  // Light entering the sun-facing back of a thin crest and coming out toward the
  // eye. The gate is geometric, so it fires on any crest oriented that way rather
  // than only when the camera happens to face the sun: the surface must face the
  // sun (ndl high) while turning away from us (ndv low), and it must be near the
  // top of a wave where the water is thin. Looking into the sun then strengthens
  // it. Thresholded hard, which is what turns it into a drawn band of glowing
  // green-teal along the crest instead of a soft sheen.
  float backLook = pow(clamp(-dot(V, L), 0.0, 1.0), 1.5);
  float thin = smoothstep(0.36, 0.78, ndl)
             * (1.0 - smoothstep(0.04, 0.56, ndv))
             * smoothstep(0.56, 0.84, h01)
             * (1.0 - smoothstep(uTransFade.x, uTransFade.y, vViewDepth));
  float trans = thin * (0.30 + 0.70 * backLook);
  col = mix(col, uTranslucent, wbStep(uTransCut, trans, 0.002, 0.3) * uTransStrength);

  // ------------------------------------------------------------------ foam ---
  // The Jacobian is the honest crest signal: it is < 1 exactly where the Gerstner
  // map is compressing the surface horizontally, which is the pinch at the top of
  // a wave and nowhere else. Thresholding it alone would give a smooth ridge, so
  // the foam texture is added *before* the threshold - the shapes and holes then
  // come out of the drawn alphabet rather than out of a falloff.
  float crest = 1.0 - smoothstep(uFoamJac.x, uFoamJac.y, vJac);
  crest *= smoothstep(uFoamHeightGate.x, uFoamHeightGate.y, h01);

  // At range the foam tile mips toward its own mean, which would quietly erase
  // every distant whitecap - hence a lower bar out there. The noise nudge on top
  // of it matters more than it looks: past the chop fade the surface is only three
  // waves, so its crest lines are regular, and a constant threshold turns the far
  // sea into evenly-spaced rows of white dashes that read as knitting. Jittering
  // the bar with a low-frequency field breaks the rows without touching geometry.
  float cut = mix(uFoamCut.y, uFoamCut.x, vDetail)
            + (noise.b - 0.5) * uFoamCutJitter * (1.0 - vDetail);
  float shaped = crest * uFoamGain + foamTex - cut;
  float sw = clamp(fwidth(shaped) * 0.6, 0.004, 0.35);
  float foamMask = smoothstep(-sw, sw, shaped);

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
  float foamCore = smoothstep(-sw, sw, shaped - rimBias);
  vec3 foamCol = mix(uFoamShadeColor, uFoamColor, foamCore);
  // One hard light step on the foam itself, so it sits in the same lighting as
  // the water instead of floating above it.
  foamCol *= mix(0.86, 1.06, smoothstep(-0.02, 0.16, ndl));
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
  // Manga twinkles, not specular noise. The tile of four-point stars is projected
  // flat onto the water, gated to the sun's reflection band and to the tops of
  // waves, then hard thresholded - so what survives is a sparse scatter of crisp
  // white shapes. Each star carries its own phase out of the noise texture, so
  // they blink independently instead of pulsing in unison or sliding as a field.
  vec2 spUv = p * uSparkleScale;
  float sp = texture(uSparkleTex, spUv).r;
  float starPhase = texture(uNoiseTex, spUv * 0.19).b;
  float blink = 0.5 + 0.5 * sin(uTime * uSparkleRate + starPhase * 41.0);
  vec3 H = normalize(L + V);
  float sunBand = pow(max(dot(N, H), 0.0), uSparkleLobe);
  float sparkVal = sp
    * (0.22 + 0.90 * blink)
    * (0.20 + 1.45 * sunBand)
    * smoothstep(0.38, 0.76, h01)
    * (1.0 - smoothstep(uSparkleFade.x, uSparkleFade.y, vViewDepth));
  col += uFoamColor * wbStep(uSparkleCut, sparkVal, 0.003, 0.4) * uSparkleStrength;

  // ------------------------------------------------------------------- fog ---
  // Matches the scene fog exactly (Ocean.ts reads it off the scene), so the far
  // edge of the disc arrives at the sky's own horizon colour and there is no line
  // where the water stops. Smooth, not banded: this is atmosphere, and quantising
  // a purely distance-driven term would stamp perfect concentric rings on the sea.
  float fog = clamp((vViewDepth - uFogRange.x) / max(uFogRange.y - uFogRange.x, 1e-3), 0.0, 1.0);
  fog = fog * fog * (3.0 - 2.0 * fog);
  col = mix(col, uFogColor, fog);

  // --------------------------------------------------------------- g-buffer --
  // Low but non-zero: the Sobel pass must not scribble a line over every wave,
  // but the biggest crests earn a faint one. Foam shapes are already drawn art,
  // so they pull it down further, and the horizon drops to zero so the sea's far
  // edge is never inked against the sky.
  float edgeMask = uEdgeMask.x + uEdgeMask.y * smoothstep(0.70, 0.95, h01);
  edgeMask *= 1.0 - 0.55 * foamMask;
  edgeMask *= 1.0 - fog;

  gColor = vec4(col, 1.0);
  wbWriteGBuffer(normalize(mat3(viewMatrix) * N), vViewDepth, edgeMask);
}
`;

  return { vertexShader, fragmentShader };
}
