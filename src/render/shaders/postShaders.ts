import { OCT_PACK, DITHER } from './celChunks';

/**
 * GLSL for the post stack (see `render/Composer.ts`).
 *
 * Three passes live here:
 *
 *   BRIGHT_FRAG     full-res scene colour -> half-res thresholded highlights
 *   BLUR_FRAG       separable blur, run once horizontally and once vertically
 *   COMPOSITE_FRAG  scene + G-buffer + bloom -> the screen, with the interior
 *                   ink pass, the quantised glow and the final grade
 *
 * ---------------------------------------------------------------------------
 * A NOTE ON THE MRT CONTRACT
 *
 * Every shader that *fills* the G-buffer declares two outputs (celChunks.ts,
 * `GBUFFER_OUT`) because the scene target has two colour attachments and an
 * unwritten attachment 1 leaves garbage for the Sobel to trip over.
 *
 * These passes are the other side of that contract: they *consume* the
 * G-buffer and resolve into single-attachment framebuffers (the half-res bloom
 * targets and the default framebuffer). Declaring a `location = 1` output there
 * binds it to nothing - at best a silently discarded write, at worst a driver
 * complaint - so each pass below declares exactly the one attachment it has.
 * ---------------------------------------------------------------------------
 */

/**
 * Fullscreen *triangle*, not a quad. One primitive, no diagonal seam, and the
 * GPU never rasterises the same quad-helper twice along a shared edge. The
 * vertex positions are already in NDC so no matrix is touched.
 */
export const FULLSCREEN_VERT = /* glsl */ `
out vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Shared helpers: Rec.709 luma and the manual sRGB encode. */
const POST_COMMON = /* glsl */ `
const vec3 WB_LUMA = vec3(0.2126, 0.7152, 0.0722);

float wbLuma(vec3 c) { return dot(c, WB_LUMA); }

/**
 * Linear -> sRGB. Done by hand because a raw GLSL3 ShaderMaterial does not get
 * three's <colorspace_fragment> chunk injected; nothing else in the chain
 * encodes, so if this is missing the whole game renders washed out.
 */
vec3 wbLinearToSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
`;

// ---------------------------------------------------------------- bright ----

/**
 * Bright pass + 2x downsample in one draw.
 *
 * The scene target is NearestFilter on purpose (bilinear-smearing a cel image
 * before the edge pass reads it would soften exactly the hard steps the art
 * depends on), so this does its own 2x2 box by placing four taps a half
 * full-res texel either side of the half-res texel centre - which lands them
 * precisely on the four source texel centres.
 *
 * Thresholding happens per tap, *before* the box average. Averaging first would
 * let three dim texels drag a hot one under the threshold and make the glow
 * flicker as geometry crawls across the pixel grid.
 */
export const BRIGHT_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 gColor;

in vec2 vUv;
uniform sampler2D uScene;
uniform vec2  uTexel;      // 1 / full-res scene size
uniform float uThreshold;  // luma above which a pixel is allowed to glow

${POST_COMMON}

vec3 wbBrightTap(vec2 tapUv) {
  vec3 c = texture(uScene, tapUv).rgb;
  float l = wbLuma(c);
  // Soft-knee-free subtractive threshold: keeps the source hue exactly and
  // returns zero below the cut, so nothing but genuinely hot pixels contributes.
  return c * (max(l - uThreshold, 0.0) / max(l, 1e-4));
}

void main() {
  vec2 o = uTexel * 0.5;
  vec3 sum = wbBrightTap(vUv + vec2(-o.x, -o.y))
           + wbBrightTap(vUv + vec2( o.x, -o.y))
           + wbBrightTap(vUv + vec2(-o.x,  o.y))
           + wbBrightTap(vUv + vec2( o.x,  o.y));
  gColor = vec4(sum * 0.25, 1.0);
}
`;

// ------------------------------------------------------------------ blur ----

/**
 * Separable blur, seven taps per axis using hardware bilinear pairs.
 *
 * The offsets are deliberately wider than a textbook gaussian (1.8 / 4.0 / 6.6
 * half-res texels rather than 1.4 / 3.2) because the result is quantised into
 * plateaus downstream - a broad, slightly boxy kernel gives fatter, more
 * *drawn* glow shapes, and the plateau step throws away the extra smoothness a
 * tighter kernel would have bought. Support is +-6.6 half-res texels per axis,
 * i.e. about +-13 full-res pixels, which is a readable halo around the sun
 * without turning into a photographic bloom.
 *
 * Weights are normalised to exactly 1.0 so two passes cannot brighten or dim
 * the image; only the shape changes.
 */
export const BLUR_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 gColor;

in vec2 vUv;
uniform sampler2D uSource;
/** One texel along the blur axis, pre-multiplied by the radius scale. */
uniform vec2 uDirection;

void main() {
  const float W0 = 0.2443, W1 = 0.2094, W2 = 0.1163, W3 = 0.0522;
  const float O1 = 1.8, O2 = 4.0, O3 = 6.6;

  vec3 c = texture(uSource, vUv).rgb * W0;
  c += (texture(uSource, vUv + uDirection * O1).rgb +
        texture(uSource, vUv - uDirection * O1).rgb) * W1;
  c += (texture(uSource, vUv + uDirection * O2).rgb +
        texture(uSource, vUv - uDirection * O2).rgb) * W2;
  c += (texture(uSource, vUv + uDirection * O3).rgb +
        texture(uSource, vUv - uDirection * O3).rgb) * W3;

  gColor = vec4(c, 1.0);
}
`;

// ------------------------------------------------------------- composite ----

/**
 * The one pass that touches the screen: interior ink, quantised glow, grade.
 *
 * INTERIOR INK. This is the screen-space half of a two-part line system. The
 * inverted-hull shells in `OutlineHull.ts` own silhouettes; this Sobel owns
 * everything *inside* a silhouette - panel breaks, creases, where a rider's arm
 * crosses their chest. The two must never draw the same line twice, which is
 * what `edgeMask` in G-buffer attachment 1 is for: a shell writes 0, the ocean
 * writes something low, a hull writes 1.
 *
 * DEPTH EDGES are normalised by the centre depth before thresholding. Without
 * that, the absolute depth gradient across a hull seam is a hundred times
 * larger at 200 m than at 5 m and any single threshold either scribbles on
 * close geometry or loses distant geometry entirely. Dividing by the centre
 * depth turns the test into "does the surface step by more than N% of its own
 * distance", which is scale-free and is why a line holds its weight down the
 * length of a straight.
 *
 * Depth edges are additionally weighted by how face-on the surface is. A plane
 * seen at 85 degrees has a huge depth gradient purely from perspective, so
 * without a grazing reject every glancing surface - and above all the ocean
 * running out to the horizon - grows an outline it never earned.
 *
 * NORMAL EDGES compare opposite taps rather than centre-vs-neighbour, so a
 * crease is found symmetrically and does not smear one texel to the lit side.
 */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 gColor;

in vec2 vUv;

uniform sampler2D uScene;        // G-buffer attachment 0: linear HDR colour
uniform sampler2D uNormalDepth;  // attachment 1: vec4(octN.xy, depth01, edgeMask)
uniform sampler2D uBloom;        // half-res blurred highlights

uniform vec2  uTexel;            // 1 / full-res size
uniform float uEdgeRadius;       // Sobel tap radius in texels, resolution-scaled
uniform float uDepthThreshold;
uniform float uNormalThreshold;
uniform float uEdgeStrength;     // 0 disables the whole edge block

uniform vec3  uInk;
uniform float uInkDarken;
uniform float uInkTint;

uniform float uBloomStrength;    // 0 disables the bloom add

uniform float uSaturation;
uniform float uVignette;
uniform float uAspect;
uniform float uTanHalfFov;

${POST_COMMON}
${OCT_PACK}
${DITHER}

void main() {
  vec3 col = texture(uScene, vUv).rgb;

  // ---------------------------------------------------------------- ink ----
  // Branch is on a uniform, so control flow stays uniform across the draw and
  // the fwidth() below remains well defined.
  if (uEdgeStrength > 0.0) {
    vec2 o = uTexel * uEdgeRadius;

    // 3x3 neighbourhood, row-major from top-left. One fetch per texel; both the
    // depth Sobel and the normal comparison read out of these nine.
    vec4 g0 = texture(uNormalDepth, vUv + vec2(-o.x,  o.y));
    vec4 g1 = texture(uNormalDepth, vUv + vec2( 0.0,  o.y));
    vec4 g2 = texture(uNormalDepth, vUv + vec2( o.x,  o.y));
    vec4 g3 = texture(uNormalDepth, vUv + vec2(-o.x,  0.0));
    vec4 g4 = texture(uNormalDepth, vUv);
    vec4 g5 = texture(uNormalDepth, vUv + vec2( o.x,  0.0));
    vec4 g6 = texture(uNormalDepth, vUv + vec2(-o.x, -o.y));
    vec4 g7 = texture(uNormalDepth, vUv + vec2( 0.0, -o.y));
    vec4 g8 = texture(uNormalDepth, vUv + vec2( o.x, -o.y));

    // --- depth ------------------------------------------------------------
    float sx = (g0.z + 2.0 * g3.z + g6.z) - (g2.z + 2.0 * g5.z + g8.z);
    float sy = (g0.z + 2.0 * g1.z + g2.z) - (g6.z + 2.0 * g7.z + g8.z);
    // Sobel magnitude scales with the tap spacing, so divide it back out: the
    // threshold then means the same thing at 1x as it does at retina.
    float dGrad = length(vec2(sx, sy)) / (max(g4.z, 1e-4) * uEdgeRadius);

    // View ray for this pixel, rebuilt from the projection. Only the direction
    // matters, so the depth itself is not needed here.
    vec3 ray = vec3((vUv * 2.0 - 1.0) * vec2(uTanHalfFov * uAspect, uTanHalfFov), -1.0);
    vec3 V = normalize(-ray);
    vec3 N = wbOctDecode(g4.xy);
    // abs() because a back-facing fragment (the ink shells write +Z) must not
    // read as "infinitely grazing" and flip the test on.
    float ndv = abs(dot(N, V));
    // Fully rejected below ~cos(80 deg), fully trusted above ~cos(65 deg).
    // Between those the perspective term starts to dominate the real geometry.
    float graze = smoothstep(0.17, 0.42, ndv);

    float dEdge = (dGrad / uDepthThreshold) * graze;

    // --- normals ----------------------------------------------------------
    // Opposite pairs: horizontal, vertical and both diagonals.
    vec3 n0 = wbOctDecode(g0.xy), n8 = wbOctDecode(g8.xy);
    vec3 n2 = wbOctDecode(g2.xy), n6 = wbOctDecode(g6.xy);
    vec3 n1 = wbOctDecode(g1.xy), n7 = wbOctDecode(g7.xy);
    vec3 n3 = wbOctDecode(g3.xy), n5 = wbOctDecode(g5.xy);
    float nDiff = max(
      max(1.0 - dot(n0, n8), 1.0 - dot(n2, n6)),
      max(1.0 - dot(n1, n7), 1.0 - dot(n3, n5))
    );
    float nEdge = nDiff / uNormalThreshold;

    // --- mask -------------------------------------------------------------
    // Centre mask is the surface's own opt-out. The neighbourhood minimum is
    // the anti-double-up: a texel sitting right against an inverted-hull shell
    // (mask 0) is by definition one texel from a line that already exists, and
    // drawing a second one there is exactly the fattened, muddy silhouette the
    // two-system split is meant to avoid.
    float minMask = min(
      min(min(g0.w, g1.w), min(g2.w, g3.w)),
      min(min(g5.w, g6.w), min(g7.w, g8.w))
    );
    float mask = g4.w * minMask;

    // --- resolve ----------------------------------------------------------
    // Both signals are normalised so 1.0 *is* the threshold; the soft edge is
    // 1.5 pixels wide, measured with fwidth on the signal itself, which is what
    // keeps the line's softness constant instead of scaling with resolution.
    float e = max(dEdge, nEdge);
    float aa = clamp(1.5 * fwidth(e), 0.02, 0.9);
    float line = smoothstep(1.0 - aa, 1.0 + aa, e) * mask * uEdgeStrength;

    // Ink is a MULTIPLY toward the ink hue, never an opaque stamp. A stamped
    // black line lands at the same value wherever it falls and flattens the
    // whole drawing; multiplying keeps each line tied to the value under it, so
    // a crease on a lit hull stays lighter than the same crease in shadow.
    vec3 inkTarget = mix(col * uInkDarken, uInk, uInkTint);
    col = mix(col, inkTarget, line);
  }

  // -------------------------------------------------------------- bloom ----
  if (uBloomStrength > 0.0) {
    vec3 b = texture(uBloom, vUv).rgb;
    float bl = wbLuma(b);
    // Three plateaus instead of a continuous falloff. A photographic bloom is a
    // smooth ramp; drawn glow is a couple of flat shapes stacked inside each
    // other, and stepping the response is what buys that read. The step edges
    // are narrow but non-zero so the plateau boundaries do not alias into
    // crawling rings on a slowly-moving highlight.
    float p = smoothstep(0.035, 0.055, bl) * 0.34
            + smoothstep(0.140, 0.175, bl) * 0.33
            + smoothstep(0.420, 0.480, bl) * 0.33;
    // Normalise to unit luma so the plateau controls the intensity and the
    // blurred colour only supplies hue - otherwise the brightest source would
    // both raise the plateau and multiply it, and the sun would nuke the frame.
    vec3 tint = b / max(bl, 1e-3);
    col += tint * p * uBloomStrength;
  }

  // -------------------------------------------------------------- grade ----
  // Saturation lift. Small: the palette is already committed, this just puts
  // back the bite that averaging pixels in the edge and bloom passes took out.
  float l = wbLuma(col);
  col = max(vec3(0.0), mix(vec3(l), col, uSaturation));

  // Vignette, barely there - enough to stop the corners competing with the
  // boat, not enough to read as a lens.
  vec2 vd = (vUv - 0.5) * vec2(uAspect, 1.0);
  float vr = length(vd) / (0.5 * sqrt(uAspect * uAspect + 1.0));
  col *= 1.0 - uVignette * smoothstep(0.55, 1.0, vr);

  // Shoulder. NOT a filmic curve: ACES and friends desaturate and lift blacks,
  // which is precisely wrong for flat cel colour. This only bends the top tenth
  // of the range, mapping [0.90, inf) into [0.90, 1.0], so every in-range flat
  // keeps its exact palette value and only emissives roll off instead of
  // clipping to a hard white shape with a chewed edge.
  const float SHOULDER = 0.90;
  vec3 over = max(col - SHOULDER, 0.0);
  col = min(col, vec3(SHOULDER)) + (1.0 - SHOULDER) * (over / (over + (1.0 - SHOULDER)));

  col = wbLinearToSRGB(col);
  // Dither in output space, immediately before the 8-bit write - one LSB of
  // ordered noise, which is what keeps the sky and the water's darkest band
  // from stair-stepping across a wide monitor.
  col += wbDither(gl_FragCoord.xy);

  gColor = vec4(col, 1.0);
}
`;
