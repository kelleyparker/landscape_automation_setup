import { GBUFFER_OUT, OCT_PACK, GBUFFER_WRITE } from '../../render/shaders/celChunks';

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
// The sky is the largest surface in the frame, so it is the one that decides
// whether the game reads as painted or as rendered. It is therefore quantised
// EVERYWHERE - there is no smooth region left in it, not even at the zenith.
//
// The parameter is elevation *angle*, normalised so 1.0 is straight up, because
// that is the axis a background painter stacks flats on. Band heights are
// deliberately unequal: a narrow haze sliver on the waterline, then steps that
// roughly double in height on the way up, ending in one huge zenith plate. That
// progression is what makes a flat backdrop read as a dome - the compression
// near the horizon *is* the perspective.
//
// Seven bands, six edges. Only five or six are ever in shot at once (the top of
// a 72-degree frame aimed at the horizon reaches about 35 degrees).
const float SKY_EDGE[6] = float[6](0.016, 0.048, 0.098, 0.175, 0.295, 0.500);
// Per-edge waver amplitude: about a quarter of the narrower neighbouring band,
// so an edge can never touch, cross or swallow its neighbour.
const float SKY_WOB[6]  = float[6](0.0045, 0.0090, 0.0140, 0.0215, 0.0340, 0.0570);
// Each band's fixed position on the horizon -> mid -> zenith ramp. These are the
// chosen palette entries; nothing between them is ever displayed.
const float SKY_TONE[7] = float[7](0.058, 0.157, 0.284, 0.444, 0.659, 0.962, 1.000);
// How far each band is lifted toward the near-white haze colour. Only the two
// lowest carry any, which is what turns the bottom of the sky into a fog wedge
// that meets the fogged far water instead of stepping against it - and because
// the lift is constant across a band, it adds no edge of its own.
const float SKY_HAZE[7] = float[7](0.50, 0.21, 0.06, 0.000, 0.000, 0.000, 0.000);
// And how far it is warmed toward the sun's own gold. Warmth belongs to the
// bands, not to a compass sector: an azimuthal wash needs an edge somewhere, and
// wherever that edge lands it is a vertical seam in a sky made of horizontals.
// Because the whole band stack rises toward the sun (see 'lift' below), warm
// bands sit visibly higher on the sun's side, which is the light cue - drawn
// with the same steps as everything else instead of painted over them.
const float SKY_WARM[7] = float[7](0.19, 0.09, 0.03, 0.000, 0.000, 0.000, 0.000);

// -- sun geometry -------------------------------------------------------------
// Angular radii in radians. The real sun is 0.0047 rad; every one of these is
// deliberately far larger, because an accurate sun is a two-pixel dot and this
// one has to carry the frame. Five concentric hard discs - a drawn corona, not
// a bloom: no term in here falls off with distance.
const float SUN_CORE  = 0.0300;   // ~1.7 deg: flat white disc
const float SUN_RING1 = 0.0430;
const float SUN_RING2 = 0.0600;
const float SUN_RING3 = 0.0820;
const float SUN_HALO  = 0.1120;   // ~6.4 deg: outermost, palest step

/** Horizon -> mid -> zenith, evaluated at one of the seven band positions. */
vec3 skyGradient(float t) {
  return t < 0.5 ? mix(uHorizon, uMid, t * 2.0)
                 : mix(uMid, uZenith, (t - 0.5) * 2.0);
}

void main() {
  vec3 dir = normalize(vDir);
  float e = dir.y;                                  // sin(elevation), -1..1

  // Elevation angle, normalised to 1.0 at the zenith. 2/PI = 0.6366198.
  float a01 = asin(clamp(e, 0.0, 1.0)) * 0.6366198;

  float az = atan(dir.z, dir.x);

  // --- light axis ------------------------------------------------------------
  // One key direction, taken straight from SUN_DIR so the sky agrees with every
  // cel material's terminator by construction. Rather than washing a colour
  // across the sky (which is what makes a cel sky look rendered), the sun's side
  // of the compass *raises the band edges*: the pale low bands stack higher
  // toward the sun and the deep bands drop toward it. The steps stay flat and
  // the light direction is legible even with the disc out of frame.
  vec3  sunDir   = normalize(uSunDir);
  vec3  sunAzDir = normalize(vec3(uSunDir.x, 0.0, uSunDir.z));
  vec3  viewAz   = normalize(vec3(dir.x, 0.0, dir.z) + vec3(1e-5, 0.0, 0.0));
  float axis     = dot(viewAz, sunAzDir);           // +1 into the sun, -1 away
  float sunSide  = max(axis, 0.0);
  float lift     = 0.052 * pow(sunSide, 1.5);
  // ...and the far side of the compass drops them, so the deep cobalt reaches
  // further down there. Same device, opposite sign: the sky is pale and warm
  // where the light comes from and cold and heavy where it does not.
  float drop     = 0.026 * pow(max(-axis, 0.0), 1.5);

  float p = a01 - lift + drop;

  // --- pick a band -----------------------------------------------------------
  // Edges waver slowly with azimuth on two incommensurate terms, so they read as
  // brushed flats rather than as a ruler, and never resolve into a spin.
  float band = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float wob = 0.62 * sin(az * 2.0 + uTime * 0.047 + fi * 1.93)
              + 0.38 * sin(az * 3.0 - uTime * 0.031 + fi * 0.77);
    band += step(SKY_EDGE[i] + SKY_WOB[i] * wob, p);
  }
  int bi = int(clamp(band, 0.0, 6.0));

  vec3 col = skyGradient(SKY_TONE[bi]);
  col = mix(col, uHazeLift, SKY_HAZE[bi]);
  // Gold only where the band under it is already pale: over mid-blue it would
  // make mauve, which is the exact mud this replaced.
  col = mix(col, uSunGlow, SKY_WARM[bi]);

  // Below the horizon the ocean covers everything - except at the very edge of
  // the water mesh, where a gap would otherwise flash bright sky. Sinking to a
  // sea-toned haze makes any such gap invisible. Stepped, like everything else.
  float under = clamp(-e / 0.14, 0.0, 1.0);
  col = mix(col, uUnderHaze, floor(under * 3.0 + 0.5) / 3.0);

  // --- the sun ---------------------------------------------------------------
  // Concentric hard discs, largest and faintest first. fwidth() gives each edge
  // exactly one pixel of anti-aliasing - enough to stop the circle stair-stepping,
  // not enough to read as a falloff. (fwidth of acos blows up at the very centre,
  // but that point is buried inside the core disc, so it never shows.)
  //
  // The two outer rings lift toward the pale haze colour rather than toward gold:
  // over mid-blue sky a gold ring of any width turns violet, which is exactly the
  // muddy corona this replaced.
  float ang = acos(clamp(dot(dir, sunDir), -1.0, 1.0));
  float w   = fwidth(ang) * 0.8 + 1e-4;
  // The halo breathes - on threes, quantised, so it animates like a drawing.
  float haloR = SUN_HALO * (1.0 + 0.045 * floor(sin(uTime * 0.41) * 2.0 + 0.5) * 0.5);

  float halo  = 1.0 - smoothstep(haloR      - w, haloR      + w, ang);
  float ring3 = 1.0 - smoothstep(SUN_RING3  - w, SUN_RING3  + w, ang);
  float ring2 = 1.0 - smoothstep(SUN_RING2  - w, SUN_RING2  + w, ang);
  float ring1 = 1.0 - smoothstep(SUN_RING1  - w, SUN_RING1  + w, ang);
  float core  = 1.0 - smoothstep(SUN_CORE   - w, SUN_CORE   + w, ang);

  col = mix(col, uHazeLift, halo  * 0.22);
  col = mix(col, uHazeLift, ring3 * 0.46);
  col = mix(col, uSunGlow,  ring2 * 0.60);
  col = mix(col, uSunGlow,  ring1 * 0.88);
  col = mix(col, uSunCore,  core);

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
  // Capped at 0.52: a cloud sitting on the haze band should half-dissolve into
  // it, not disappear. Losing them entirely leaves a bald strip above the sea,
  // and the low shell exists precisely to fill that strip.
  vHaze = (1.0 - smoothstep(0.006, 0.150, elev)) * 0.52;

  // Backlit clouds get the hot rim. dot(-fwd, sunAzimuth) is 1 when the cloud
  // sits between the camera and the sun. Two steps, not a ramp: a cloud is
  // either taking the light or it is not, and the rim is at three quarters
  // strength even facing away so the ribbon never dulls into khaki.
  float faceSun = max(dot(-fwd, normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
  vRim  = 0.74 + 0.26 * step(0.30, faceSun);
  vTint = aStyle.z;
}
`;

export const CLOUD_FRAG = /* glsl */ `
precision highp float;
${GBUFFER_OUT}
${OCT_PACK}
${GBUFFER_WRITE}

// uAtlas is a *mask*, not a picture: R marks the lit body, G the rim ribbon,
// B the shaded underside, A the silhouette, and rgb = 0 with a = 1 marks the ink
// contour. Every colour comes from the palette uniforms below, so the clouds
// re-tint for free if the palette moves.
uniform sampler2D uAtlas;
uniform vec3  uLit;
uniform vec3  uShade;
uniform vec3  uRimColor;
uniform vec3  uInk;
uniform vec3  uHaze;
uniform float uOpacity;
/** Atlas width in texels, for the ink line's minification fade. */
uniform float uAtlasTexels;

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
  // Quantised to three steps: a continuous per-instance tint is a per-instance
  // gradient, which is the same defect as a smooth sky, just spread over sixty
  // draws instead of one.
  float hz = clamp(vTint * 0.14 + vHaze, 0.0, 1.0);
  hz = floor(hz * 3.0 + 0.5) / 3.0;
  col = mix(col, uHaze, hz);

  // Ink contour. The atlas carries a dilated ring of rgb = 0 around every
  // silhouette, so the line is a constant width in atlas texels and follows the
  // shape exactly - the same treatment the hulls get from the inverted hull, and
  // the reason the clouds no longer read as being from a different game. It
  // hazes at a third of the rate of the tones, so distant clouds keep their line.
  //
  // The fade matters. Once a card is minified past about two texels per pixel the
  // mip chain averages the ring into the tones, the channel sum for a thin cloud
  // drops under the threshold across its whole body, and the cloud renders as one
  // solid dark smear. Retiring the line before that happens costs a small cloud
  // its outline and saves it its shape.
  float texels = max(length(dFdx(vUv)), length(dFdy(vUv))) * uAtlasTexels;
  float inkFade = 1.0 - smoothstep(1.5, 3.0, texels);
  float ink = step(m.r + m.g + m.b, 0.38) * inkFade;
  col = mix(col, mix(uInk, uHaze, hz * 0.34), ink);

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
