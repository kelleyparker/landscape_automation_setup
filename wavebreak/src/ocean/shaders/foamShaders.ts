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
in float aSide;   // -1 .. +1 in five steps: which lane across the ribbon this vertex is
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

// The FORM layer. This is a shading-only octave - it never opens or closes a
// region, it only decides which side of a multi-metre lump of whitewater is
// turned toward the sun.
//
// It exists because the two shading terms this file used to have were both the
// wrong SIZE. The per-island rim is a fixed width in metres, so on the merged
// near-wake mass (many metres across, and most of the lower frame from a chase
// camera) it is a sliver; the swell band is set by the 78 m / 51 m / 27.5 m
// wave components, so one band is 13-39 m across and the entire visible ribbon
// lands inside a single one and draws as one flat value. Measured over the
// wake camera's ribbon rect, that produced 67% of the foam area in the shade
// tone as one unbroken region - a flat blue plate, which is the same defect as
// a flat white plate.
//
// 2.6 m is the scale a cel painter actually draws foam form at: two or three
// lit/shaded masses across a spread wake, each one still far larger than the
// 0.8-1.5 m silhouette islands, so the shading reads as volume on the mass
// rather than as a second silhouette competing with it. It is probed as a
// directional difference (see formLit in main) rather than as a plain
// threshold, so the shade lands on the down-sun FLANK of each lump - which is
// what makes it read as form and not as a second layer of blobs.
const float FOAM_FORM_M  = 2.6;
const float FORM_SHADE_M = 1.0;
// Bias on the form difference, and how far the swell band moves it.
//
// The difference of the 2.6 m octave across a 1.0 m lag is symmetric about zero
// with a standard deviation of 0.142 (measured over 400k samples of this exact
// hash, not assumed), so the bias maps directly onto a lit fraction: +0.18
// leaves 89% of a sun-facing swell lit, and +0.18-0.34 = -0.16 leaves 14% of
// the swell's back face lit.
//
// That is the whole relationship between the two scales. The swell does not get
// its own flat tone any more - it MOVES THE FORM THRESHOLD. Giving it its own
// tone is what produced the measured failure: one band is 13-39 m across, wider
// than the drawn wake, so the entire ribbon fell inside a single band and drew
// as one value with a hard straight line across it. Driving the form threshold
// instead means a ribbon on a sun-facing swell still has form shadow (just
// less of it), a ribbon on the back of one is mostly shadow with a few lit
// tops, and the transition between the two is a change of shadow density
// rather than a step to a different flat colour.
const float FORM_BIAS  = 0.24;
const float FORM_SWELL = 0.10;

// Where the hole layer is cut. Holes are a *threshold* on their own noise
// rather than a variable-depth subtraction from the silhouette field: that
// makes a hole rim a true iso-line of a single signal, which is what lets the
// contour below be cut from the same pixel-space distance as the alpha. A
// hole rim with a well-behaved derivative is also what stops the contour on it
// pulsing in width as the noise flattens with distance.
//
// HOLE_OFF is the cut when the hole layer is LOD'd away entirely - above the
// layer's own maximum, so distant foam is solid rather than dissolving into
// dots. HOLE_BASE/HOLE_GAIN map the age-and-centreline hole drive onto the cut:
// fresh outer foam lands near 0.89 (a scatter of bites) and old centreline foam
// near 0.41 (more hole than foam).
const float HOLE_OFF  = 1.30;
const float HOLE_BASE = 0.78;
const float HOLE_GAIN = 0.26;

// How far to probe for the shaded side, in metres, on a sun-facing and on a
// down-sun facet of the swell. This is the width of the down-sun band, so it is
// specified in world space and honestly shrinks with distance rather than being
// locked to a screen width.
//
// This is one of the two numbers that decide whether the foam has form or is
// torn paper. At 0.085 m against a 0.8-1.5 m island the shade tone was a rim
// about a twentieth of the shape wide - at chase-camera distance a handful of
// pixels down one side of a mass filling a quarter of the frame, which is to say
// invisible, and the wake correctly read as a single flat value. At 0.30 m the
// probe lands outside the blob across roughly a third of a typical island, so
// every silhouette gets a lit side and a shadow side with one hard boundary
// between them - a drawn shadow shape, not a shading term.
//
// A rim is a fixed width in metres, though, and the near wake is one merged mass
// many metres across on which even 0.30 m is a sliver. The mid-scale form comes
// from FOAM_FORM_M and the large-scale form from the swell - see main().
//
// 0.55 m against a 0.8-1.5 m island is a shadow that is a third to a half of
// the shape wide, which is a drawn shadow rather than a hairline. It is probed
// with the PRIMARY octave only: the lace and teeth layers exist to scallop the
// silhouette, and carrying them into the shade probe made the shadow's own edge
// a second copy of the silhouette's serrations a few centimetres away, which
// read as a fringe rather than as an edge.
const float SHADE_M = 0.40;
// Bias on the 0.78 m directional difference, whose standard deviation at a
// 0.40 m lag is 0.1345 (measured over 300k samples of this exact hash). +0.06
// therefore leaves 68% of the foam lit and puts the remaining 32% on the
// down-sun flanks - a drawn shadow on every island, at every age, everywhere
// in the frame.
const float RIM_BIAS = 0.06;

// -- thresholds ---------------------------------------------------------------
// A fresh wake keeps a bit over half the field, an exhausted one keeps nothing:
// T_SPENT sits above the field's own maximum on purpose, so the tail is
// guaranteed to erode to bare water rather than thinning to a permanent haze.
// T_FRESH went up from 0.22. At 0.22 the field keeps almost two thirds of its
// range straight off the transom, so the near wake in the chase frame came out
// as one unbroken white plate with a ruled edge - the "ice sheet" note. At 0.28
// the fresh mass is still solid but the silhouette is cut close enough to the
// field's own structure that its outline is drawn rather than geometric.
const float T_FRESH = 0.28;
const float T_SPENT = 0.96;

// How much further the threshold climbs at the ribbon's outer lips. Without it
// the wake would end in two dead-straight ruled lines - the geometry's edges.
// With it the silhouette is cut by the blob field and comes out scalloped, and
// the outermost foam breaks into separate clumps.
const float EDGE_BITE = 0.50;

// Width of the drawn contour, in *fragments*. The aa term below is one
// fragment's worth of the field, so scaling the inner cut by it locks the line
// to a fixed screen width - the same couple of pixels under the bow and two
// hundred metres astern.
//
// 1.5 was a single retina fragment: on the delivered 2560-wide frame it was
// there in the file and gone on screen, so the foam met the water with no line
// at all and sat on the surface like a cut-out. 3.0 is a line you can see at
// presentation size without being wide enough to swallow a small island whole.
const float INK_PX = 3.0;

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

/**
 * The silhouette-deciding octave on its own, in the same units as
 * wbFoamField(). The lace and teeth terms are zero-mean, so this is the same
 * signal with its boundary serrations removed - which is exactly what the shade
 * probe wants, and it costs one hash pair instead of three.
 */
float wbFoamBase(vec2 q, vec2 sc) {
  return wbVal(q / FOAM_BLOB_M + vec2(sc.x, 0.0), NOISE_PERIOD) * 0.74;
}

void main() {
  float edge = abs(vSide);
  vec2 q = vWorldXZ;
  vec2 sc = uScroll * NOISE_PERIOD;

  // Metres of world covered by one pixel here. Everything finer than this is
  // faded out rather than left to alias into stipple.
  //
  // The fade window is specified as "this layer's feature is 16 px" to "this
  // layer's feature is 8 px", i.e. M/fp between 16 and 8. The previous window
  // was M*0.30 to M*0.95, which is a feature 3.3 px wide down to 1.05 px: the
  // teeth layer at 0.145 m therefore drew from the camera out to about 230 m,
  // and 1-3 px scallops on a grazing wake are not drawing, they are aliasing -
  // the ruled diagonal static reported on the low-water frame. Under this rule
  // teeth die by ~30 m, lace by ~68 m and holes by ~108 m, so every layer stops
  // while its features are still unmistakably shapes.
  float fp = max(fwidth(q.x), fwidth(q.y));
  float lace    = 1.0 - smoothstep(FOAM_LACE_M  * 0.0625, FOAM_LACE_M  * 0.125, fp);
  float teeth   = 1.0 - smoothstep(FOAM_TEETH_M * 0.0625, FOAM_TEETH_M * 0.125, fp);
  float holeLod = 1.0 - smoothstep(FOAM_HOLE_M  * 0.0625, FOAM_HOLE_M  * 0.125, fp);
  // The cross-wake arc pattern has a 4.65 m period and is the coarsest of the
  // detail terms, so it survives furthest - but it is also the one that reads
  // as ruled stripes when it goes sub-pixel across a grazing ribbon.
  float arcLod  = 1.0 - smoothstep(4.65 * 0.0625, 4.65 * 0.125, fp);

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
  // A constant term so a fresh mass is not a featureless plate - at three metres
  // from a chase camera one 0.78 m blob covers most of the lower frame, and the
  // round-1 review called exactly that an ice sheet. It went 0.22 -> 0.30 with
  // T_FRESH, because the chase frame's near wake was still a plate.
  float holeAge = 0.30 + 1.00 * smoothstep(0.14, 0.80, vAge);
  // Holes are now driven as a CUT on the hole layer rather than as a
  // variable-depth subtraction from the silhouette field. Same erosion, but the
  // rim of a hole becomes an iso-line of one signal, so a single signed
  // distance below can cut the alpha and the contour from the same place. When
  // holeLod reaches zero the cut goes above the layer's maximum and distant
  // foam is solid rather than dissolving into a dot screen.
  float holeCut = mix(HOLE_OFF, HOLE_BASE - HOLE_GAIN * holeAge * (0.62 + 0.60 * centre), holeLod);

  // Cross-wake arcs at the hull's own oscillation scale, so the ribbon carries
  // visible transverse structure instead of one continuous density. Faded with
  // distance for the same reason as the noise layers: at a grazing angle its
  // 4.65 m period collapses under a pixel and draws as ruled stripes.
  float arcs = sin(vArc * 1.35 + edge * 2.6) * arcLod;

  float thresh = mix(T_FRESH, T_SPENT, vAge * vAge)
               + EDGE_BITE * edge * edge                      // scalloped silhouette
               + centre * 0.46 * smoothstep(0.18, 0.78, vAge) // hollows out with age
               - centre * 0.34 * propWash                     // hard core off the transom
               - propWash * 0.12                              // ... solid right across it
               - shoulder * 0.24                              // dense Kelvin arms
               + arcs * 0.035 * (1.0 - vAge);

  // Weak wakes (idling, coasting) should thin out, not just get transparent.
  thresh += (1.0 - vStrength) * 0.24;

  // The swell the ribbon is lying on. jac < 1 means the surface is pinching, so
  // foam bunches on the up-face of a crest and thins in a trough - the wake
  // visibly climbing a swell is most of what makes it read as material sitting
  // on moving water rather than a decal painted across it.
  float crest = 1.0 - smoothstep(0.88, 1.06, vJac);
  thresh -= crest * 0.18;
  thresh += (1.0 - crest) * 0.06;

  // --- one signed distance, in pixels, for BOTH the alpha and the contour ----
  //
  // This is the fix for the single most visible defect in the delivered frames:
  // the alpha used to be cut from (base - holes) while the ink was cut from
  // the base field alone. Wherever a silhouette edge was produced by a hole -
  // which is most of the eroding tail and all of the interior - base was above
  // threshold, the inner mask evaluated to 1, and no line was drawn at all. At
  // 1:1 the near wake was a pale slab with hard-edged navy holes punched
  // through it and not one pixel of contour between the two, which is why the
  // mass read as cut paper lying on the water instead of as foam in it.
  //
  // Both cuts now come off the same quantity: the pixel-space distance to the
  // nearest boundary, whichever kind it is. dOuter is how many pixels inside
  // the silhouette this fragment is; dHole is how many pixels outside the
  // nearest hole. Their min is the distance to the drawn edge, so the contour
  // follows every foam/water boundary in the frame by construction.
  //
  // The clip-art-bubble failure this used to guard against is handled instead
  // by the two constraints that actually cause it: holes stay at FOAM_HOLE_M =
  // 0.52 m and are killed outright below an 8 px feature, so a hole is never a
  // small round dot with a ring round it.
  float dOuter = (base - thresh) / aa;
  float dHole  = (holeCut - hole) / haa;
  float d      = min(dOuter, dHole);

  float mOuter = clamp(d + 0.5, 0.0, 1.0);
  float mInner = clamp(d - INK_PX + 0.5, 0.0, 1.0);

  // The ocean's own lit/unlit split, taken from the wave normal at this spine
  // point, so the ribbon steps exactly where the water under it does. The normal
  // is re-solved on the CPU every frame in the same sampleSurface() call that
  // seats the vertex, so this boundary rides the swell live.
  //
  // The reference is the value a FLAT surface returns - uSunDir.y - and not
  // zero. That was the bug that removed the swell shading entirely: with the sun
  // 43 degrees up, still water already returns 0.68 and the steepest face this
  // sea state can build still returns about 0.22, so step(0.10, ...) evaluated
  // to 1 for every fragment of every wake in the game and SHADE_DARK_M never
  // once applied. Referenced to the flat value and biased a little under it, the
  // terminator falls a couple of degrees below dead flat: sun-facing faces stay
  // lit, the back of every swell flips to the shade tone, and the ribbon bands
  // light/dark along its length as it climbs each crest. The sea state's RMS
  // slope is about ten degrees, so this splits the wake roughly 60/40 - a real
  // light side and a real dark side, not an occasional shaded sliver.
  //
  // This is the LARGE-scale form, and it is the half a fixed-width rim cannot
  // supply: the near wake is one merged mass many metres across, so a 0.30 m rim
  // is a sliver on it, whereas a whole segment lying on the back of a swell
  // draws in the shade tone with a hard line across the ribbon where the water
  // turns away. Because the normal is re-solved per spine point per frame, that
  // banding travels along the trail as the swell moves under it.
  // The bias moved from 0.96 to 0.93. At 0.96 the terminator sat high enough
  // that 41% of the sea surface was on the dark side of it, and because one
  // swell band is 13-39 m across, a whole visible ribbon lands inside one band:
  // the measured result was 67% of the ribbon's foam area drawn in the shade
  // tone as a single unbroken region. 0.93 puts roughly 30% of the sea in
  // shade, which keeps the band as the LARGEST of three nested scales instead
  // of swamping the two below it.
  float waveLit = step(uSunDir.y * 0.93, dot(normalize(vWaveN), uSunDir));

  vec2 sunXZ = normalize(uSunDir.xz + vec2(1e-5, 1e-5));

  // The MID-scale form, and the term this file was missing. A wake is not a
  // collection of separate islands at chase distance - it is one merged mass
  // several metres across, and a mass with no structure between the 0.5 m rim
  // and the 20 m swell band draws as a plate at either the light or the dark
  // value. This probes a 2.6 m octave as a directional difference along the sun
  // vector: where the coarse field rises toward the sun the fragment is on a
  // sun-facing flank and stays lit, where it falls the fragment is on the
  // down-sun flank of the same lump and steps to the shade tone. The boundary
  // is a hard step on a smooth signal, so it is a drawn shadow edge running
  // across the mass, not a gradient.
  vec2 fq = q / FOAM_FORM_M;
  float formHere = wbVal(fq + vec2(sc.y * 0.35, sc.x * 0.35), NOISE_PERIOD);
  float formBack = wbVal(fq - sunXZ * (FORM_SHADE_M / FOAM_FORM_M)
                            + vec2(sc.y * 0.35, sc.x * 0.35), NOISE_PERIOD);
  float formLit = step(formBack, formHere + FORM_BIAS - (1.0 - waveLit) * FORM_SWELL);

  // The SMALL-scale form: the down-sun flank of each drawn silhouette, at the
  // same 0.78 m scale that decides the silhouette itself.
  //
  // This is a directional difference on the primary octave, NOT the old
  // "is the probe still inside the mass" test, and the difference is the
  // reason the near wake used to be a plate. That test compared the down-sun
  // probe against thresh - the *erosion* threshold - and thresh carries the
  // prop-wash terms, which subtract 0.46 straight off the transom. On fresh
  // centreline foam thresh goes to about -0.15, below the field's own floor,
  // so the probe passed everywhere and the rim shade evaluated to fully lit
  // across the entire near wake: measured 4.1% shade over the chase frame's
  // near-wake rect while the same shader measured 43% over the mid-distance
  // ribbon. A shading term must not be coupled to an erosion threshold.
  //
  // Differencing instead is threshold-free by construction: it asks whether
  // this patch of foam rises or falls toward the sun, so every blob gets a lit
  // half and a shaded half with one hard line between them, on fresh foam and
  // on spent foam alike.
  float hereB = wbFoamBase(q, sc);
  float awayB = wbFoamBase(q - sunXZ * SHADE_M, sc);
  float rimLit = step(awayB, hereB + RIM_BIAS);

  // Opacity holds at one for the first 86% of the ribbon's life and is gone by
  // the end of it - a shade under four seconds at WAKE_LIFE. By the time it
  // starts to move the erosion above has already reduced the tail to a scatter
  // of small islands, so nothing large ever draws at a partial alpha and the
  // foam never blends with the water into a pale wash.
  float alpha = mOuter * uOpacity * (1.0 - smoothstep(0.86, 1.0, vAge));
  if (alpha < 0.004) discard;

  // Two tones and a drawn contour. Nothing else: PALETTE.foam is the lit side,
  // PALETTE.foamShade is the down-sun side, every boundary between them is one
  // hard step, and there is no gradient anywhere.
  //
  // Two mechanisms, not three, and they are at different scales on purpose: the
  // 0.55 m rim on each drawn silhouette, and the 2.6 m form band whose own
  // threshold the swell drives (see FORM_SWELL). Multiplying two terms lands
  // the shaded fraction where a drawn cel mass wants it; the previous code
  // multiplied a rim against a swell band, which is two terms neither of which
  // was at the size of the drawn shape, and measured 67% shade in one flat
  // region.
  vec3 col = uFoamColor;
  col = mix(uFoamShade, col, rimLit * formLit);
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
// They came back in, to 0.70 / 0.86. At 0.90 / 0.96 the contour was 4% of the
// radius: on a 20 px droplet that is 0.4 px, so the whole particle drew as a
// featureless white chip. That is invisible over water only in the sense that
// it is not invisible - over the WAKE RIBBON, which is where essentially every
// droplet is, a white chip on white foam disappears completely, and it is why
// the delivered frames read as having no spray at all even with the pool
// running (measured: 94 live droplets in the chase frame and not one of them
// legible). A drawn white object on a white ground needs a line, so the outer
// 14% of the radius is now that line and the 16% inside it is the cool tone. On
// a 20 px droplet that is a 1.4 px contour, and on a 6 px one it falls under a
// fragment and the droplet correctly resolves to a solid chip again.
const float R_CORE = 0.70;
const float R_BODY = 0.86;

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
  // 0.42 -> 0.72 toward the contour tone. A droplet's line has to survive being
  // drawn over foam white, and at 0.42 it was a pale blue-grey that read as part
  // of the foam it was sitting on.
  col = mix(col, mix(uFoamShade, uFoamEdge, 0.72), step(R_BODY, vRadial));
  col *= vTint;

  gColor = vec4(col, alpha);
  // edgeMask = 0: spray carries its own silhouette, and this keeps attachment 1
  // untouched so the Sobel pass does not scribble a border round every droplet.
  wbWriteGBuffer(normalize(vViewNormal), vViewDepth, 0.0);
}
`;
