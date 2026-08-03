import * as THREE from 'three';
import { PALETTE, SUN_DIR } from '../core/Palette';
import { rng, Rng } from '../core/Rng';
import { WAVES } from '../ocean/waveConfig';
import {
  SKY_DOME_VERT, SKY_DOME_FRAG,
  CLOUD_VERT, CLOUD_FRAG,
  FLARE_VERT, FLARE_FRAG,
} from './shaders/skyShaders';

/**
 * WAVEBREAK sky: everything above the waterline.
 *
 * Three objects, in draw order:
 *
 *   1. `dome`   - an inverted sphere pinned to the camera in the vertex shader.
 *                 Carries the gradient, the quantised horizon bands, the horizon
 *                 haze and the sun disc itself. Opaque, no depth write,
 *                 renderOrder far below everything else so it draws first.
 *   2. `clouds` - an InstancedMesh of yaw-locked cards on three camera-locked
 *                 cylindrical shells, sampling a procedurally drawn cloud
 *                 alphabet. Transparent, depth-written (their alpha is
 *                 near-binary, so writing depth is what gets cloud-vs-cloud
 *                 occlusion right regardless of instance order).
 *   3. `flare`  - a screen-space ornament: six hard-edged radiating rays,
 *                 anchored by projecting SUN_DIR to NDC every frame. Additive,
 *                 no depth test, drawn last. A drawn sunburst, not a lens
 *                 simulation - see `buildFlareGeometry` for what was removed.
 *
 * Nothing in here is loaded: the cloud alphabet is drawn to a canvas at
 * construction, every mesh is built from BufferGeometry, and the only randomness
 * comes from a fork of the global seeded Rng, so a given seed always produces the
 * same sky.
 */

/** Dome radius. Comfortably inside the camera's 4200 m far plane. */
const DOME_RADIUS = 3600;
/** Must match the PerspectiveCamera far plane in core/Engine.ts. */
const CAMERA_FAR = 4200;

// ---------------------------------------------------------- cloud alphabet ---

const CLOUD_COLS = 4;
// One row per silhouette family (see CLOUD_FORMS). Twelve drawings, each of
// which also renders mirrored, is twenty-four silhouettes - enough that the eye
// stops finding the repeat, which four drawings never were.
const CLOUD_ROWS = 3;
// Cells are 2:1, not square. A cumulus drawn from discs on a flat base is about
// three times as wide as it is tall, so a square cell would throw away well over
// half its texels and force the lobes small enough to read as bubbles.
const CLOUD_CELL_W = 256;
const CLOUD_CELL_H = 128;

/**
 * Channel encodings for the cloud alphabet. These are NOT colours - the atlas is
 * a four-channel mask (R = lit body, G = rim ribbon, B = shaded underside,
 * A = silhouette) and every actual colour is a palette uniform in the shader.
 * Ink is the fifth state and needs no channel of its own: rgb = 0 with a = 1 is
 * unreachable for any of the three tones, so the shader reads it as the contour.
 * That is why no sky colour is ever baked into a canvas in this file.
 */
const ENC_LIT = 'rgb(255,0,0)';
const ENC_RIM = 'rgb(0,255,0)';
const ENC_SHADE = 'rgb(0,0,255)';
const ENC_INK = 'rgb(0,0,0)';

/**
 * Ink contour width, in atlas texels, per silhouette family. It is authored per
 * form rather than globally because the line has to stay a constant fraction of
 * the *drawn mass*: five texels around a heaped cumulus is a line, and the same
 * five around a thin streak is most of the cloud.
 */
const CLOUD_INK = [4.6, 4.2, 2.8] as const;
/**
 * Stamps in the dilation ring. The boundary of the union of N discs of radius r
 * spaced round a circle deviates from a true offset by r*(1 - cos(PI/N)), so at
 * 16 it is under 2% of the line width - a constant-width contour for practical
 * purposes, and it costs sixteen path fills once, at construction.
 */
const CLOUD_INK_STEPS = 16;

/**
 * The three silhouette families. Varying lobe count alone still reads as one
 * cloud stretched; what actually separates them is crown height against mass
 * width, so each family has its own radius scaling, base line and envelope.
 */
interface CloudForm {
  /** Index into CLOUD_INK. */
  ink: number;
  lobes: [number, number];
  /** Lobe radius as a fraction of cell height: base + span * envelope. */
  radBase: number;
  radSpan: number;
  /** How far above the base line a lobe's centre sits, as a fraction of radius. */
  rise: [number, number];
  /** The flat underside, as a fraction of cell height. */
  base: number;
  /** Envelope exponent. Lower = fuller shoulders = a longer, flatter mass. */
  envPow: number;
  /** Base slab thickness, fraction of cell height. */
  slab: number;
  /** Underside shadow height and rim ribbon width, fractions of cell height. */
  shadeH: number;
  rimW: number;
  folds: [number, number];
}

const CLOUD_FORMS: readonly CloudForm[] = [
  // 0 - tall cumulus: few big lobes, high crown, deep shadow.
  {
    ink: 0, lobes: [5, 7], radBase: 0.14, radSpan: 0.30, rise: [0.30, 0.68],
    base: 0.90, envPow: 0.55, slab: 0.13, shadeH: 0.20, rimW: 0.085, folds: [2, 3],
  },
  // 1 - broad bank: many medium lobes, half the crown height.
  {
    ink: 1, lobes: [8, 11], radBase: 0.11, radSpan: 0.24, rise: [0.34, 0.72],
    base: 0.88, envPow: 0.72, slab: 0.11, shadeH: 0.16, rimW: 0.070, folds: [3, 4],
  },
  // 2 - flat streak: a long low ribbon of small lobes. These are the ones that
  //     sit on the horizon and give the sky its scale, so they carry enough body
  //     to survive minification with their tones intact.
  {
    ink: 2, lobes: [9, 13], radBase: 0.080, radSpan: 0.150, rise: [0.32, 0.74],
    base: 0.86, envPow: 0.88, slab: 0.075, shadeH: 0.105, rimW: 0.050, folds: [2, 3],
  },
];

/**
 * Draws one cloud into a cell of the atlas.
 *
 * The silhouette is a row of overlapping discs on a flat slab - the classic
 * cumulus read: bumpy on top, cut off underneath. The three tones are produced
 * by *clipping*, not by shading: the whole silhouette is filled shade, then the
 * silhouette shifted up is filled rim, then the silhouette shifted up-and-back-
 * down is filled lit. What survives is a hard shade band along the bottom, a hard
 * rim ribbon along the top, and flat lit body between them - which is exactly how
 * a background painter blocks in a cloud, and it means the tone boundaries follow
 * the silhouette's contour instead of running as straight lines across it.
 *
 * The contour is stamped *before* the tones, as a ring of offset copies of the
 * same path. Stroking would have inked every interior arc of the union as well,
 * which is a plate of spaghetti; dilating and then painting the tones back over
 * the middle leaves exactly the outer silhouette lined.
 */
function drawCloudCell(
  ctx: CanvasRenderingContext2D, x0: number, y0: number, r: Rng, form: CloudForm
): void {
  // Padding keeps the drawing (and its ink ring) clear of the cell border so mip
  // levels do not bleed one cloud into its neighbour.
  const pad = CLOUD_CELL_H * 0.10;
  const W = CLOUD_CELL_W - pad * 2;
  const H = CLOUD_CELL_H - pad * 2;

  ctx.save();
  ctx.translate(x0 + pad, y0 + pad);

  const path = new Path2D();
  const lobes = form.lobes[0] + r.int(0, form.lobes[1] - form.lobes[0]);
  const baseY = H * form.base;

  for (let i = 0; i < lobes; i++) {
    const u = (i + 0.5) / lobes;
    // A flattened sine envelope gives the mass its hump. The exponent below 1
    // keeps the shoulders full - a pure sine reads as an arch, not a cloud.
    const env = Math.pow(Math.sin(u * Math.PI), form.envPow);
    // Radii scale with cell *height*, so the tallest lobe reaches roughly the
    // top of the cell and no lobe is ever wide enough to run off the sides.
    const rad = H * (form.radBase + form.radSpan * env) * r.range(0.82, 1.15);
    const cx = W * (0.06 + 0.88 * u) + r.signed() * W * 0.018;
    const cy = baseY - rad * r.range(form.rise[0], form.rise[1]);
    path.moveTo(cx + rad, cy);
    path.arc(cx, cy, rad, 0, Math.PI * 2);
  }
  // A slab along the base welds the lobes into one mass and flattens the
  // underside. All subpaths wind the same way, so a nonzero fill is their union.
  path.rect(W * 0.04, baseY - H * form.slab, W * 0.92, H * form.slab);

  // 0. the ink contour: the silhouette dilated by a ring of offset stamps.
  const inkW = CLOUD_INK[form.ink]!;
  ctx.fillStyle = ENC_INK;
  for (let i = 0; i < CLOUD_INK_STEPS; i++) {
    const a = (i / CLOUD_INK_STEPS) * Math.PI * 2;
    ctx.save();
    ctx.translate(Math.cos(a) * inkW, Math.sin(a) * inkW);
    ctx.fill(path);
    ctx.restore();
  }

  // 1. whole silhouette = shaded underside tone.
  ctx.fillStyle = ENC_SHADE;
  ctx.fill(path);

  const shadeH = H * form.shadeH;   // how far the underside shadow climbs
  const rimW = H * form.rimW;       // rim ribbon thickness
  const big = CLOUD_CELL_W * 3;

  ctx.save();
  ctx.clip(path);

  // 2. silhouette minus a bottom band of shadeH = rim tone.
  ctx.save();
  ctx.translate(0, -shadeH);
  ctx.clip(path);
  ctx.translate(0, shadeH);
  ctx.fillStyle = ENC_RIM;
  ctx.fillRect(-big, -big, big * 3, big * 3);

  // 3. that, minus a top band of rimW = lit body. The rim survives as a ribbon
  //    that follows the bumpy top contour instead of running straight across it.
  ctx.save();
  ctx.translate(0, rimW);
  ctx.clip(path);
  ctx.translate(0, -rimW);
  ctx.fillStyle = ENC_LIT;
  ctx.fillRect(-big, -big, big * 3, big * 3);
  ctx.restore();
  ctx.restore();

  // 4. fold shadows scalloping up out of the underside band, and one larger
  //    shaped mass on the shadow side. These are what stop the lit body reading
  //    as one dead flat blob with a grey stripe under it.
  ctx.fillStyle = ENC_SHADE;
  const folds = form.folds[0] + r.int(0, form.folds[1] - form.folds[0]);
  for (let i = 0; i < folds; i++) {
    const fr = H * r.range(0.13, 0.24) * (form.radBase * 4.0);
    const fx = W * r.range(0.14, 0.86);
    const fy = baseY - H * r.range(0.03, 0.20) * (form.slab * 7.0);
    ctx.beginPath();
    ctx.arc(fx, fy, fr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.restore();
}

function makeCloudAtlas(r: Rng): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = CLOUD_CELL_W * CLOUD_COLS;
  cv.height = CLOUD_CELL_H * CLOUD_ROWS;
  const ctx = cv.getContext('2d', { willReadFrequently: false })!;
  ctx.clearRect(0, 0, cv.width, cv.height);

  for (let row = 0; row < CLOUD_ROWS; row++) {
    const form = CLOUD_FORMS[row]!;
    for (let col = 0; col < CLOUD_COLS; col++) {
      drawCloudCell(ctx, col * CLOUD_CELL_W, row * CLOUD_CELL_H, r, form);
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  // NoColorSpace: this is a channel mask, not an image. Running it through the
  // sRGB decode would gamma-mangle the mask thresholds.
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------ flare build ---

interface FlarePiece {
  alpha: number;
  /** 0 = sun core white, 1 = sun glow gold. */
  tint: number;
  shimPhase: number;
  shimAmt: number;
}

/** Scratch accumulator for the burst's interleaved vertex data. */
class FlareBuild {
  readonly pos: number[] = [];    // vec3, z always 0
  readonly data: number[] = [];   // vec3
  readonly misc: number[] = [];   // vec2
  readonly index: number[] = [];
  count = 0;

  vertex(x: number, y: number, edge: number, p: FlarePiece): void {
    this.pos.push(x, y, 0);
    this.data.push(p.alpha, p.tint, edge);
    this.misc.push(p.shimPhase, p.shimAmt);
    this.count++;
  }
}

/**
 * A radiating ray: widest at its base, tapering with straight sides to a point.
 * Four vertices, two triangles - a base edge split at its midpoint so the
 * midpoint and the tip can both carry edge = 1 while the two base corners carry
 * edge = 0. The fragment shader cuts that interpolant into a hard-edged wedge
 * with a hotter spine running down its centre.
 *
 * IT IS BUILT AS A TRIANGLE AND NOT AS A DIAMOND, and that is the whole shape.
 * A diamond - base on the axis, widest a quarter of the way out, tapering to a
 * point - is what a soft photographic streak is, and cut hard it stops reading
 * as a ray at all: the bulge dominates and each one lands as a white leaf
 * floating near the sun. A wedge that is widest where it leaves the disc and
 * narrows all the way out is how a burst is actually drawn.
 *
 * rIn sits well inside the painted corona, so a ray is already tapering by the
 * time it emerges from behind the halo and never shows a blunt end.
 */
function pushRay(
  b: FlareBuild,
  angle: number,
  rIn: number,
  rOut: number,
  halfWidth: number,
  p: FlarePiece
): void {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  // base-left, base-centre (spine), base-right, tip (spine).
  const xs = [rIn, rIn, rIn, rOut];
  const ys = [halfWidth, 0, -halfWidth, 0];
  const edges = [0, 1, 0, 1];
  const base = b.count;
  for (let i = 0; i < 4; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    b.vertex(x * ca - y * sa, x * sa + y * ca, edges[i]!, p);
  }
  b.index.push(base, base + 1, base + 3, base + 1, base + 2, base + 3);
}

/**
 * The burst's shapes, in screen units (1.0 = half the frame height).
 *
 * Six rays at 60-degree spacing with alternating lengths - the pair on the
 * sun-to-centre axis longest, so the ornament has a clear direction. Straight
 * edges, flat fills, no falloff.
 *
 * WHAT WAS DELETED AND WHY. This used to also emit two hexagonal ghosts riding
 * the sun-to-centre axis. They are gone, and the hexagon SDF in the fragment
 * shader with them. They were the single most photographic thing in the frame:
 * in the reference capture one landed as a flat dull-purple hexagon floating in
 * open sky and the other as a large pale hexagonal outline lying across the
 * horizon and the gate banner, where it read as a render bug rather than as
 * light. They could not be tuned out either - a hexagon is an artefact of a
 * physical iris diaphragm, which this game does not have and does not draw, and
 * additive gold over saturated cobalt can only ever desaturate toward lavender.
 * Removing them costs 2 quads / 4 triangles / 8 vertices and no draw call.
 *
 * The rays that remain are re-tuned for the hard mask that replaced the feather:
 * shorter (the longest is 0.34 against a corona that measures ~0.15-0.20 screen
 * units, so roughly two disc-radii rather than four), wider, and at much higher
 * alpha. A soft ray had to stay faint to hide its own feather; a cut one does
 * not, and a decisive white-hot ray is what stops the burst drifting to lavender.
 */
function buildFlareGeometry(): THREE.BufferGeometry {
  const b = new FlareBuild();

  // Lengths are set against the corona, which measures ~0.15 screen units on the
  // horizon rig and ~0.20 on the 58-degree racing rigs: the long pair reaches
  // about 2.7 halo-radii, the short pair barely clears it. Everything is quoted
  // from the sun's CENTRE, so the visible part of a ray is what is left after the
  // halo covers the first ~0.15-0.20 of it.
  const rayLengths = [0.42, 0.26, 0.33, 0.42, 0.26, 0.33];
  // Thin. The disc is the drawing and the rays are the accent, not the other way
  // round: at 0.032 the wedges were wider than the core itself and, being
  // additive, simply whited the gold corona out from the inside.
  const rayWidths = [0.020, 0.013, 0.016, 0.020, 0.013, 0.016];
  const rayAlpha = [0.80, 0.48, 0.62, 0.80, 0.48, 0.62];
  // Pulled toward the core cream. Gold-dominant rays were what desaturated to
  // lavender against the cobalt sky; cream-dominant ones read as hot light.
  const rayTint = [0.10, 0.52, 0.34, 0.10, 0.52, 0.34];

  for (let i = 0; i < 6; i++) {
    // Base at 0.055, i.e. between the core disc (0.041 screen units on the
    // horizon rig) and ring 1 (0.059) - far enough out that the wedge's blunt
    // base is buried inside the painted corona, close enough that no gap can
    // open between the disc and the rays leaving it.
    pushRay(b, (i * Math.PI) / 3, 0.055, rayLengths[i]!, rayWidths[i]!, {
      alpha: rayAlpha[i]!,
      tint: rayTint[i]!,
      // Phases spread over the circle so the six never pulse in unison.
      shimPhase: i * 1.05,
      // Smaller than it was: scaling a hard-edged shape is far more visible
      // than scaling a feathered one, and a burst that throbs reads as a bloom.
      shimAmt: 0.06 + (i % 3) * 0.02,
    });
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('aData', new THREE.Float32BufferAttribute(b.data, 3));
  g.setAttribute('aMisc', new THREE.Float32BufferAttribute(b.misc, 2));
  g.setIndex(b.index);
  // The vertex shader writes clip space directly, so the geometry's own bounds
  // are meaningless. Give it one big enough that nothing ever culls it.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

// ------------------------------------------------------------- cloud field --

interface CloudShell {
  radius: number;
  count: number;
  /** Base angular drift rate, rad/s. */
  omega: number;
  /** Atlas row, i.e. which silhouette family this shell is built from. */
  row: number;
  /** Elevation band, radians. This is what decides where in frame it lands. */
  elev: [number, number];
  /** Angular width at the shell radius, as a fraction of the radius. */
  width: [number, number];
  /** Drawn height as a fraction of width. Flat forms get flat quads. */
  ratio: [number, number];
}

/**
 * Four camera-locked shells. The composition is authored by elevation band, not
 * by altitude: a painted sky is built from a low horizon layer that establishes
 * scale, a mid bank that carries the weather, and a few big near forms overhead.
 *
 * The 3100 m shell is the one doing new work - low, flat, numerous, sitting in
 * the two or three degrees directly above the waterline that were previously a
 * bald strip of empty blue across the right of every frame.
 */
const CLOUD_SHELLS: readonly CloudShell[] = [
  { radius: 3100, count: 26, omega: 0.0014, row: 2, elev: [0.010, 0.052], width: [0.100, 0.205], ratio: [0.34, 0.48] },
  { radius: 2750, count: 18, omega: 0.0028, row: 1, elev: [0.075, 0.200], width: [0.100, 0.220], ratio: [0.40, 0.54] },
  { radius: 1950, count: 14, omega: 0.0041, row: 1, elev: [0.130, 0.330], width: [0.120, 0.260], ratio: [0.46, 0.62] },
  { radius: 1300, count: 10, omega: 0.0060, row: 0, elev: [0.200, 0.460], width: [0.140, 0.300], ratio: [0.52, 0.72] },
];

/**
 * Drift sense, taken from the dominant swell so the sea and the sky agree about
 * which way the weather is running. The sign is the handedness of the swell
 * direction against the sun's azimuth - an arbitrary but deterministic and
 * palette-consistent choice, and it means changing the swell changes the sky.
 */
function driftSense(): number {
  const w0 = WAVES[0]!;
  const len = Math.hypot(w0.dirX, w0.dirZ) || 1;
  const sx = w0.dirX / len;
  const sz = w0.dirZ / len;
  return sx * SUN_DIR.z - sz * SUN_DIR.x >= 0 ? 1 : -1;
}

// -------------------------------------------------------------------- Sky ---

export class Sky {
  readonly group = new THREE.Group();

  private readonly domeMat: THREE.ShaderMaterial;
  private readonly cloudMat: THREE.ShaderMaterial;
  private readonly flareMat: THREE.ShaderMaterial;

  private readonly dome: THREE.Mesh;
  private readonly clouds: THREE.InstancedMesh;
  private readonly flare: THREE.Mesh;
  private readonly atlas: THREE.Texture;

  constructor(scene: THREE.Scene) {
    const r = rng.fork(7);
    this.group.name = 'sky';
    // Every shader here builds its own world position from `cameraPosition`, so
    // the group transform is never read. Freeze it to make that explicit.
    this.group.matrixAutoUpdate = false;

    // --- dome ---------------------------------------------------------------
    this.domeMat = new THREE.ShaderMaterial({
      name: 'SkyDome',
      glslVersion: THREE.GLSL3,
      lights: false,
      side: THREE.BackSide,
      // No depth write: the sky is a backdrop, everything else draws over it.
      // Depth *test* stays on so it still respects an already-cleared buffer.
      depthWrite: false,
      depthTest: true,
      fog: false,
      uniforms: {
        uZenith: { value: PALETTE.skyZenith.clone() },
        uMid: { value: PALETTE.skyMid.clone() },
        uHorizon: { value: PALETTE.skyHorizon.clone() },
        uHazeLift: { value: PALETTE.foam.clone() },
        uUnderHaze: { value: PALETTE.waterShallow.clone() },
        uSunDir: { value: SUN_DIR.clone() },
        uSunCore: { value: PALETTE.sunCore.clone() },
        uSunGlow: { value: PALETTE.sunGlow.clone() },
        uCameraFar: { value: CAMERA_FAR },
        uTime: { value: 0 },
      },
      vertexShader: SKY_DOME_VERT,
      fragmentShader: SKY_DOME_FRAG,
    });

    // 48 x 32 segments: the band edges are functions of the interpolated view
    // direction, and this is fine enough that the chord error across a face
    // moves a band edge by well under a hundredth of a degree.
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 48, 32), this.domeMat);
    this.dome.name = 'skyDome';
    this.dome.frustumCulled = false;   // it is centred on the camera, not on its matrix
    this.dome.renderOrder = -10000;    // first opaque object drawn, always
    this.dome.matrixAutoUpdate = false;
    this.group.add(this.dome);

    // --- clouds -------------------------------------------------------------
    this.atlas = makeCloudAtlas(r.fork(1));

    const total = CLOUD_SHELLS.reduce((s, c) => s + c.count, 0);
    const cloudGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
    const orbit = new Float32Array(total * 4);
    const style = new Float32Array(total * 4);

    this.cloudMat = new THREE.ShaderMaterial({
      name: 'SkyClouds',
      glslVersion: THREE.GLSL3,
      lights: false,
      side: THREE.DoubleSide,
      transparent: true,
      // Alpha is near-binary (a one-to-two pixel AA edge and nothing else), so
      // writing depth is safe - and it is what makes cloud-over-cloud occlusion
      // correct without sorting instances, which an InstancedMesh cannot do.
      depthWrite: true,
      depthTest: true,
      fog: false,
      uniforms: {
        uAtlas: { value: this.atlas },
        uLit: { value: PALETTE.cloudLit.clone() },
        uShade: { value: PALETTE.cloudShade.clone() },
        // cloudRim on its own is a pale cream, and a pale cream ribbon against a
        // frame whose hulls and banners run at full saturation reads as dirt, not
        // as sunlight. Carrying it most of the way to the sun's own gold puts it
        // back in the same key as everything else it is supposed to be lit by.
        uRimColor: { value: PALETTE.cloudRim.clone().lerp(PALETTE.sunGlow, 0.58) },
        uInk: { value: PALETTE.ink.clone() },
        uAtlasTexels: { value: CLOUD_CELL_W * CLOUD_COLS },
        uHaze: { value: PALETTE.skyHorizon.clone() },
        uSunDir: { value: SUN_DIR.clone() },
        uCellSize: { value: new THREE.Vector2(1 / CLOUD_COLS, 1 / CLOUD_ROWS) },
        uOpacity: { value: 1 },
        uCameraFar: { value: CAMERA_FAR },
        uTime: { value: 0 },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
    });

    this.clouds = new THREE.InstancedMesh(cloudGeo, this.cloudMat, total);
    this.clouds.name = 'skyClouds';
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = 10;
    this.clouds.matrixAutoUpdate = false;
    this.clouds.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const sense = driftSense();
    const m = new THREE.Matrix4();
    let i = 0;
    // Shells are filled far-to-near so the instance order is already roughly
    // back-to-front, which keeps the AA edges tidy where cards overlap.
    for (const shell of CLOUD_SHELLS) {
      for (let k = 0; k < shell.count; k++) {
        // Elevation, not altitude, is the authored quantity: it is what decides
        // where the cloud sits in frame. Each shell owns its own band, so the
        // sky is composed in layers instead of one uniform scatter.
        const elev = r.range(shell.elev[0], shell.elev[1]);
        const altitude = shell.radius * Math.tan(elev);

        // Even azimuthal spread with jitter - a purely random azimuth clumps
        // badly at only ten to twenty-six instances per shell.
        const azimuth = ((k + 0.5) / shell.count) * Math.PI * 2 + r.signed() * 0.16;
        const omega = sense * shell.omega * r.range(0.82, 1.20);

        // The quad's aspect is authored per shell rather than inherited from the
        // 2:1 atlas cell, which is what lets the horizon shell read as long flat
        // streaks and the near shell as tall heaped cumulus from the same atlas.
        const width = shell.radius * r.range(shell.width[0], shell.width[1]);
        const height = width * r.range(shell.ratio[0], shell.ratio[1]);

        orbit[i * 4 + 0] = shell.radius;
        orbit[i * 4 + 1] = altitude;
        orbit[i * 4 + 2] = azimuth;
        orbit[i * 4 + 3] = omega;

        const col = r.int(0, CLOUD_COLS - 1);
        const row = shell.row;
        // CanvasTexture flips on upload, so canvas row `row` occupies the v range
        // starting at 1 - (row + 1) / ROWS.
        style[i * 4 + 0] = col / CLOUD_COLS;
        style[i * 4 + 1] = 1 - (row + 1) / CLOUD_ROWS;
        style[i * 4 + 2] = r.next();               // tint toward the horizon colour
        style[i * 4 + 3] = r.next() < 0.5 ? -1 : 1; // horizontal mirror

        m.makeScale(width, height, 1);
        this.clouds.setMatrixAt(i, m);
        i++;
      }
    }
    this.clouds.instanceMatrix.needsUpdate = true;
    cloudGeo.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(orbit, 4));
    cloudGeo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(style, 4));
    this.group.add(this.clouds);

    // --- flare --------------------------------------------------------------
    this.flareMat = new THREE.ShaderMaterial({
      name: 'SkyFlare',
      glslVersion: THREE.GLSL3,
      lights: false,
      side: THREE.DoubleSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // An ornament stamped over the frame: it is not in the world and must not
      // be occluded by it.
      depthTest: false,
      fog: false,
      uniforms: {
        uSunDir: { value: SUN_DIR.clone() },
        uCore: { value: PALETTE.sunCore.clone() },
        uGlow: { value: PALETTE.sunGlow.clone() },
        uOpacity: { value: 1 },
        uCameraFar: { value: CAMERA_FAR },
        uTime: { value: 0 },
      },
      vertexShader: FLARE_VERT,
      fragmentShader: FLARE_FRAG,
    });

    this.flare = new THREE.Mesh(buildFlareGeometry(), this.flareMat);
    this.flare.name = 'sunFlare';
    this.flare.frustumCulled = false;
    this.flare.renderOrder = 3000;   // after every other transparent object
    this.flare.matrixAutoUpdate = false;
    this.group.add(this.flare);

    scene.add(this.group);
  }

  /**
   * Everything the sky animates is a function of `elapsed`, so the whole
   * subsystem is one uniform write per material - no allocation, no traversal,
   * and byte-identical frames for a given (seed, time) pair.
   */
  update(_dt: number, elapsed: number): void {
    this.domeMat.uniforms.uTime!.value = elapsed;
    this.cloudMat.uniforms.uTime!.value = elapsed;
    this.flareMat.uniforms.uTime!.value = elapsed;
  }

  /** Global dimmer for the flare - for the results screen or a cinematic. */
  setFlareOpacity(v: number): void {
    this.flareMat.uniforms.uOpacity!.value = v;
  }

  /** Global dimmer for the cloud layer. */
  setCloudOpacity(v: number): void {
    this.cloudMat.uniforms.uOpacity!.value = v;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.dome.geometry.dispose();
    this.clouds.geometry.dispose();
    this.clouds.dispose();
    this.flare.geometry.dispose();
    this.domeMat.dispose();
    this.cloudMat.dispose();
    this.flareMat.dispose();
    this.atlas.dispose();
  }
}
