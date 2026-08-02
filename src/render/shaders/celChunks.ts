/**
 * Shared GLSL used by every surface in the game.
 *
 * Two ideas live here:
 *
 *  1. The G-buffer contract. Every material renders into a two-attachment MRT:
 *     attachment 0 is colour, attachment 1 is `vec4(octNormal.xy, depth01, edgeMask)`.
 *     The Sobel pass reads attachment 1. `edgeMask` lets a surface opt out of
 *     interior lines - the ocean sets it low so the screen-space pass does not
 *     scribble over every wave, while hulls set it high so panel breaks get inked.
 *
 *  2. The cel lighting model. Ramp-quantised diffuse, hard-stepped specular,
 *     fresnel rim and a matcap standing in for the environment. No PBR terms,
 *     no roughness, no IBL.
 */

/** Declarations for the MRT outputs. Include once at the top of every fragment shader. */
export const GBUFFER_OUT = /* glsl */ `
layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gNormalDepth;
`;

/** Octahedral normal packing - two channels instead of three, no precision cost that matters here. */
export const OCT_PACK = /* glsl */ `
vec2 wbOctEncode(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z) + 1e-6);
  vec2 e = n.z >= 0.0 ? n.xy : (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return e * 0.5 + 0.5;
}
vec3 wbOctDecode(vec2 f) {
  f = f * 2.0 - 1.0;
  vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}
`;

/**
 * Writes the G-buffer's second attachment.
 * @param viewNormal unit normal in view space
 * @param viewDepth  positive distance along -Z in metres
 * @param edgeMask   0 = never draw interior lines here, 1 = full strength
 */
export const GBUFFER_WRITE = /* glsl */ `
uniform float uCameraFar;
void wbWriteGBuffer(vec3 viewNormal, float viewDepth, float edgeMask) {
  gNormalDepth = vec4(wbOctEncode(viewNormal), clamp(viewDepth / uCameraFar, 0.0, 1.0), edgeMask);
}
`;

/** The cel lighting core. */
export const CEL_LIGHTING = /* glsl */ `
uniform sampler2D uRamp;
uniform vec3  uSunDir;        // world space, normalised, points *toward* the sun
uniform vec3  uSunColor;
uniform vec3  uAmbient;
uniform vec3  uRimColor;
uniform float uRimPower;
uniform float uRimStrength;
uniform vec3  uSpecColor;
uniform float uSpecThreshold;
uniform float uSpecPower;
uniform float uSpecStrength;
uniform float uSpecSoftness;
uniform sampler2D uMatcap;
uniform float uMatcapStrength;
uniform float uWrap;          // light wrap: pushes the terminator around the form

/**
 * Ramp-quantised diffuse.
 *
 * `uWrap` widens the lit region before quantisation, which is what keeps the
 * dark band from swallowing the underside of a round hull. The ramp texture is
 * NearestFilter, so the output is genuinely stepped - there is no interpolation
 * anywhere in this path.
 */
vec3 wbCelDiffuse(vec3 albedo, vec3 N, vec3 L) {
  float ndl = dot(N, L);
  float t = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);
  vec4 ramp = texture(uRamp, vec2(t, 0.5));
  return albedo * ramp.rgb * uSunColor + albedo * uAmbient * (1.0 - ramp.a * 0.55);
}

/**
 * Banded specular: a hard-edged highlight shape. `uSpecSoftness` is deliberately
 * tiny - just enough to stop the edge aliasing into a staircase at 1x, never
 * enough to read as a falloff.
 */
vec3 wbCelSpecular(vec3 N, vec3 V, vec3 L) {
  vec3 H = normalize(L + V);
  float s = pow(max(dot(N, H), 0.0), uSpecPower);
  float hard = smoothstep(uSpecThreshold, uSpecThreshold + uSpecSoftness, s);
  // A second, smaller step gives the highlight a hot core - two-tone, like ink.
  float core = smoothstep(uSpecThreshold + 0.35, uSpecThreshold + 0.35 + uSpecSoftness, s);
  return uSpecColor * (hard * 0.72 + core * 0.6) * uSpecStrength;
}

/**
 * Fresnel rim. Biased toward the side away from the key light so it reads as a
 * backlight separating the silhouette from the water, which is the entire point.
 */
vec3 wbCelRim(vec3 N, vec3 V, vec3 L) {
  float f = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), uRimPower);
  float back = smoothstep(-0.45, 0.75, dot(-L, V) * 0.5 + dot(N, L) * 0.5);
  float rim = smoothstep(0.32, 0.46, f * (0.35 + 0.85 * back));
  return uRimColor * rim * uRimStrength;
}

/** Matcap lookup - the only "environment" in the game. */
vec3 wbMatcap(vec3 viewNormal) {
  vec2 uv = viewNormal.xy * 0.49 + 0.5;
  return texture(uMatcap, uv).rgb;
}
`;

/** Screen-space dither used to break 8-bit banding in the sky without adding noise texture. */
export const DITHER = /* glsl */ `
float wbDither(vec2 fragCoord) {
  // Ordered 4x4 Bayer, scaled to a single LSB. Invisible, but it stops the
  // sky gradient from stair-stepping on a wide monitor.
  const mat4 bayer = mat4(
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  ivec2 p = ivec2(mod(fragCoord, 4.0));
  return (bayer[p.x][p.y] / 16.0 - 0.5) / 255.0;
}
`;

/** Common vertex varyings + helper for the standard cel vertex path. */
export const CEL_VARYINGS = /* glsl */ `
out vec3 vWorldNormal;
out vec3 vViewNormal;
out vec3 vWorldPos;
out float vViewDepth;
out vec3 vColorMul;
`;

export const CEL_VARYINGS_FRAG = /* glsl */ `
in vec3 vWorldNormal;
in vec3 vViewNormal;
in vec3 vWorldPos;
in float vViewDepth;
in vec3 vColorMul;
`;
