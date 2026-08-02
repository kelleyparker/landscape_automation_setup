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
 *   3. `flare`  - a screen-space ornament: six radiating spikes and two
 *                 hard-edged hexagonal ghosts, anchored by projecting SUN_DIR to
 *                 NDC every frame. Additive, no depth test, drawn last.
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
const CLOUD_ROWS = 2;
// Cells are 2:1, not square. A cumulus drawn from discs on a flat base is about
// three times as wide as it is tall, so a square cell would throw away well over
// half its texels and force the lobes small enough to read as bubbles.
const CLOUD_CELL_W = 256;
const CLOUD_CELL_H = 128;

/**
 * Channel encodings for the cloud alphabet. These are NOT colours - the atlas is
 * a four-channel mask (R = lit body, G = rim ribbon, B = shaded underside,
 * A = silhouette) and every actual colour is a palette uniform in the shader.
 * That is why no sky colour is ever baked into a canvas in this file.
 */
const ENC_LIT = 'rgb(255,0,0)';
const ENC_RIM = 'rgb(0,255,0)';
const ENC_SHADE = 'rgb(0,0,255)';

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
 */
function drawCloudCell(ctx: CanvasRenderingContext2D, x0: number, y0: number, r: Rng): void {
  // Padding keeps the drawing clear of the cell border so mip levels do not
  // bleed one cloud into its neighbour.
  const pad = CLOUD_CELL_H * 0.06;
  const W = CLOUD_CELL_W - pad * 2;
  const H = CLOUD_CELL_H - pad * 2;

  ctx.save();
  ctx.translate(x0 + pad, y0 + pad);

  const path = new Path2D();
  const lobes = 7 + r.int(0, 4);
  const baseY = H * 0.88;

  for (let i = 0; i < lobes; i++) {
    const u = (i + 0.5) / lobes;
    // A flattened sine envelope gives the mass its hump. The exponent below 1
    // keeps the shoulders full - a pure sine reads as an arch, not a cloud.
    const env = Math.pow(Math.sin(u * Math.PI), 0.62);
    // Radii scale with cell *height*, so the tallest lobe reaches roughly the
    // top of the cell and no lobe is ever wide enough to run off the sides.
    const rad = H * (0.13 + 0.30 * env) * r.range(0.82, 1.15);
    const cx = W * (0.08 + 0.84 * u) + r.signed() * W * 0.015;
    const cy = baseY - rad * r.range(0.45, 0.95);
    path.moveTo(cx + rad, cy);
    path.arc(cx, cy, rad, 0, Math.PI * 2);
  }
  // A slab along the base welds the lobes into one mass and flattens the
  // underside. All subpaths wind the same way, so a nonzero fill is their union.
  path.rect(W * 0.05, baseY - H * 0.14, W * 0.90, H * 0.14);

  // 1. whole silhouette = shaded underside tone.
  ctx.fillStyle = ENC_SHADE;
  ctx.fill(path);

  const shadeH = H * 0.17;   // how far the underside shadow climbs
  const rimW = H * 0.075;    // rim ribbon thickness
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

  // 4. two or three fold shadows scalloping up out of the underside band. These
  //    are what stop the lit body reading as one dead flat blob.
  ctx.fillStyle = ENC_SHADE;
  const folds = 2 + r.int(0, 1);
  for (let i = 0; i < folds; i++) {
    const fr = H * r.range(0.11, 0.20);
    const fx = W * r.range(0.18, 0.82);
    const fy = baseY - H * r.range(0.05, 0.16);
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
    for (let col = 0; col < CLOUD_COLS; col++) {
      drawCloudCell(ctx, col * CLOUD_CELL_W, row * CLOUD_CELL_H, r);
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
  /** 0 at the sun, 1 at the frame centre, > 1 past it. */
  anchor: number;
  alpha: number;
  /** 0 = sun core white, 1 = sun glow gold. */
  tint: number;
  /** 0 spike, 1 solid hexagon, 2 hexagon ring. */
  kind: number;
  /** Inner/outer radius ratio, ring only. */
  ring: number;
  shimPhase: number;
  shimAmt: number;
}

/** Scratch accumulator for the flare's interleaved vertex data. */
class FlareBuild {
  readonly pos: number[] = [];    // vec3, z always 0
  readonly local: number[] = [];  // vec2
  readonly data: number[] = [];   // vec4
  readonly misc: number[] = [];   // vec4
  readonly index: number[] = [];
  count = 0;

  vertex(x: number, y: number, lx: number, ly: number, edge: number, p: FlarePiece): void {
    this.pos.push(x, y, 0);
    this.local.push(lx, ly);
    this.data.push(p.anchor, p.alpha, p.tint, edge);
    this.misc.push(p.kind, p.ring, p.shimPhase, p.shimAmt);
    this.count++;
  }
}

/**
 * A radiating spike, built as a long thin diamond: base on the axis, widest a
 * quarter of the way out, tapering to a point. The two on-axis vertices carry
 * edge = 1 and the two flanks edge = 0, which the fragment shader turns into a
 * bright spine with a one-pixel feather at the flanks.
 */
function pushSpike(
  b: FlareBuild,
  angle: number,
  rIn: number,
  rOut: number,
  halfWidth: number,
  p: FlarePiece
): void {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const rMid = rIn + (rOut - rIn) * 0.26;
  const xs = [rIn, rMid, rOut, rMid];
  const ys = [0, halfWidth, 0, -halfWidth];
  const edges = [1, 0, 1, 0];
  const base = b.count;
  for (let i = 0; i < 4; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    b.vertex(x * ca - y * sa, x * sa + y * ca, 0, 0, edges[i]!, p);
  }
  b.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * A hexagonal ghost: a quad carrying a shape-local coordinate that the fragment
 * shader feeds to a hexagon SDF. Rotating the quad in flare space while leaving
 * the local coordinate alone is what rotates the hexagon.
 */
function pushGhost(b: FlareBuild, radius: number, rotation: number, p: FlarePiece): void {
  // 1.16 of the SDF's unit radius: room for the anti-aliasing band and for the
  // hexagon's corners, which reach further than its flats.
  const pad = 1.16;
  const cr = Math.cos(rotation);
  const sr = Math.sin(rotation);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const base = b.count;
  for (const c of corners) {
    const lx = c[0]! * pad;
    const ly = c[1]! * pad;
    const px = lx * radius;
    const py = ly * radius;
    b.vertex(px * cr - py * sr, px * sr + py * cr, lx, ly, 1, p);
  }
  b.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * The flare's shapes, in screen units (1.0 = half the frame height).
 *
 * Six spikes at 60-degree spacing with alternating lengths - the pair on the
 * sun-to-centre axis longest, so the ornament has a clear direction - plus one
 * solid hexagon just inside the frame centre and one hexagon ring past it. The
 * whole set is graphic by construction: straight edges, flat fills, no falloff.
 */
function buildFlareGeometry(): THREE.BufferGeometry {
  const b = new FlareBuild();

  const spikeLengths = [0.62, 0.30, 0.42, 0.62, 0.30, 0.42];
  const spikeWidths = [0.013, 0.008, 0.010, 0.013, 0.008, 0.010];
  const spikeAlpha = [0.55, 0.30, 0.38, 0.55, 0.30, 0.38];
  const spikeTint = [0.18, 0.85, 0.62, 0.18, 0.85, 0.62];

  for (let i = 0; i < 6; i++) {
    pushSpike(b, (i * Math.PI) / 3, 0.035, spikeLengths[i]!, spikeWidths[i]!, {
      anchor: 0,
      alpha: spikeAlpha[i]!,
      tint: spikeTint[i]!,
      kind: 0,
      ring: 1,
      // Phases spread over the circle so the six never pulse in unison.
      shimPhase: i * 1.05,
      shimAmt: 0.10 + (i % 3) * 0.035,
    });
  }

  pushGhost(b, 0.075, 0.22, {
    anchor: 0.45, alpha: 0.24, tint: 1.0, kind: 1, ring: 1,
    shimPhase: 2.4, shimAmt: 0.045,
  });
  pushGhost(b, 0.130, -0.14, {
    anchor: 1.25, alpha: 0.30, tint: 1.0, kind: 2, ring: 0.74,
    shimPhase: 4.1, shimAmt: 0.035,
  });

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('aLocal', new THREE.Float32BufferAttribute(b.local, 2));
  g.setAttribute('aData', new THREE.Float32BufferAttribute(b.data, 4));
  g.setAttribute('aMisc', new THREE.Float32BufferAttribute(b.misc, 4));
  g.setIndex(b.index);
  // The vertex shader writes clip space directly, so the geometry's own bounds
  // are meaningless. Give it one big enough that nothing ever culls it.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

// ------------------------------------------------------------- cloud field --

/** Radius, instance count and base angular drift rate for each cloud shell. */
const CLOUD_SHELLS: readonly { radius: number; count: number; omega: number }[] = [
  { radius: 2750, count: 20, omega: 0.0028 },
  { radius: 1950, count: 16, omega: 0.0041 },
  { radius: 1300, count: 12, omega: 0.0060 },
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
        uRimColor: { value: PALETTE.cloudRim.clone() },
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
        // where the cloud sits in frame. 4 to 24 degrees keeps the band in the
        // upper third of a horizon-facing shot (whose top edge is around 20
        // degrees) and leaves the zenith clear, the way a painted sky is built.
        const elev = r.range(0.070, 0.42);
        const altitude = shell.radius * Math.tan(elev);

        // Even azimuthal spread with jitter - a purely random azimuth clumps
        // badly at only twelve to twenty instances per shell.
        const azimuth = ((k + 0.5) / shell.count) * Math.PI * 2 + r.signed() * 0.16;
        const omega = sense * shell.omega * r.range(0.82, 1.20);

        // Angular width of 6 to 17 degrees at the shell's radius. The quad's
        // aspect matches the 2:1 atlas cell, inside which the drawing fills
        // about 70% of the height - so on screen a cloud reads about 3:1.
        const width = shell.radius * r.range(0.10, 0.30);
        const height = width * 0.5 * r.range(0.85, 1.20);

        orbit[i * 4 + 0] = shell.radius;
        orbit[i * 4 + 1] = altitude;
        orbit[i * 4 + 2] = azimuth;
        orbit[i * 4 + 3] = omega;

        const col = r.int(0, CLOUD_COLS - 1);
        const row = r.int(0, CLOUD_ROWS - 1);
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
