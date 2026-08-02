import { GBUFFER_OUT, OCT_PACK, GBUFFER_WRITE } from '../../render/shaders/celChunks';

/**
 * GLSL for the whitewater: the persistent wake ribbons and the spray particles.
 *
 * Three ideas run through this file.
 *
 *  1. **Foam is a threshold, never a gradient.** Both shaders take a continuous
 *     signal (the foam alphabet for the ribbon, a radial coordinate for the
 *     particles) and cut it into flat regions with a hard step. Nothing here is
 *     allowed to produce a soft edge, because a soft-edged white smear is
 *     exactly what "stylised water" is trying not to be. The one place softness
 *     is permitted is the ~1 fragment of anti-aliasing on the cut itself, which
 *     stops the shape crawling under camera motion with MSAA off.
 *
 *  2. **Dissipation is erosion, not opacity.** A wake does not get transparent -
 *     it breaks up. The ribbon therefore *raises* its threshold with age, so
 *     foam islands shrink and separate and eventually vanish, and only applies a
 *     genuine alpha fade over the last quarter of the lifetime so the tail can
 *     leave without a pop. The two together read as foam dispersing.
 *
 *  3. **The G-buffer contract, under blending.** Both materials blend with
 *     SRC_ALPHA / ONE_MINUS_SRC_ALPHA, and WebGL runs that same equation on
 *     *every* colour attachment using each attachment's own alpha as the source
 *     factor. Attachment 1's alpha is `edgeMask`. Writing `edgeMask = 0` here is
 *     therefore not a hint - it provably leaves the normal/depth buffer
 *     bit-identical, so the Sobel pass inks the boat and the water underneath
 *     the foam exactly as if the foam were not there. Foam has no ink line of
 *     its own; its silhouette *is* the drawing.
 */

// ------------------------------------------------------------- shared --------

/**
 * A threshold with exactly one fragment of transition, independent of how flat
 * the source signal has become.
 *
 * The naive `smoothstep(T - w, T + w, v)` with a constant `w` fails at distance:
 * the foam texture is mip-mapped (it has to be, or it aliases into static), and
 * a distant tap averages toward mid-grey, so a fixed-width step turns a crisp
 * island into a wide grey halo. Dividing by the screen-space derivative of the
 * signal instead normalises the cut into pixel space - the boundary is one
 * pixel wide at 3 m and at 300 m, which is what keeps foam reading as drawn
 * shapes all the way to the horizon.
 */
const CRISP_STEP = /* glsl */ `
float wbCrisp(float v, float thresh, float aa) {
  return clamp((v - thresh) / aa + 0.5, 0.0, 1.0);
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

// Metres of ribbon per tile of the foam alphabet. x runs across the ribbon,
// y along it. Driving the texture from *metres* rather than from a normalised
// 0..1 span is the whole trick behind the spread: as the ribbon widens from one
// beam to four, foam cells keep their world size and more of them fit across,
// instead of a fixed pattern stretching into taffy.
uniform vec2 uTile;

out vec2  vFoamUv;
out float vSide;
out float vAge;
out float vStrength;
out float vViewDepth;
out vec3  vViewNormal;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * world;
  vViewDepth = -mv.z;
  gl_Position = projectionMatrix * mv;

  // Lateral offset in metres / tile size. aData.w is the *current* half-width,
  // so this is the true world offset of this lip, not a parametric edge.
  vFoamUv = vec2((aSide * aData.w) / uTile.x, aData.x / uTile.y);

  vSide     = aSide;
  vAge      = aData.y;
  vStrength = aData.z;

  // The ribbon lies on the water, so its normal is up. The value only matters
  // for completeness: edgeMask is 0, which zeroes this attachment's blend
  // contribution entirely.
  vViewNormal = normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0));
}
`;

export const WAKE_FRAG = /* glsl */ `
precision highp float;
${GBUFFER_OUT}
${OCT_PACK}
${GBUFFER_WRITE}
${CRISP_STEP}

uniform sampler2D uFoam;
uniform vec3  uFoamColor;
uniform vec3  uFoamShade;
uniform vec2  uScroll;     // two independent wrapped 0..1 offsets, one per layer
uniform float uOpacity;

in vec2  vFoamUv;
in float vSide;
in float vAge;
in float vStrength;
in float vViewDepth;
in vec3  vViewNormal;

// -- thresholds ---------------------------------------------------------------
// A fresh wake keeps roughly 60% of the alphabet (T = 0.30 against a tile whose
// coverage is a little over half), an exhausted one keeps almost none. The
// travel between them is the dissipation: islands shrink from their edges
// inward and break apart, which is how foam actually dies.
const float T_FRESH = 0.30;
const float T_SPENT = 0.86;

// How much further the threshold climbs at the ribbon's outer lips. Without it
// the wake would end in two dead-straight ruled lines - the geometry's edges.
// With it the silhouette is cut by the foam alphabet and comes out ragged.
const float EDGE_BITE = 0.30;

// Width of the shaded rim, in *fragments*, not in threshold units.
//
// The aa term below is one fragment's worth of the foam signal, so scaling the
// inner cut's offset by it locks the band to a fixed screen width - the same crisp
// couple of pixels under the bow and two hundred metres astern. Specifying a
// constant offset instead (the obvious thing) makes the band's width inversely
// proportional to the local gradient, and on a ribbon lying almost edge-on to
// the camera - which is most of a wake, most of the time - the gradient
// collapses and the shade tone swallows the whole island. The foam turns
// uniformly pale blue and every island loses its body.
const float RIM_PX = 1.7;

// The hot core, by contrast, is genuinely a *value* threshold: it marks where
// the foam signal is strong, i.e. where the whitewater is thick, so it should
// grow and shrink with the foam rather than hug its outline. PALETTE.foam
// already sits above the post stack's 0.85 bloom threshold, so this reads as
// the densest foam catching the sun.
const float CORE = 0.30;

void main() {
  float edge = abs(vSide);

  // Two layers of the same alphabet at different scales and drift rates. The
  // v-scales are integers on purpose: the CPU periodically rebases arc length by
  // an exact multiple of uTile.y to keep float precision bounded, which shifts
  // vFoamUv.y by a whole number of tiles - seamless under RepeatWrapping only if
  // every layer's v multiplier is also whole.
  // The second layer is deliberately only 2x, not 3x or 4x. The alphabet's
  // islands are 0.2-0.6 m at this tile size; a 3x layer shrinks them to 7-20 cm,
  // which at any normal viewing distance is a few pixels across and turns the
  // wake into speckle. Foam should break into *chips*, not into static.
  float n0 = texture(uFoam, vec2(vFoamUv.x,                vFoamUv.y       + uScroll.x)).r;
  float n1 = texture(uFoam, vec2(vFoamUv.x * -1.73 + 0.31, vFoamUv.y * 2.0 + uScroll.y)).r;
  float n  = n0 * 0.72 + n1 * 0.36;

  // --- wake structure --------------------------------------------------------
  // A real wake is not a uniform strip. Directly behind the hull the water is
  // churned but the prop wash carves a channel down the middle, and the two
  // shoulders where the Kelvin arms sit carry the densest foam. Both features
  // are strongest when the wake is young and close up as it ages.
  float openness = 1.0 - smoothstep(0.16, 0.62, vAge);
  float shoulder = 1.0 - smoothstep(0.08, 0.60, abs(edge - 0.74));
  float channel  = 1.0 - smoothstep(0.0,  0.34, edge);

  float thresh = mix(T_FRESH, T_SPENT, vAge)
               + EDGE_BITE * edge * edge          // ragged outer silhouette
               + channel * 0.22 * openness        // prop-wash channel
               - shoulder * 0.20 * openness;      // dense Kelvin shoulders

  // Weak wakes (idling, coasting) should thin out, not just get transparent.
  thresh += (1.0 - vStrength) * 0.26;

  float aa = max(fwidth(n) * 1.25, 1e-4);
  float mOuter = wbCrisp(n, thresh,             aa);
  float mInner = wbCrisp(n, thresh + aa * RIM_PX, aa);
  float mCore  = wbCrisp(n, thresh + CORE,      aa);

  // Alpha only fades over the last quarter of the life. Everything before that
  // is pure erosion - and the tail point is always at age 1, so the ribbon's
  // trailing end is guaranteed to reach zero rather than being cut off.
  float tailFade = 1.0 - smoothstep(0.74, 1.0, vAge);
  float alpha = mOuter * tailFade * uOpacity * (0.45 + 0.55 * vStrength);
  if (alpha < 0.004) discard;

  // Three flat tones, no gradient between them: shaded rim, foam body, hot core.
  vec3 col = uFoamShade;
  col = mix(col, uFoamColor, mInner);
  col += uFoamColor * mCore * 0.16;

  gColor = vec4(col, alpha);
  // edgeMask = 0 - see the note at the top of this file. The Sobel pass keeps
  // inking the hull and the swell straight through the foam.
  wbWriteGBuffer(normalize(vViewNormal), vViewDepth, 0.0);
}
`;

// ------------------------------------------------------------- spray ---------

export const SPRAY_VERT = /* glsl */ `
in float aRadial;   // 0 at the blob's centre, 1 at its rim - drives the tone rings
in vec3  aOffset;   // instance: world centre
in vec4  aParams;   // instance: x half-width (m), y half-height (m), z rotation (rad), w alpha
in vec3  aTint;     // instance: multiplier on the foam colour, near-white

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
  // below flattens the particle against the *water*, which is the whole point
  // of the impact splat.
  vec2 flat2 = cameraPosition.xz - centre.xz;
  float l = length(flat2);
  vec2 f = l > 1e-4 ? flat2 / l : vec2(0.0, 1.0);
  vec3 right = vec3(f.y, 0.0, -f.x);          // == cross(worldUp, fwd)

  // Rotate in card space first, scale second: the non-uniform scale is applied
  // on the world axes, so a spinning particle still splats flat.
  float c = cos(aParams.z);
  float s = sin(aParams.z);
  vec2 p = vec2(position.x * c - position.y * s,
                position.x * s + position.y * c) * aParams.xy;

  vec3 world = centre + right * p.x + vec3(0.0, p.y, 0.0);

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
uniform float uOpacity;

in float vRadial;
in float vAlpha;
in vec3  vTint;
in float vViewDepth;
in vec3  vViewNormal;

// Tone ring boundaries. These are placed on the *geometry's* ring radii (see
// makeSprayBlob in FoamSystem.ts), so the steps land exactly on triangle edges
// and come out perfectly clean rather than wobbling through interpolation.
const float R_CORE = 0.42;
const float R_BODY = 0.84;

void main() {
  float alpha = vAlpha * uOpacity;
  if (alpha < 0.008) discard;

  // Three flat tones. No falloff, no soft rim, no gaussian anything: a drawn
  // droplet is a white shape with a shaded edge and a hot centre.
  vec3 col = uFoamShade;
  col = mix(col, uFoamColor, 1.0 - step(R_BODY, vRadial));
  col += uFoamColor * (1.0 - step(R_CORE, vRadial)) * 0.20;
  col *= vTint;

  gColor = vec4(col, alpha);
  // edgeMask = 0: spray carries its own silhouette, and this keeps attachment 1
  // untouched so the Sobel pass does not scribble a border round every droplet.
  wbWriteGBuffer(normalize(vViewNormal), vViewDepth, 0.0);
}
`;
