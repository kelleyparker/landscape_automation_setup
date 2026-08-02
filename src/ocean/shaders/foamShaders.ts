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
 *     interiors - a macro photograph of dish soap. It is now two octaves of
 *     analytic value noise scaled in metres: a primary layer at FOAM_BLOB_M and
 *     a rotated, differently-scaled lace layer, with holes punched by a third.
 *     Blobs are therefore 1-2 m across and read as large drawn silhouettes near
 *     the camera and as fewer, bigger shapes far away - never as stipple. Both
 *     high-frequency layers are faded out analytically once their features drop
 *     under a pixel, so nothing survives as isolated dots.
 *
 *  3. **Dissipation is erosion, not opacity.** A wake does not get transparent -
 *     it breaks up. The ribbon raises its threshold with age (fastest down the
 *     centreline, so the band hollows out and leaves two Kelvin arms of broken
 *     islands), and only then fades what is left, reaching zero at ~80% of the
 *     ribbon's life.
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
// The primary layer decides the silhouette. At 1.9 m per cell a thresholded
// island lands at roughly 1-2 m across, which is 150-300 px at the ten metres
// or so that the near end of the wake sits from a chase camera - a drawn shape,
// not a bubble. The lace layer scallops the edge and the hole layer punches the
// interior; both are analytically faded out once their features fall under a
// pixel, so at distance the foam simplifies instead of dissolving into dots.
const float FOAM_BLOB_M = 1.90;
const float FOAM_LACE_M = 0.72;
const float FOAM_HOLE_M = 1.20;
const float NOISE_PERIOD = 32.0;   // cells; 83 m before the primary layer repeats

// How deep an interior hole cuts, and where the hole layer is cut. Holes are
// thresholded before they are subtracted, so their rims are hard - a soft hole
// would read as a smudge in the middle of a white shape.
const float HOLE_T = 0.66;
const float HOLE_DEPTH = 1.15;

// How far to probe for the shaded side, in metres. This is the width of the
// down-sun band, so it is specified in world space and honestly shrinks with
// distance rather than being locked to a screen width.
const float SHADE_M = 0.40;

// -- thresholds ---------------------------------------------------------------
// A fresh wake keeps a bit under half the field, an exhausted one keeps nothing:
// T_SPENT sits above the field's own maximum on purpose, so the tail is
// guaranteed to erode to bare water rather than thinning to a permanent haze.
const float T_FRESH = 0.40;
const float T_SPENT = 0.98;

// How much further the threshold climbs at the ribbon's outer lips. Without it
// the wake would end in two dead-straight ruled lines - the geometry's edges.
// With it the silhouette is cut by the blob field and comes out scalloped, and
// the outermost foam breaks into separate clumps.
const float EDGE_BITE = 0.42;

// Width of the drawn contour, in *fragments*. The aa term below is one
// fragment's worth of the field, so scaling the inner cut by it locks the line
// to a fixed screen width - the same couple of pixels under the bow and two
// hundred metres astern.
const float INK_PX = 1.9;

// How far above the cut the hot core sits. Unlike the contour this is genuinely
// a *value* offset: it marks where the whitewater is thick, so it grows and
// shrinks with the foam rather than hugging its outline.
const float CORE = 0.24;

/**
 * The foam field: primary blob layer plus a rotated, differently-scaled lace
 * octave. Returned in roughly -0.17 .. 0.95.
 */
float wbFoamField(vec2 q, vec2 sc, float lace) {
  float a = wbVal(q / FOAM_BLOB_M + vec2(sc.x, 0.0), NOISE_PERIOD);
  // 0.868 / 0.497 is 29.8 degrees - an irrational-ish angle against the primary
  // lattice, so the two layers never line up and no single blob silhouette
  // repeats inside one screen.
  vec2 r = wbSpin(q, 0.868, 0.497);
  float b = wbVal(r / FOAM_LACE_M + vec2(0.0, sc.y), NOISE_PERIOD);
  return a * 0.78 + (b - 0.5) * 0.44 * lace;
}

void main() {
  float edge = abs(vSide);
  vec2 q = vWorldXZ;
  vec2 sc = uScroll * NOISE_PERIOD;

  // Metres of world covered by one pixel here. Everything finer than this is
  // faded out rather than left to alias into stipple.
  float fp = max(fwidth(q.x), fwidth(q.y));
  float lace    = 1.0 - smoothstep(FOAM_LACE_M * 0.26, FOAM_LACE_M * 0.80, fp);
  float holeLod = 1.0 - smoothstep(FOAM_HOLE_M * 0.26, FOAM_HOLE_M * 0.80, fp);

  float base = wbFoamField(q, sc, lace);
  // aa comes from the *smooth* part of the field only. Taking it after the hole
  // subtraction would spike the derivative on every hole rim and blur exactly
  // the edges that are supposed to be hardest.
  float aa = max(fwidth(base) * 1.15, 1e-4);

  vec2 hq = wbSpin(q, 0.612, -0.791) / FOAM_HOLE_M + vec2(sc.y * 0.5, -sc.x * 0.5);
  float hole = wbVal(hq, NOISE_PERIOD);
  float haa = max(fwidth(hole) * 1.2, 1e-4);
  float field = base - HOLE_DEPTH * holeLod * wbCrisp(hole, HOLE_T, haa);

  // --- wake structure --------------------------------------------------------
  // A real wake is not a uniform strip. There is a hard bright core of prop wash
  // immediately behind the transom, two Kelvin shoulders that carry the densest
  // foam and outlive everything else, and a centreline that hollows out first as
  // the trail ages - which is why an old wake reads as two broken arms rather
  // than as a painted stripe.
  float shoulder = 1.0 - smoothstep(0.10, 0.62, abs(edge - 0.72));
  float centre   = 1.0 - smoothstep(0.0,  0.40, edge);
  float propWash = 1.0 - smoothstep(0.0,  0.11, vAge);

  // Cross-wake arcs at the hull's own oscillation scale, so the ribbon carries
  // visible transverse structure instead of one continuous density.
  float arcs = sin(vArc * 1.35 + edge * 2.6);

  float thresh = mix(T_FRESH, T_SPENT, vAge * vAge)
               + EDGE_BITE * edge * edge                      // scalloped silhouette
               + centre * 0.40 * smoothstep(0.10, 0.72, vAge) // hollows out with age
               - centre * 0.26 * propWash                     // hard core off the transom
               - shoulder * 0.17                              // dense Kelvin arms
               + arcs * 0.055 * (1.0 - vAge);

  // Weak wakes (idling, coasting) should thin out, not just get transparent.
  thresh += (1.0 - vStrength) * 0.24;

  // The swell the ribbon is lying on. jac < 1 means the surface is pinching, so
  // foam bunches and brightens on the up-face of a crest and thins in a trough -
  // the wake visibly climbing a swell is most of what makes it read as material
  // sitting on moving water rather than a decal painted across it.
  float crest = 1.0 - smoothstep(0.88, 1.06, vJac);
  thresh -= crest * 0.16;
  thresh += (1.0 - crest) * 0.05;

  float mOuter = wbCrisp(field, thresh,                aa);
  float mInner = wbCrisp(field, thresh + aa * INK_PX,  aa);
  float mCore  = wbCrisp(field, thresh + CORE,         aa);

  // The down-sun side. Probing the field one SHADE_M *away* from the sun lands
  // outside the blob only on its down-sun rim, so the step is a drawn shadow
  // edge with a hard boundary rather than a dot product smeared over the shape.
  vec2 sunXZ = normalize(uSunDir.xz + vec2(1e-5, 1e-5));
  float away = wbFoamField(q - sunXZ * SHADE_M, sc, lace);
  float mLit = wbCrisp(away, thresh, aa);

  // Alpha decays to zero at 80% of the ribbon's life - about four seconds - on
  // top of the erosion above, so the tail dissolves into islands and then goes
  // rather than running off the bottom of frame at full strength.
  float tailFade = 1.0 - smoothstep(0.38, 0.82, vAge);
  float alpha = mOuter * tailFade * uOpacity * (0.92 + 0.08 * vStrength);
  if (alpha < 0.004) discard;

  // The ocean's own two-band shading, taken from the wave normal at this spine
  // point, so the ribbon steps darker on the back face of a swell exactly where
  // the water under it does.
  float ndl = dot(normalize(vWaveN), uSunDir);
  float waveLit = step(0.10, ndl);

  // Four flat tones and no gradient anywhere between them: drawn contour, cool
  // shadow, body, hot lip. The body is deliberately pulled off pure white
  // towards the shade tone - pure white belongs to the sun-facing crest lip and
  // the hero rim light, not to eight percent of the frame.
  vec3 body = mix(uFoamShade, uFoamColor, 0.88);
  vec3 col = body;
  col = mix(uFoamShade, col, mLit);                      // down-sun shadow step
  col = mix(col, uFoamColor, mCore * waveLit);           // sun-facing hot lip
  col = mix(col, mix(col, uFoamShade, 0.34), 1.0 - waveLit);
  col = mix(uFoamEdge, col, mInner);                     // contour on the silhouette

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
const float R_CORE = 0.52;
const float R_BODY = 0.90;

void main() {
  float alpha = vAlpha * uOpacity;
  if (alpha < 0.008) discard;

  // Three flat tones plus a drawn rim. No falloff, no soft edge, no gaussian
  // anything: a drawn droplet is a white shape with a cool shadow interior and
  // a contour. The rim is a deep water blue rather than ink so a droplet that
  // shrinks to two pixels resolves to a dark *blue* chip and never to a black
  // one.
  vec3 col = mix(uFoamShade, uFoamColor, 0.82);
  col = mix(col, uFoamShade, step(R_CORE, vRadial));
  col = mix(col, mix(uFoamShade, uFoamEdge, 0.38), step(R_BODY, vRadial));
  col = mix(col, uFoamColor, (1.0 - step(R_CORE * 0.55, vRadial)) * 0.5);
  col *= vTint;

  gColor = vec4(col, alpha);
  // edgeMask = 0: spray carries its own silhouette, and this keeps attachment 1
  // untouched so the Sobel pass does not scribble a border round every droplet.
  wbWriteGBuffer(normalize(vViewNormal), vViewDepth, 0.0);
}
`;
