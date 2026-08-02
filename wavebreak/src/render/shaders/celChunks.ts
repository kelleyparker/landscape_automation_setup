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
uniform vec3  uShadowFloor;   // legibility floor for the darkest band
uniform vec3  uRimColor;
uniform float uRimPower;
uniform float uRimStrength;
uniform float uRimThreshold;
uniform float uRimWidth;
uniform vec3  uSpecColor;
uniform float uSpecThreshold;
uniform float uSpecPower;
uniform float uSpecStrength;
uniform float uSpecSoftness;
uniform sampler2D uMatcap;
uniform float uMatcapStrength;
uniform float uWrap;          // light wrap: pushes the terminator around the form
uniform float uBandBias;      // slides the whole band set along the ramp

/**
 * Ramp decode scale. The ramp is an 8-bit texture but band light values run
 * past 1.0 on the hot step, so they are stored divided by this and multiplied
 * back here. Must stay identical to RAMP_SCALE in src/core/Textures.ts.
 */
const float WB_RAMP_SCALE = 1.6;
const vec3  WB_LUMA = vec3(0.30, 0.59, 0.11);

/**
 * Ramp-quantised diffuse with authored band colour.
 *
 * The previous version was a straight multiply: albedo * value. On a saturated
 * hull that is invisible - a colour with no green and no blue has nothing left
 * to darken, so every band clipped to the same orange and the hero asset read
 * as one flat fill. So each band now carries its own authored light colour and
 * a wash amount:
 *
 *   wash = 0  -> pure multiply, hue preserved, the object's identity colour
 *   wash = 1  -> the band's own colour laid over the albedo's brightness
 *
 * The shadow steps wash toward magenta-violet (sky bounce) and the top step
 * toward warm cream, so adjacent bands separate by hue as well as by value and
 * the quantisation survives the saturation lift in the post grade.
 *
 * uBandBias slides the whole set along the ramp. It exists so a symmetric
 * standing figure does not get its terminator on the centreline: pushing the
 * bias positive walks the boundary around toward three-quarters across.
 *
 * The ramp texture is NearestFilter, so band edges are hard - there is no
 * interpolated transition value anywhere in this path.
 */
vec3 wbCelDiffuse(vec3 albedo, vec3 N, vec3 L) {
  float ndl = dot(N, L);
  float t = clamp((ndl + uWrap) / (1.0 + uWrap) + uBandBias, 0.0, 1.0);
  vec4 ramp = texture(uRamp, vec2(t, 0.5));

  vec3 bandLight = ramp.rgb * WB_RAMP_SCALE;
  float wash = ramp.a;

  // Hue-preserving path.
  vec3 mult = albedo * bandLight * uSunColor;
  // Authored path: the band colour, scaled by how bright the albedo is so a
  // dark object does not get washed to the same value as a light one. The
  // constant term is deliberately small - a large one greys out anything dark,
  // which turned the boat cowling into warm putty instead of navy.
  float alum = dot(albedo, WB_LUMA);
  vec3 washed = bandLight * uSunColor * (0.10 + 0.90 * alum);

  vec3 col = mix(mult, washed, wash);
  col += albedo * uAmbient * 0.28;

  // Nothing in a cel-shaded frame sits at zero. The ink line carries the black,
  // the fill never does - a 0-2% luma mass reads as missing geometry, not as
  // shadow. Lift only what is already below the floor, and lift it toward a
  // cool navy so the darks stay a colour rather than becoming grey.
  // Squared so the lift falls away fast: a mass that was already near the floor
  // keeps most of its own variation instead of being crushed flat onto it.
  float lum = dot(col, WB_LUMA);
  float floorLum = dot(uShadowFloor, WB_LUMA);
  float k = clamp(1.0 - lum / max(floorLum, 1e-4), 0.0, 1.0);
  col += uShadowFloor * k * k;

  return col;
}

/**
 * Banded specular: a hard-edged highlight shape. uSpecSoftness is deliberately
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
 * Rim light. Not a fresnel falloff - a drawn band.
 *
 * The threshold is hard and the only softening is one screen-space derivative
 * wide, so the rim is a constant-width contour at any distance instead of a
 * glow that fades out as the object shrinks. That constancy is the point: it is
 * what stops a distant racer merging into the wake shadow.
 *
 * It is weighted toward the up-facing and away-from-key edges so it reads as
 * sky bounce rather than as a second light, and it never switches off with
 * depth.
 */
vec3 wbCelRim(vec3 N, vec3 V, vec3 L) {
  float f = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), uRimPower);
  float w = max(fwidth(f), 1e-4);
  float band = smoothstep(uRimThreshold - w, uRimThreshold + w, f);
  float core = smoothstep(uRimThreshold + uRimWidth - w, uRimThreshold + uRimWidth + w, f);
  // Sky bounce lands on what faces up and on what faces away from the key.
  float up   = clamp(N.y * 0.45 + 0.66, 0.0, 1.0);
  float away = clamp(0.52 + 0.48 * (1.0 - max(dot(N, L), 0.0)), 0.0, 1.0);
  return uRimColor * (band * 0.68 + core * 0.52) * up * away * uRimStrength;
}

/**
 * Matcap lookup - the only "environment" in the game.
 *
 * The sample is re-quantised after the fetch. The texture is drawn as hard
 * concentric bands, but a 256px matcap minified onto a 20px prop is mipmapped
 * into a smooth radial gradient, which is exactly how the gate pylons and the
 * boat headlamp ended up reading as PBR. Quantising the fetched value restores
 * hard steps at any size.
 */
vec3 wbMatcap(vec3 viewNormal) {
  vec2 uv = viewNormal.xy * 0.49 + 0.5;
  vec3 m = texture(uMatcap, uv).rgb;
  float v = max(max(m.r, m.g), m.b);
  float q = floor(v * 4.0) * 0.25 + 0.125;
  return m * (q / max(v, 1e-4));
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
