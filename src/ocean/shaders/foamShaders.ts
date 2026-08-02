import { GBUFFER_OUT, OCT_PACK, GBUFFER_WRITE } from '../../render/shaders/celChunks';

/**
 * GLSL for the whitewater: the persistent wake ribbons and the spray particles.
 *
 * Four ideas run through this file.
 *
 *  1. **Foam is a threshold, never a gradient.** Both shaders take a continuous
 *     signal (an analytic blob field for the ribbon, a radial coordinate for the
 *     particles) and cut it into flat regions with a hard step. Nothing here is
 *     allowed to produce a soft edge, because a soft-edged white smear is
 *     exactly what "stylised water" is trying not to be. The one place softness
 *     is permitted is the ~1 fragment of anti-aliasing on the cut itself, which
 *     stops the shape crawling under camera motion with MSAA off.
 *
 *  2. **The mask is built in WORLD METRES, analytically.** The ribbon used to
 *     threshold a 512 px bitmap of overlapping discs tiled every 3.2 m; the
 *     bitmap's own 20-70 px discs landed at 15-40 cm in world space and its
 *     dusting of 2 px bubbles landed at a couple of centimetres, so the wake
 *     resolved on screen as a field of near-identical round cells with dithered
 *     interiors - a macro photograph of dish soap. It is now three octaves of
 *     analytic value noise scaled in metres: a primary layer at FOAM_BLOB_M
 *     that decides the silhouette, a rotated lace layer and a finer teeth layer
 *     whose amplitudes are far too small to open or close a region on their own
 *     and which therefore only scallop the *boundary*, and holes punched by a
 *     fourth. Blobs are 0.8-1.5 m across and read as large drawn silhouettes
 *     near the camera and as fewer, bigger shapes far away - never as stipple.
 *     Every high-frequency layer is faded out analytically once its features
 *     drop under a pixel, so nothing survives as isolated dots.
 *
 *  3. **Dissipation is erosion, not opacity.** A wake does not get transparent -
 *     it breaks up. Holes open with age and open on the centreline first, the
 *     threshold climbs with age fastest down that same centreline, and the band
 *     hollows out into two Kelvin arms of broken islands. Alpha holds at *one*
 *     until 86% of the ribbon's life, because a half-transparent white ribbon
 *     over blue water is not a fading wake, it is a pale blue stain.
 *
 *  4. **The G-buffer contract, under blending.** Both materials blend with
 *     SRC_ALPHA / ONE_MINUS_SRC_ALPHA, and WebGL runs that same equation on
 *     *every* colour attachment using each attachment's own alpha as the source
 *     factor. Attachment 1's alpha is `edgeMask`. Writing `edgeMask = 0` here is
 *     therefore not a hint - it provably leaves the normal/depth buffer
 *     bit-identical, so the Sobel pass inks the boat and the water underneath
 *     the foam exactly as if the foam were not there. Foam draws its own
 *     contour, in a cool blue that is a palette tone and never zero luma.
 */

// ------------------------------------------------------------- shared --------

/**
 * A threshold with exactly one fragment of transition, independent of how flat
 * the source signal has become.
 *
 * The naive `smoothstep(T - w, T + w, v)` with a constant `w` fails at distance:
 * the blob field flattens as its octaves are LOD'd away, so a fixed-width step
 * turns a crisp island into a wide grey halo. Dividing by the screen-space
 * derivative of the signal instead normalises the cut into pixel space - the
 * boundary is one pixel wide at 3 m and at 300 m, which is what keeps foam
 * reading as drawn shapes all the way to the horizon.
 */
const CRISP_STEP = /* glsl */ `
float wbCrisp(float v, float thresh, float aa) {
  return clamp((v - thresh) / aa + 0.5, 0.0, 1.0);
}
`;

/**
 * Tileable analytic value noise.
 *
 * Periodic on a NOISE_PERIOD x NOISE_PERIOD cell lattice, which is what lets the
 * drift offset below wrap without a pop: the CPU hands over a 0..1 scroll, the
 * shader multiplies it by the period, and the wrap from 1 to 0 is an exact whole
 * number of periods. Cheap enough to evaluate five times per fragment - it is
 * three hashes per corner-pair and no texture fetch, so unlike a bitmap it has
 * no mip chain to average itself into grey and no tile silhouette to recognise.
 */
const VALUE_NOISE = /* glsl */ `
float wbHash21(vec2 c) {
  vec3 p3 = fract(vec3(c.x, c.y, c.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float wbVal(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  vec2 i0 = mod(i, period);
  vec2 i1 = mod(i + 1.0, period);
  float a = wbHash21(vec2(i0.x, i0.y));
  float b = wbHash21(vec2(i1.x, i0.y));
  float c = wbHash21(vec2(i0.x, i1.y));
  float d = wbHash21(vec2(i1.x, i1.y));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec2 wbSpin(vec2 p, float c, float s) {
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}
`;

// -------------------------------------------------------- wake ribbon --------

export const WAKE_VERT = /* glsl */ `
// The ribbon's vertices are already in world space - the mesh carries an
// identity transform and the CPU writes absolute positions, because the spine
// is resampled against the ocean surface every frame anyway and a local frame
// would only add a matrix multiply to undo.
in float aSide;   // -1 / +1: which lip of the ribbon this vertex is
in vec4  aData;   // x arc length (m), y age 0..1, z strength 0..1, w half-width (m)
// The ocean's own analytic surface at this spine point, sampled on the CPU in
// the same solve that seats the vertex: xyz is the wave normal, w the horizontal
// Jacobian (below 1 where the surface is pinching, i.e. on a crest). Both are
// what stop the ribbon reading as a decal - the normal gives it the water's band
// shading over a swell, the Jacobian bunches its foam onto the crest.
in vec4  aWave;

out vec2  vWorldXZ;
out float vSide;
out float vAge;
out float vStrength;
out float vArc;
out float vJac;
out float vViewDepth;
out vec3  vWaveN;
out vec3  vViewNormal;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * world;
  vViewDepth = -mv.z;
  gl_Position = projectionMatrix * mv;

  // The foam mask is keyed off absolute world metres, not off a parametric
  // ribbon UV. That is deliberate: real wake foam is left behind *in the water*
  // and the boat drives away from it, so a world-locked mask neither stretches
  // as the ribbon spreads from one beam to five nor crawls toward the camera.
  // It also makes the blob scale mean something - a metre is a metre at any
  // distance, so near foam has large simple silhouettes and far foam collapses
  // to fewer, bigger shapes on its own.
  vWorldXZ = world.xz;

  vSide     = aSide;
  vAge      = aData.y;
  vStrength = aData.z;
  vArc      = aData.x;
  vJac      = aWave.w;
  vWaveN    = aWave.xyz;

  vViewNormal = normalize(mat3(viewMatrix) * aWave.xyz);
}
`;

export const WAKE_FRAG = /* glsl */ `
precision highp float;
${GBUFFER_OUT}
${OCT_PACK}
${GBUFFER_WRITE}
${CRISP_STEP}
${VALUE_NOISE}

uniform vec3  uFoamColor;   // hot, sun-facing foam
uniform vec3  uFoamShade;   // cool blue-white shadow tone
uniform vec3  uFoamEdge;    // drawn contour: a deep water blue, never zero luma
uniform vec3  uSunDir;      // world space, normalised, points toward the sun
uniform vec2  uScroll;      // two independent wrapped 0..1 drift offsets
uniform float uOpacity;

in vec2  vWorldXZ;
in float vSide;
in float vAge;
in float vStrength;
in float vArc;
in float vJac;
in float vViewDepth;
in vec3  vWaveN;
in vec3  vViewNormal;

// -- mask scales, in world metres ---------------------------------------------
// The primary layer decides the silhouette. 1.9 m per cell was too coarse to be
// a silhouette at all: the near end of a spread wake is only three or four
// cells wide, so the whole ribbon came out as one lazy smooth-sided amoeba - a
// spilled liquid, not a drawn shape. At 0.78 m a thresholded island lands at
// 0.8-1.5 m, which is 150-350 px at the six to ten metres the near wake sits
// from a chase camera: several distinct shapes across the band, each still far
// bigger than the 8-25 px bubble cells this replaced. The lace and teeth layers
// only perturb the *boundary* (their amplitudes are far too small to open or
// close a region on their own), so they scallop the silhouette without ever
// degenerating into stipple, and both fade out analytically once their features
// fall under a pixel.
const float FOAM_BLOB_M  = 0.78;
const float FOAM_LACE_M  = 0.33;
const float FOAM_TEETH_M = 0.145;
const float FOAM_HOLE_M  = 0.52;
const float NOISE_PERIOD = 32.0;   // cells; 25 m before the primary layer repeats

// How deep an interior hole cuts, and where the hole layer is cut. Holes are
// thresholded before they are subtracted, so their rims are hard - a soft hole
// would read as a smudge in the middle of a white shape. The hole layer carries
// its own second octave for the same reason the silhouette does: a single
// octave of value noise punches suspiciously round holes, and a round hole with
// a contour drawn round it is a clip-art bubble.
const float HOLE_T = 0.60;
const float HOLE_DEPTH = 1.30;

// How far to probe for the shaded side, in metres, on a sun-facing and on a
// down-sun facet of the swell. This is the width of the down-sun band, so it is
// specified in world space and honestly shrinks with distance rather than being
// locked to a screen width. It has to stay small against FOAM_BLOB_M or the
// "rim" swallows the shape and the ribbon reads as pale blue rather than white.
// The wider value is the whole of the swell shading: instead of tinting the
// body - a third tone, and the thing that turned this into a milk spill - a
// ribbon segment lying on the back face of a swell simply draws a fatter cool
// rim. Two tones, one hard step, and the wake still visibly bands over a crest.
const float SHADE_M = 0.085;
const float SHADE_DARK_M = 0.30;

// -- thresholds ---------------------------------------------------------------
// A fresh wake keeps a bit over half the field, an exhausted one keeps nothing:
// T_SPENT sits above the field's own maximum on purpose, so the tail is
// guaranteed to erode to bare water rather than thinning to a permanent haze.
const float T_FRESH = 0.22;
const float T_SPENT = 0.96;

// How much further the threshold climbs at the ribbon's outer lips. Without it
// the wake would end in two dead-straight ruled lines - the geometry's edges.
// With it the silhouette is cut by the blob field and comes out scalloped, and
// the outermost foam breaks into separate clumps.
const float EDGE_BITE = 0.38;

// Width of the drawn contour, in *fragments*. The aa term below is one
// fragment's worth of the field, so scaling the inner cut by it locks the line
// to a fixed screen width - the same couple of pixels under the bow and two
// hundred metres astern.
const float INK_PX = 1.5;

/**
 * The foam field: primary blob layer, a rotated lace octave that scallops the
 * boundary and a finer teeth octave that bites into it. Returned in roughly
 * -0.28 .. 1.02.
 */
float wbFoamField(vec2 q, vec2 sc, float lace, float teeth) {
  float a = wbVal(q / FOAM_BLOB_M + vec2(sc.x, 0.0), NOISE_PERIOD);
  // 0.868 / 0.497 is 29.8 degrees - an irrational-ish angle against the primary
  // lattice, so the two layers never line up and no single blob silhouette
  // repeats inside one screen. The teeth layer is turned the other way again.
  vec2 r = wbSpin(q, 0.868, 0.497);
  float b = wbVal(r / FOAM_LACE_M + vec2(0.0, sc.y), NOISE_PERIOD);
  vec2 s = wbSpin(q, -0.454, 0.891);
  float c = wbVal(s / FOAM_TEETH_M + vec2(sc.y, sc.x), NOISE_PERIOD);
  return a * 0.74 + (b - 0.5) * 0.40 * lace + (c - 0.5) * 0.24 * teeth;
}

void main() {
  float edge = abs(vSide);
  vec2 q = vWorldXZ;
  vec2 sc = uScroll * NOISE_PERIOD;

  // Metres of world covered by one pixel here. Everything finer than this is
  // faded out rather than left to alias into stipple.
  float fp = max(fwidth(q.x), fwidth(q.y));
  float lace    = 1.0 - smoothstep(FOAM_LACE_M  * 0.30, FOAM_LACE_M  * 0.95, fp);
  float teeth   = 1.0 - smoothstep(FOAM_TEETH_M * 0.30, FOAM_TEETH_M * 0.95, fp);
  float holeLod = 1.0 - smoothstep(FOAM_HOLE_M  * 0.30, FOAM_HOLE_M  * 0.95, fp);

  float base = wbFoamField(q, sc, lace, teeth);
  // aa comes from the *smooth* part of the field only. Taking it after the hole
  // subtraction would spike the derivative on every hole rim and blur exactly
  // the edges that are supposed to be hardest.
  float aa = max(fwidth(base) * 1.15, 1e-4);

  // --- wake structure --------------------------------------------------------
  // A real wake is not a uniform strip. There is a hard bright core of prop wash
  // immediately behind the transom, two Kelvin shoulders that carry the densest
  // foam and outlive everything else, and a centreline that hollows out first as
  // the trail ages - which is why an old wake reads as two broken arms rather
  // than as a painted stripe.
  float shoulder = 1.0 - smoothstep(0.10, 0.62, abs(edge - 0.72));
  float centre   = 1.0 - smoothstep(0.0,  0.40, edge);
  float propWash = 1.0 - smoothstep(0.0,  0.22, vAge);

  // Interior holes. They are what turns "a white band" into "eroding foam", so
  // they are driven by age and biased onto the centreline: prop wash straight
  // off the transom is solid, and by halfway through the ribbon's life the
  // middle of the band is more hole than foam. This and the centreline
  // threshold lift below are the whole of the dissipation - the alpha stays at
  // one until the very end, because a half-transparent white ribbon over blue
  // water is a pale blue stain and that is the failure this replaces.
  vec2 hq = wbSpin(q, 0.612, -0.791) / FOAM_HOLE_M + vec2(sc.y * 0.5, -sc.x * 0.5);
  vec2 hq2 = wbSpin(q, 0.290, 0.957) / FOAM_TEETH_M + vec2(-sc.x, sc.y);
  float hole = wbVal(hq, NOISE_PERIOD) + (wbVal(hq2, NOISE_PERIOD) - 0.5) * 0.22 * teeth;
  float haa = max(fwidth(hole) * 1.2, 1e-4);
  // A small constant term so a fresh mass is not a featureless plate - at three
  // metres from a chase camera one 0.78 m blob covers most of the lower frame,
  // and the round-1 review called exactly that an ice sheet.
  float holeAge = 0.22 + 1.00 * smoothstep(0.14, 0.80, vAge);
  float holeAmt = holeLod * holeAge * (0.62 + 0.60 * centre);
  float field = base - HOLE_DEPTH * holeAmt * wbCrisp(hole, HOLE_T, haa);

  // Cross-wake arcs at the hull's own oscillation scale, so the ribbon carries
  // visible transverse structure instead of one continuous density.
  float arcs = sin(vArc * 1.35 + edge * 2.6);

  float thresh = mix(T_FRESH, T_SPENT, vAge * vAge)
               + EDGE_BITE * edge * edge                      // scalloped silhouette
               + centre * 0.46 * smoothstep(0.18, 0.78, vAge) // hollows out with age
               - centre * 0.34 * propWash                     // hard core off the transom
               - propWash * 0.12                              // ... solid right across it
               - shoulder * 0.24                              // dense Kelvin arms
               + arcs * 0.050 * (1.0 - vAge);

  // Weak wakes (idling, coasting) should thin out, not just get transparent.
  thresh += (1.0 - vStrength) * 0.24;

  // The swell the ribbon is lying on. jac < 1 means the surface is pinching, so
  // foam bunches on the up-face of a crest and thins in a trough - the wake
  // visibly climbing a swell is most of what makes it read as material sitting
  // on moving water rather than a decal painted across it.
  float crest = 1.0 - smoothstep(0.88, 1.06, vJac);
  thresh -= crest * 0.18;
  thresh += (1.0 - crest) * 0.06;

  float mOuter = wbCrisp(field, thresh,               aa);
  // The contour is cut against the *unpunched* field on purpose. Taking it
  // against the holed field draws a closed loop round every hole, and a small
  // round hole with a line round it is a clip-art bubble - which is exactly
  // what the last pass was reported as. Drawn from the base field the ink only
  // ever appears on the mass's outer silhouette; holes come out as clean hard
  // bites of open water, which is what punched foam actually looks like. There
  // is no risk of a stray line inside the water, because ink is only visible
  // where the foam is opaque and the foam is opaque only where base >= thresh.
  float mInner = wbCrisp(base,  thresh + aa * INK_PX, aa);

  // The ocean's own lit/unlit split, taken from the wave normal at this spine
  // point, so the ribbon steps exactly where the water under it does.
  float waveLit = step(0.10, dot(normalize(vWaveN), uSunDir));

  // The down-sun side. Probing the field a fixed number of metres *away* from
  // the sun lands outside the blob only on its down-sun rim, so the step is a
  // drawn shadow edge with a hard boundary rather than a dot product smeared
  // over the shape. The probe distance is the only thing the swell shading
  // touches - see SHADE_DARK_M.
  vec2 sunXZ = normalize(uSunDir.xz + vec2(1e-5, 1e-5));
  float shadeM = mix(SHADE_DARK_M, SHADE_M, waveLit);
  float away = wbFoamField(q - sunXZ * shadeM, sc, lace, teeth);
  float mLit = wbCrisp(away, thresh, aa);

  // Opacity holds at one for the first 86% of the ribbon's life and is gone by
  // the end of it - a shade under four seconds at WAKE_LIFE. By the time it
  // starts to move the erosion above has already reduced the tail to a scatter
  // of small islands, so nothing large ever draws at a partial alpha and the
  // foam never blends with the water into a pale wash.
  float alpha = mOuter * uOpacity * (1.0 - smoothstep(0.86, 1.0, vAge));
  if (alpha < 0.004) discard;

  // Two tones and a drawn contour. Nothing else: the body is PALETTE.foam flat
  // out, PALETTE.foamShade appears only as the down-sun rim, and there is no
  // gradient anywhere between them.
  vec3 col = uFoamColor;
  col = mix(uFoamShade, col, mLit);   // down-sun shadow step
  col = mix(uFoamEdge, col, mInner);  // contour on the silhouette and hole rims

  gColor = vec4(col, alpha);
  // edgeMask = 0 - see the note at the top of this file. The Sobel pass keeps
  // inking the hull and the swell straight through the foam.
  wbWriteGBuffer(normalize(vViewNormal), vViewDepth, 0.0);
}
`;

// ------------------------------------------------------------- spray ---------

export const SPRAY_VERT = /* glsl */ `
in float aRadial;   // 0 at the droplet's centre, 1 at its rim - drives the tone rings
in vec3  aOffset;   // instance: world centre
in vec4  aParams;   // instance: x half-width (m), y half-length (m), z stretch, w alpha
in vec3  aTint;     // instance: multiplier on the foam colour, white to pale cyan
in vec3  aVel;      // instance: world velocity, for velocity-aligned orientation

out float vRadial;
out float vAlpha;
out vec3  vTint;
out float vViewDepth;
out vec3  vViewNormal;

void main() {
  vec3 centre = aOffset;

  // Cylindrical billboard: the card yaws to face the camera but its up axis
  // stays world up. A full camera-facing quad tips with the chase cam's pitch
  // and instantly reads as a sprite; locking up also means the vertical squash
  // flattens the particle against the *water*, which is the whole point of the
  // impact splat.
  vec2 flat2 = cameraPosition.xz - centre.xz;
  float l = length(flat2);
  vec2 f = l > 1e-4 ? flat2 / l : vec2(0.0, 1.0);
  vec3 right = vec3(f.y, 0.0, -f.x);          // == cross(worldUp, fwd)

  // Orient the droplet along its own screen-space velocity instead of spinning
  // it at random. The blob geometry tapers toward local +Y, so aiming +Y down
  // the *reverse* of travel puts the tail behind the droplet and the round head
  // in front - a comma, the way spray is drawn. Below a metre a second there is
  // no meaningful direction left, so it falls back to upright.
  vec2 v2 = vec2(dot(aVel, right), aVel.y);
  float sp = length(v2);
  vec2 tail = sp > 1.0 ? -v2 / sp : vec2(0.0, 1.0);
  vec2 side = vec2(tail.y, -tail.x);

  // Scale in card space, then rotate onto the tail axis: the stretch has to run
  // along the direction of travel, not along a fixed axis.
  vec2 p = vec2(position.x * aParams.x, position.y * aParams.y * aParams.z);
  vec2 card = side * p.x + tail * p.y;

  vec3 world = centre + right * card.x + vec3(0.0, card.y, 0.0);

  vec4 mv = viewMatrix * vec4(world, 1.0);
  vViewDepth = -mv.z;
  gl_Position = projectionMatrix * mv;

  vRadial = aRadial;
  vAlpha  = aParams.w;
  vTint   = aTint;
  vViewNormal = normalize(mat3(viewMatrix) * vec3(f.x, 0.0, f.y));
}
`;

export const SPRAY_FRAG = /* glsl */ `
precision highp float;
${GBUFFER_OUT}
${OCT_PACK}
${GBUFFER_WRITE}

uniform vec3  uFoamColor;
uniform vec3  uFoamShade;
uniform vec3  uFoamEdge;
uniform float uOpacity;

in float vRadial;
in float vAlpha;
in vec3  vTint;
in float vViewDepth;
in vec3  vViewNormal;

// Tone ring boundaries. These are placed on the *geometry's* ring radii (see
// makeSprayBlob in FoamSystem.ts), so the steps land exactly on triangle edges
// and come out perfectly clean rather than wobbling through interpolation.
//
// They moved a long way out. With the shadow ring at 52% of the radius, half of
// every droplet was the cool tone and the outer tenth was a contour, so a
// droplet drawn over the wake read as a pale ring with a lighter middle - a
// bubble, and with two dozen of them at near-identical sizes, clip-art.
//
// The rings are a fixed *fraction* of the radius, which is the real trap: a
// droplet near the camera gets a proportionally fat ring and so it is the big
// ones that read as outlined bubbles. At 86% and 95% the two bands are a tenth
// and a twentieth of the radius, which is a drawn line on a large droplet and
// vanishes entirely on a small one - the same behaviour the ribbon's contour
// gets from being specified in fragments.
const float R_CORE = 0.90;
const float R_BODY = 0.96;

void main() {
  float alpha = vAlpha * uOpacity;
  if (alpha < 0.008) discard;

  // Two flat tones plus a drawn rim. No falloff, no soft edge, no gaussian
  // anything: a drawn droplet is a white shape with a cool step on its lower
  // rim and a contour. The rim is a deep water blue rather than ink so a droplet
  // that shrinks to two pixels resolves to a dark *blue* chip and never to a
  // black one.
  vec3 col = uFoamColor;
  col = mix(col, uFoamShade, step(R_CORE, vRadial));
  col = mix(col, mix(uFoamShade, uFoamEdge, 0.42), step(R_BODY, vRadial));
  col *= vTint;

  gColor = vec4(col, alpha);
  // edgeMask = 0: spray carries its own silhouette, and this keeps attachment 1
  // untouched so the Sobel pass does not scribble a border round every droplet.
  wbWriteGBuffer(normalize(vViewNormal), vViewDepth, 0.0);
}
`;
