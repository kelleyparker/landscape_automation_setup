import { GBUFFER_OUT, OCT_PACK, GBUFFER_WRITE, DITHER } from '../../render/shaders/celChunks';

/**
 * All GLSL for everything above the waterline: the gradient dome (with the sun
 * disc painted into it), the cel cloud cards, and the graphic sun flare.
 *
 * Three ideas run through this file and are worth stating once rather than
 * repeating in every shader:
 *
 *  1. **Nothing here is physical.** There is no scattering integral, no Mie/
 *     Rayleigh split, no sun radiance. The sky is a painted backdrop: a curve
 *     through three palette colours, chopped into flat bands where a background
 *     painter would have laid flat blocks, and left smooth only where a wash
 *     belongs (the zenith).
 *
 *  2. **The dome and the flare share one sun.** The disc is drawn by testing the
 *     angle between the view ray and `uSunDir`; the flare is anchored by
 *     projecting the *same* vector to NDC with w = 0. A directional light has no
 *     parallax, so both land on the same pixel by construction - there is no way
 *     for the drawn sun and the lighting sun to disagree.
 *
 *  3. **The G-buffer contract, under blending.** WebGL applies the blend
 *     equation to every colour attachment, and each attachment uses *its own*
 *     alpha as the source factor. Attachment 1's alpha is `edgeMask`. So a
 *     surface that writes `edgeMask = 0` under SRC_ALPHA blending leaves the
 *     normal/depth buffer bit-identical - which is exactly what a transparent
 *     sky card or an additive overlay wants. The opaque dome, which needs to
 *     stamp depth = 1.0 across the frame, is the only one here that actually
 *     lands in attachment 1.
 */

// ---------------------------------------------------------------- dome -------

export const SKY_DOME_VERT = /* glsl */ `
out vec3 vDir;

void main() {
  // The dome is pinned to the camera every frame *in the shader* rather than by
  // moving an Object3D, so it costs nothing on the CPU and can never lag a frame
  // behind the camera. 'position' is a sphere of radius DOME_RADIUS centred on
  // the origin, which makes it a ready-made direction vector.
  vDir = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + position, 1.0);
}
`;

export const SKY_DOME_FRAG = /* glsl */ `
precision highp float;
${GBUFFER_OUT}
${OCT_PACK}
${GBUFFER_WRITE}
${DITHER}

uniform vec3  uZenith;
uniform vec3  uMid;
uniform vec3  uHorizon;
uniform vec3  uHazeLift;   // cool near-white the horizon band lifts toward
uniform vec3  uUnderHaze;  // colour below the horizon line, for any gap the ocean leaves
uniform vec3  uSunDir;
uniform vec3  uSunCore;
uniform vec3  uSunGlow;
uniform float uTime;

in vec3 vDir;

// -- band structure -----------------------------------------------------------
// BAND_TOP is measured in sin(elevation), not degrees: 0.42 is ~25 degrees.
// With the 58-degree vertical FOV the camera runs at, that puts the flat blocks
// in roughly the bottom half of the frame when looking at the horizon - which is
// where a background painter puts them - and leaves the top of the frame a wash.
const float BAND_TOP   = 0.42;
// Five bands. Four reads as a poster, six starts to read as a bad gradient.
const float BAND_COUNT = 5.0;

// -- sun geometry -------------------------------------------------------------
// Angular radii in radians. The real sun is 0.0047 rad; every one of these is
// deliberately far larger, because an accurate sun is a two-pixel dot and this
// one has to carry the frame.
const float SUN_CORE  = 0.0225;   // ~1.3 deg: hard white core
const float SUN_RING1 = 0.0345;
const float SUN_RING2 = 0.0520;
const float SUN_HALO  = 0.1150;   // ~6.6 deg: the outermost, faintest step

/** Horizon -> mid -> zenith, evaluated on an already-curved parameter. */
vec3 skyGradient(float t) {
  return t < 0.5 ? mix(uHorizon, uMid, t * 2.0)
                 : mix(uMid, uZenith, (t - 0.5) * 2.0);
}

void main() {
  vec3 dir = normalize(vDir);
  float e = dir.y;                                  // sin(elevation), -1..1

  // pow < 1 stretches the low sky. Without it the five bands would be squashed
  // into a few dozen pixels above the horizon and read as a moire, not as blocks.
  float t = pow(clamp(e, 0.0, 1.0), 0.62);

  // --- quantise the low sky --------------------------------------------------
  // 'zone' is 1 where the sky is flat blocks and 0 where it is a smooth wash.
  // The crossover deliberately starts at 55% of the band region, so the bottom
  // two or three bands are dead hard and the top one or two dissolve upward.
  float zone = 1.0 - smoothstep(BAND_TOP * 0.55, BAND_TOP * 1.10, t);

  // Band edges undulate slowly with azimuth. Amplitude is well under one band,
  // so edges breathe without ever crossing each other or popping a band out of
  // existence. Two incommensurate terms keep the motion from reading as a spin.
  float az = atan(dir.z, dir.x);
  float wob = 0.20 * sin(az * 2.0 + uTime * 0.055)
            + 0.12 * sin(az * 3.0 - uTime * 0.031);

  float u  = clamp(t / BAND_TOP, 0.0, 1.0);
  float uq = clamp((floor(u * BAND_COUNT + wob) + 0.5) / BAND_COUNT, 0.0, 1.0);
  // Blending the *parameter* rather than the two colours is what makes the steps
  // shrink smoothly as they climb instead of cross-fading into ghost bands.
  float tt = mix(t, uq * BAND_TOP, zone);

  vec3 col = skyGradient(tt);

  // --- horizon haze ----------------------------------------------------------
  // The scene fog carries the ocean to uHorizon by 1750 m, so the sea's far edge
  // and the sky already meet at the identical value - there is no hard line to
  // hide. What this band adds is the lift you get looking through a lot of moist
  // air: narrow, centred on the horizon, and stepped so it matches the treatment
  // above it rather than reading as a soft photographic glow.
  float hazeE = abs(e + 0.004 * sin(az * 1.7 + uTime * 0.04));
  float haze  = 1.0 - clamp(hazeE / 0.115, 0.0, 1.0);   // +-6.6 degrees
  float hazeQ = floor(haze * 3.0 + 0.5) / 3.0;          // three hard steps

  // --- azimuthal warmth ------------------------------------------------------
  // Low sky on the sun's side of the compass warms toward the sun colour. Also
  // stepped: a smooth azimuthal wash is the single fastest way to make a cel sky
  // look like a render.
  vec3  sunAzDir = normalize(vec3(uSunDir.x, 0.0, uSunDir.z));
  vec3  viewAz   = normalize(vec3(dir.x, 0.0, dir.z) + 1e-5);
  float sunSide  = max(dot(viewAz, sunAzDir), 0.0);
  float warm     = pow(sunSide, 3.0) * (1.0 - smoothstep(0.0, 0.55, t));
  float warmQ    = floor(warm * 3.0) / 3.0;

  col = mix(col, uHazeLift, hazeQ * (0.20 + 0.22 * sunSide));
  col = mix(col, uSunGlow, warmQ * 0.16);

  // A broad stepped bloom around the sun itself. This matters more than it looks:
  // SUN_DIR sits at 43 degrees elevation and the chase camera's frame top reaches
  // about 20, so the disc is usually just out of shot. This lobe (half-strength
  // at ~27 degrees off-axis) is what puts the sun's presence *in* the frame. Four
  // hard steps, because a smooth radial falloff here is a lens, not a painting.
  float bloom  = pow(max(dot(dir, normalize(uSunDir)), 0.0), 6.0);
  float bloomQ = floor(bloom * 4.0) / 4.0;
  col = mix(col, uSunGlow, bloomQ * 0.28);

  // Below the horizon the ocean covers everything - except at the very edge of
  // the water mesh, where a gap would otherwise flash bright sky. Sinking to a
  // sea-toned haze makes any such gap invisible.
  col = mix(col, uUnderHaze, smoothstep(0.0, 0.16, -e));

  // --- the sun ---------------------------------------------------------------
  // Concentric hard discs, largest and faintest first. fwidth() gives each edge
  // exactly one pixel of anti-aliasing - enough to stop the circle stair-stepping,
  // not enough to read as a falloff. (fwidth of acos blows up at the very centre,
  // but that point is buried inside the core disc, so it never shows.)
  float ang = acos(clamp(dot(dir, normalize(uSunDir)), -1.0, 1.0));
  float w   = fwidth(ang) * 0.9 + 1e-4;
  // The halo breathes very slowly. It is the only part of the sun that moves.
  float haloR = SUN_HALO * (1.0 + 0.05 * sin(uTime * 0.37));

  float halo  = 1.0 - smoothstep(haloR      - w, haloR      + w, ang);
  float ring2 = 1.0 - smoothstep(SUN_RING2  - w, SUN_RING2  + w, ang);
  float ring1 = 1.0 - smoothstep(SUN_RING1  - w, SUN_RING1  + w, ang);
  float core  = 1.0 - smoothstep(SUN_CORE   - w, SUN_CORE   + w, ang);

  col = mix(col, uSunGlow, halo  * 0.16);
  col = mix(col, uSunGlow, ring2 * 0.34);
  col = mix(col, uSunGlow, ring1 * 0.70);
  col = mix(col, uSunCore, core);

  // Dither only where the sky is a genuine gradient. Inside a flat band there is
  // nothing to break up, and dithering a flat block just adds noise to it.
  col += wbDither(gl_FragCoord.xy) * (1.0 - zone) * 1.6;

  gColor = vec4(col, 1.0);
  // depth = uCameraFar -> 1.0 after the divide, so the Sobel pass sees the sky as
  // infinitely far and silhouettes everything against it. A constant view normal
  // means the sky itself contributes no normal gradient, and edgeMask = 0
  // guarantees no interior line is ever drawn across it.
  wbWriteGBuffer(vec3(0.0, 0.0, 1.0), uCameraFar, 0.0);
}
`;

// -------------------------------------------------------------- clouds -------

export const CLOUD_VERT = /* glsl */ `
// Per-instance orbit and style. The clouds live on camera-locked cylindrical
// shells: fixed radius, fixed altitude, drifting azimuth. That is what "wrap
// them around the camera" means here - the player can drive forever and the sky
// composition never falls apart, never pops at a tile seam, and never lets a
// card swing overhead where a yaw-locked billboard would spin.
in vec4 aOrbit;   // x radius (m), y altitude (m), z azimuth0 (rad), w omega (rad/s)
in vec4 aStyle;   // x cellU, y cellV, z tint 0..1, w flip sign (+-1)

uniform vec2  uCellSize;
uniform vec3  uSunDir;
uniform float uTime;

out vec2  vUv;
out vec3  vViewNormal;
out float vViewDepth;
out float vHaze;
out float vRim;
out float vTint;

void main() {
  float az = aOrbit.z + uTime * aOrbit.w;
  vec2  rad = vec2(cos(az), sin(az));

  // A very slow vertical bob, phase-locked to the instance's start azimuth so it
  // needs no extra attribute. ~3% of altitude - under half a degree at these
  // distances, which is the point: it should register as air moving, not motion.
  float bob = sin(uTime * 0.043 + aOrbit.z * 5.3) * aOrbit.y * 0.035;

  vec3 centre = vec3(
    cameraPosition.x + rad.x * aOrbit.x,
    aOrbit.y + bob,
    cameraPosition.z + rad.y * aOrbit.x
  );

  // Because the shell is camera-locked, the horizontal direction back to the
  // camera is exactly -rad. No normalize, no cross product, and no degenerate
  // case when a cloud passes near the zenith - it never can.
  vec3 fwd   = vec3(-rad.x, 0.0, -rad.y);           // cloud -> camera, horizontal
  vec3 right = vec3(-rad.y, 0.0,  rad.x);           // == cross(worldUp, fwd)

  // Instance scale only; the matrix carries no rotation, so reading the diagonal
  // is exact and avoids two length() calls per vertex.
  float sx = instanceMatrix[0][0];
  float sy = instanceMatrix[1][1];

  // Up is world up, deliberately. A full camera-facing billboard tips as the
  // chase cam pitches and instantly gives away that the cloud is a card.
  vec3 world = centre + right * (position.x * sx) + vec3(0.0, position.y * sy, 0.0);

  vec4 mvPos = viewMatrix * vec4(world, 1.0);
  vViewDepth = -mvPos.z;
  gl_Position = projectionMatrix * mvPos;

  // Atlas cell, optionally mirrored so the same eight drawings do not read as
  // eight stamps repeated round the horizon.
  float uu = aStyle.w > 0.0 ? uv.x : 1.0 - uv.x;
  vUv = vec2(aStyle.x + uu * uCellSize.x, aStyle.y + uv.y * uCellSize.y);

  vViewNormal = normalize(mat3(viewMatrix) * fwd);

  // Atmosphere by *elevation*, never by distance. The scene fog would erase
  // these entirely (it ends at 1750 m and the far shell sits at 2750 m), but the
  // clouds are part of the backdrop, not part of the world - they belong to the
  // sky's treatment. Low ones sink into the horizon band; high ones stay crisp.
  vec3  toCam = cameraPosition - centre;
  float elev  = (centre.y - cameraPosition.y) / max(length(toCam), 1.0);
  // Capped at 0.62: a cloud sitting on the haze band should half-dissolve into
  // it, not disappear. Losing them entirely leaves a bald strip above the sea.
  vHaze = (1.0 - smoothstep(0.03, 0.20, elev)) * 0.62;

  // Backlit clouds get the hot rim. dot(-fwd, sunAzimuth) is 1 when the cloud
  // sits between the camera and the sun.
  vRim  = 0.55 + 0.45 * max(dot(-fwd, normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
  vTint = aStyle.z;
}
`;

export const CLOUD_FRAG = /* glsl */ `
precision highp float;
${GBUFFER_OUT}
${OCT_PACK}
${GBUFFER_WRITE}

// uAtlas is a *mask*, not a picture: R marks the lit body, G the rim ribbon,
// B the shaded underside, A the silhouette. Every colour comes from the palette
// uniforms below, so the clouds re-tint for free if the palette moves.
uniform sampler2D uAtlas;
uniform vec3  uLit;
uniform vec3  uShade;
uniform vec3  uRimColor;
uniform vec3  uHaze;
uniform float uOpacity;

in vec2  vUv;
in vec3  vViewNormal;
in float vViewDepth;
in float vHaze;
in float vRim;
in float vTint;

void main() {
  vec4 m = texture(uAtlas, vUv);

  // One to two pixels of anti-aliasing on the silhouette and nothing else. A
  // wider ramp here is the difference between a painted cloud and a puff of fog.
  float a = smoothstep(0.40, 0.60, m.a) * uOpacity;
  if (a < 0.006) discard;

  // step() rather than the raw channel: the atlas is mip-mapped, and without the
  // threshold the three tones would blend into a gradient at distance - exactly
  // the failure this whole art direction exists to avoid.
  vec3 col = uShade;
  col = mix(col, uLit,      step(0.5, m.r));
  col = mix(col, uRimColor, step(0.5, m.g) * vRim);

  // Per-instance tint plus elevation haze, both pulling toward the horizon
  // colour so the cloud band dissolves into the atmosphere at its lower edge.
  col = mix(col, uHaze, clamp(vTint * 0.16 + vHaze, 0.0, 1.0));

  gColor = vec4(col, a);
  // edgeMask = 0. Two things follow: the Sobel pass draws no interior line here
  // (the cloud's own rim ribbon *is* its outline), and because attachment 1 is
  // blended with its own alpha as the source factor, writing 0 there leaves the
  // normal/depth buffer underneath completely untouched.
  wbWriteGBuffer(normalize(vViewNormal), vViewDepth, 0.0);
}
`;

// --------------------------------------------------------------- flare -------

export const FLARE_VERT = /* glsl */ `
// The flare is a screen-space ornament. 'position.xy' is the shape in flare
// space, measured in screen units where 1.0 is half the frame height; z is
// unused. Nothing about this mesh's world transform matters.
in vec2 aLocal;   // shape-local coord for the hexagon SDF (unused by spikes)
in vec4 aData;    // x anchor t, y alpha, z tint 0..1, w spine/edge weight
in vec4 aMisc;    // x kind, y ring ratio, z shimmer phase, w shimmer amount

uniform vec3  uSunDir;
uniform float uTime;
uniform float uOpacity;

out vec2  vLocal;
out float vAlpha;
out float vTint;
out float vEdge;
out float vKind;
out float vRing;

void main() {
  // Project the sun. w = 0 treats it as the directional light it is, so this is
  // the exact screen point the dome paints the disc at - no offset, no parallax.
  vec3 sunView = mat3(viewMatrix) * normalize(uSunDir);
  vec4 sunClip = projectionMatrix * vec4(sunView, 0.0);
  float inFront = step(1e-4, sunClip.w);
  vec2 sunNdc = sunClip.xy / max(sunClip.w, 1e-4);

  // Work in screen units so spikes stay straight and hexagons stay regular on
  // any window shape. For a perspective camera P[0][0] = focal/aspect and
  // P[1][1] = focal, so their ratio is the aspect - no uniform needed.
  float aspect = projectionMatrix[1][1] / max(projectionMatrix[0][0], 1e-6);
  vec2  sunScreen = vec2(sunNdc.x * aspect, sunNdc.y);

  // The ornament's axis runs sun -> frame centre and everything rotates with it,
  // which is what makes the spikes and ghosts read as one drawn device rather
  // than a scatter of sprites that happen to be near the sun.
  float axLen = length(sunScreen);
  vec2  axis  = axLen > 1e-4 ? -sunScreen / axLen : vec2(1.0, 0.0);

  // Shimmer, quantised to five steps. A smooth sine pulse is the signature of a
  // photographic artefact; stepping it makes the flare look animated on 3s.
  float s  = sin(uTime * 0.85 + aMisc.z);
  float sc = 1.0 + aMisc.w * (floor(s * 2.0 + 0.5) * 0.5);

  vec2 p = position.xy * sc;
  vec2 rotated = vec2(p.x * axis.x - p.y * axis.y, p.x * axis.y + p.y * axis.x);
  // anchor 0 sits on the sun, 1 on the frame centre, >1 past it. Ghosts ride
  // this axis; spikes are anchored at 0 and so scale about the sun itself.
  vec2 screen = sunScreen * (1.0 - aData.x) + rotated;

  // z = 0 with depth testing off: this is an overlay, drawn last, over everything.
  gl_Position = vec4(screen.x / aspect, screen.y, 0.0, 1.0);

  // Fade out as the sun leaves the frame, and hard-kill it behind the camera.
  // The band is deliberately generous rather than cutting at the frame border:
  // the chase camera sits about 9 degrees nose-down with a 58 degree FOV, which
  // puts SUN_DIR at roughly |ndc| = 2.3 - so a fade that ends at 1.0 would mean
  // the flare literally never appears. Ending at 1.55 keeps the ordinary racing
  // shot completely clean while letting the spikes reach into frame the moment
  // the camera tips up (jumps, the orbit intro, the results circle).
  float edge = max(abs(sunNdc.x), abs(sunNdc.y));
  float fade = (1.0 - smoothstep(0.80, 1.55, edge)) * inFront;

  vLocal = aLocal;
  vAlpha = aData.y * fade * uOpacity;
  vTint  = aData.z;
  vEdge  = aData.w;
  vKind  = aMisc.x;
  vRing  = aMisc.y;
}
`;

export const FLARE_FRAG = /* glsl */ `
precision highp float;
${GBUFFER_OUT}
${OCT_PACK}
${GBUFFER_WRITE}

uniform vec3 uCore;
uniform vec3 uGlow;

in vec2  vLocal;
in float vAlpha;
in float vTint;
in float vEdge;
in float vKind;
in float vRing;

/** Regular hexagon SDF (Inigo Quilez). Negative inside; unit apothem. */
float wbHex(vec2 p) {
  const vec3 k = vec3(-0.8660254, 0.5, 0.5773503);
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z, k.z), 1.0);
  return length(p) * sign(p.y);
}

void main() {
  // Spike. Hard along the spine, feathered at the two long edges. The renderer
  // runs with MSAA off (it fights the ink lines), and a two-pixel-wide triangle
  // with a hard edge crawls violently as the camera moves - this is the cheapest
  // fix, and it also gives the spike the bright-cored look a drawn ray should have.
  float spikeMask = smoothstep(0.0, 0.32, vEdge);

  // Ghost. Evaluated as an SDF rather than as hexagon geometry, so the edge gets
  // exactly one pixel of anti-aliasing at any size and the ring variant is a
  // subtraction instead of twelve more triangles.
  //
  // Both branches are evaluated unconditionally on purpose: fwidth() inside
  // non-uniform control flow is undefined in GLSL ES, and the cost here is a
  // handful of ALU on a mesh with well under a hundred vertices. Spikes carry
  // vLocal = (0,0) and vRing = 1, so the hexagon terms stay finite for them.
  float d  = wbHex(vLocal);
  float w  = fwidth(d) * 1.1 + 1e-5;
  float di = wbHex(vLocal / max(vRing, 1e-3)) * vRing;
  float hexMask = (1.0 - smoothstep(-w, w, d))
                * mix(1.0, smoothstep(-w, w, di), step(1.5, vKind));

  float mask = mix(spikeMask, hexMask, step(0.5, vKind));

  float a = mask * vAlpha;
  if (a < 0.002) discard;

  gColor = vec4(mix(uCore, uGlow, vTint), a);

  // Additive pass. The blend equation runs on attachment 1 too, and its source
  // factor is that attachment's own alpha - which is edgeMask, which is 0 here.
  // So this call provably adds nothing: the normal/depth buffer under the flare
  // survives untouched and the Sobel pass keeps inking whatever is behind it.
  wbWriteGBuffer(vec3(0.0, 0.0, 1.0), 0.0, 0.0);
}
`;
