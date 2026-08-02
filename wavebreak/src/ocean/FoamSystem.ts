import * as THREE from 'three';
import { PALETTE, SUN_DIR } from '../core/Palette';
import { rng, Rng } from '../core/Rng';
import { sampleHeight, sampleSurface, type SurfaceSample } from './GerstnerCPU';
import { WAKE_VERT, WAKE_FRAG, SPRAY_VERT, SPRAY_FRAG } from './shaders/foamShaders';

/**
 * WAVEBREAK whitewater: persistent wake ribbons and ballistic spray.
 *
 * Foam is what sells stylised water, so none of this is a decal. There are two
 * mechanisms and they do different jobs:
 *
 *  1. **Wake ribbons** - one per racer, a rolling history of spine points laid
 *     down behind the hull at a fixed *spatial* interval (not a fixed frame
 *     interval, or the trail would change shape with the frame rate). The
 *     ribbon spreads from the boat's beam to five times it, masks itself with an
 *     analytic blob field keyed off absolute world metres, and dissipates by
 *     eroding - hollowing out along its centreline into two Kelvin arms of
 *     broken islands - before it fades.
 *
 *     Every spine point is re-sampled against the ocean surface every frame,
 *     and every *lip* of every wide point is sampled independently. This is the
 *     expensive part and it is not optional: the swell here reaches nearly 3 m
 *     peak-to-trough, and a ribbon laid flat at the height it was emitted at
 *     would spend most of its life buried in one wave and floating a metre above
 *     the next. Cost is roughly 1.2 ms/frame for four full-length ribbons (528
 *     `sampleSurface` plus about 900 cheaper `sampleHeight` calls) on an
 *     M-series core - under 8% of the 16.7 ms budget, spent on the single most
 *     visible surface in the game.
 *
 *     The spine uses `sampleSurface` because it returns the analytic normal and
 *     the crest Jacobian in the same solve, and the shader needs both. The lips
 *     use `sampleHeight`, which skips the normal. Deriving the lip heights from
 *     the spine's tangent plane instead - which is what this used to do - is a
 *     first-order fit, and over the 5 m half-width of a fully spread segment it
 *     is wrong by more than the entire amplitude of the chop layers. That is
 *     what made the wide tail knife through the swell and read as a decal.
 *
 *  2. **Spray particles** - one shared pool for all four boats, ballistic with
 *     gravity and drag, dying on contact with the water with a brief flattening
 *     splat. Drawn teardrops aimed down their own velocity, not soft sprites:
 *     fading is by shrinking and by stepping down through three flat alpha
 *     plateaus, and the palette is foam white to crest cyan and nothing else.
 *
 * Everything is preallocated. `update()` performs no allocation, geometry is
 * never rebuilt, and the whole system is four ribbon draws plus one instanced
 * spray draw. All randomness comes from a fork of the seeded global RNG, so a
 * given seed reproduces the exact same foam.
 */

// ---------------------------------------------------------------- config -----

/** Must match the PerspectiveCamera far plane in core/Engine.ts. */
const CAMERA_FAR = 4200;

const RACER_COUNT = 4;

/**
 * Spine points per ribbon. 132 points at 0.90 m is a 119 m trail, which is very
 * close to four seconds of ribbon at racing speed - so capacity and lifetime run
 * out at about the same moment and neither one visibly truncates the other.
 *
 * The spacing was 0.62 m over 192 points for the same trail length. It was
 * loosened to pay for the lip sampling in `update()` below: a 0.90 m chord is
 * still eight segments across the shortest chop wavelength in `waveConfig`,
 * whereas guessing the lip height from the spine's tangent plane was wrong by
 * decimetres on every wide segment.
 */
const WAKE_MAX_POINTS = 132;
/** Emission is throttled by distance, never by frame count. */
const WAKE_MIN_SPACING = 0.90;
/**
 * Extra points are inserted when a frame covers more than one spacing (a 50 ms
 * dt at 30 m/s is 1.5 m), so the ribbon keeps a regular tessellation instead of
 * developing long facets whenever the frame rate dips.
 */
const WAKE_MAX_INSERTS = 3;
/**
 * A heading change this large forces a point even inside the distance
 * threshold. Without it a hard turn is cut by 0.62 m chords and the ribbon's
 * inside edge visibly corners.
 */
const WAKE_TURN_STEP = 0.10;
/**
 * Seconds a spine point survives. The brief is a wake that is gone in three to
 * four seconds; the shader holds full opacity to 86% of this and the erosion
 * has already broken the tail into islands well before that, so the last of a
 * ribbon leaves the frame at about 3.4 s and nothing is left at 4.
 */
const WAKE_LIFE = 4.0;
/**
 * Half-width multiplier at end of life. A wake opens hard in its first second,
 * then keeps opening slowly - roughly 1.6x in the first second and 5.4x by the
 * time the tail has eroded away, which is the divergent V a hull actually
 * leaves. The shader's centreline erosion works with this: the band widens
 * while its middle hollows out, so the far end is two arms of broken islands
 * rather than a stripe.
 */
const WAKE_SPREAD = 5.4;
/**
 * Lift above the sampled surface, in metres. Together with the polygon offset
 * this keeps the ribbon clear of the ocean mesh without reading as a hovering
 * sheet - 8.5 cm is an eighth of the smallest chop amplitude. It went up from
 * 6 cm when the lips started being sampled independently: a lip now sits on its
 * own patch of water rather than on a chord through the spine, so the ribbon
 * follows the surface far more closely and needs slightly more clearance before
 * the polygon offset has to save it.
 */
const WAKE_LIFT = 0.085;

/**
 * Half-width, in metres, above which a spine point stops trusting the tangent
 * plane through its own spine sample and samples the ocean under each lip
 * directly.
 *
 * The tangent plane is a first-order fit. Over the 0.9 m half-width of a fresh
 * segment it is accurate to a centimetre or two; over the 5 m half-width of a
 * fully spread one it is out by more than the whole 8.7 m and 4.9 m chop
 * layers, which is why the old ribbon knifed straight through the swell and the
 * critics read it as a decal. Two extra `sampleHeight` calls per wide point buy
 * a ribbon that actually drapes. `sampleHeight` skips the normal solve, so the
 * marginal cost is well under one full `sampleSurface`.
 */
const WAKE_LIP_SAMPLE_HW = 0.85;

/**
 * Foam drift, in periods/second, for the two octaves of the analytic blob field.
 *
 * These are deliberately slow. The mask is keyed off absolute world metres -
 * wake foam is left behind *in the water* and the boat drives away from it -
 * so this is not the foam moving past the camera, it is the slow boil of the
 * whitewater itself. Anything faster and the shapes crawl.
 *
 * The field is periodic on the shader's NOISE_PERIOD lattice, so the offsets
 * wrap at 1.0 with no discontinuity at all.
 */
const WAKE_SCROLL_A = 0.012;
const WAKE_SCROLL_B = 0.021;

/**
 * Arc length is monotonic and unbounded, so it is rebased once it passes this.
 * It now only drives the cross-wake arc pattern rather than a texture lookup,
 * and the rebase is an exact whole number of arc periods (2*pi / 1.35 m, the
 * shader's arc frequency), so the pattern is continuous across the shift. The
 * bound keeps float32 arc length precise to a quarter of a millimetre.
 */
const WAKE_ARC_PERIOD = (Math.PI * 2) / 1.35;
const WAKE_REBASE_DIST = WAKE_ARC_PERIOD * 512;

/** How long after the last emit a boat keeps driving an ocean interactor ring. */
const INTERACTOR_HOLD = 0.35;

const SPRAY_POOL = 600;
/** Arcade gravity. Heavier than 9.81 so droplets arc rather than float. */
const SPRAY_GRAVITY = -19.0;
/** Exponential velocity decay per second. */
const SPRAY_DRAG = 1.15;
/**
 * Seconds the flattened splat lingers after the droplet hits the water.
 *
 * Short on purpose. Spray reads as spray because it is *leaving* an impact; a
 * droplet that sits flat on the surface for a fifth of a second reads as debris
 * floating on the water, and at any given moment most of the pool was in that
 * state. An eighth of a second is enough to register the mark being made.
 */
const SPRAY_SPLAT_LIFE = 0.07;
/** Splat sits this far above the surface so it never z-fights the ocean. */
const SPRAY_SPLAT_LIFT = 0.045;
/** Particles requested per unit of `amount` passed to emitSpray. */
const SPRAY_PER_AMOUNT = 8;
/** Hard cap on one burst, so a bad caller cannot drain the pool in a frame. */
const SPRAY_MAX_BURST = 26;
/** Half-angle of the emission cone, as a lateral fraction of the supplied dir. */
const SPRAY_CONE = 0.42;
/**
 * Metres the spawn point is pushed along the launch direction, away from the
 * emitter.
 *
 * Droplets used to be born inside the hull that threw them: with depth testing
 * on and the pool spread over a 44 cm cube centred on the emit point, roughly
 * half of every burst spawned in front of the deck and covered it. Launching
 * from clear of the hull and shrinking the droplets (below) means spray now
 * breaks *against* the hull sides instead of over the rider.
 */
const SPRAY_SPAWN_PUSH = 0.34;

/**
 * Water-height cache policy for airborne droplets.
 *
 * Sampling the surface under all 600 particles every frame costs about 0.5 ms,
 * which is not worth spending on a test that only matters at the instant of
 * impact. Instead each droplet caches the height beneath it and refreshes when
 * the cache is stale *or* when it is within NEAR of the cached surface. The
 * second clause is what keeps this exact: any droplet close enough for the
 * collision to fire is sampling live, every frame, and 0.45 m is two to three
 * frames of fall at terminal spray speed. High droplets tolerate up to 45 ms of
 * staleness, during which the swell moves at most ~5 cm and they are nowhere
 * near hitting anything.
 *
 * Each droplet gets its own interval inside [MIN, MAX] rather than a shared
 * constant. A burst spawns forty particles on one frame; with a single interval
 * all forty would refresh on the same frame forever after, turning a smooth
 * average cost into a periodic spike.
 */
const SPRAY_H_REFRESH_MIN = 0.026;
const SPRAY_H_REFRESH_MAX = 0.045;
const SPRAY_H_NEAR = 0.45;

/** Spray states. */
const FLYING = 0;
const SPLAT = 1;

// --------------------------------------------------------------- scratch -----
// Module scope. Nothing below may allocate during update() or emit*().

const _surf: SurfaceSample = { height: 0, normal: new THREE.Vector3(0, 1, 0), jacobian: 1 };
const _dir = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _box = new THREE.Box3();
const _white = new THREE.Color(1, 1, 1);
const _tint = new THREE.Color();

/**
 * The contour tone for every drawn foam silhouette, and the shadow floor for a
 * droplet's rim.
 *
 * Explicitly *not* PALETTE.ink. Foam is a saturated white mass covering a large
 * part of the frame, and a true ink contour inside it punches holes that read as
 * missing geometry rather than as drawing. This is the deep-water blue lifted a
 * sixth of the way toward the foam shadow: a full step darker than anything
 * else in the ribbon, unmistakably a drawn line, and nowhere near zero luma.
 * Derived from the palette, not authored - no literal is introduced here.
 *
 * It moved down from a quarter. The contour's job is to separate the foam from
 * the water it is lying *in*, and a quarter of the way to the foam shadow put it
 * only about one value step under PALETTE.waterMid - so wherever a wake crossed
 * mid-blue water the line stopped reading and the mass came out as a cut-out
 * laid on the surface. A sixth clears the darkest water band the ribbon ever
 * crosses while staying an unambiguously saturated blue.
 */
const FOAM_EDGE = PALETTE.waterDeep.clone().lerp(PALETTE.foamShade, 0.16);

/**
 * How far a droplet's tint may travel from foam white toward crest cyan.
 *
 * Spray used to be tinted 32% toward the emitting racer's body colour, which
 * put coral, violet, tangerine and acid green into the whitewater - the salmon,
 * mauve-grey and mint shards reported across every frame. Whitewater is white;
 * the only variation it is allowed is a cool one, so the racer colour is now
 * ignored entirely and the droplet varies along foam-to-crest instead.
 *
 * A third of the way to crest cyan was still too far. Droplets drawn over the
 * wake ribbon - which is where nearly all of them are - came out visibly bluer
 * than the foam they sat on, so each one read as a separate pale object rather
 * than as a piece of the same water. 15% keeps them inside the ribbon's own two
 * tones and lets them vary without becoming bubbles stuck to the surface.
 */
const SPRAY_TINT_COOL = 0.15;

/**
 * The multiplier that carries foam white to crest cyan, so `_tint` can lerp
 * between identity and this and stay inside the palette by construction rather
 * than by a colour picked here.
 */
const SPRAY_COOL_MUL = new THREE.Color(
  PALETTE.waterCrest.r / Math.max(1e-3, PALETTE.foam.r),
  PALETTE.waterCrest.g / Math.max(1e-3, PALETTE.foam.g),
  PALETTE.waterCrest.b / Math.max(1e-3, PALETTE.foam.b),
);

/** Shortest signed angular difference, -pi..pi. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ------------------------------------------------------------ spray blob -----

/**
 * The droplet shape: a drawn teardrop, built as three concentric rings so the
 * shader's tone steps land exactly on triangle edges.
 *
 * The old shape was a three-lobe radial blob at 11 segments. On screen that is
 * a hard-edged pentagon or hexagon at an arbitrary rotation - which is exactly
 * what it was reported as - because a droplet only spans a few pixels and 11
 * segments of a lumpy radius is a polygon, not a curve.
 *
 * This is a teardrop instead: round head, tapered tail, pointed along local +Y,
 * at 20 segments so the head silhouette resolves as a curve at any size the
 * particle can reach. The vertex shader aims local +Y down the reverse of the
 * droplet's velocity, so the tail always streams behind - a comma, the way
 * spray is drawn - and the small asymmetry term stops eight droplets at eight
 * angles reading as one stamp repeated.
 *
 * `aRadial` is 0 at the centre and 1 at the rim; the ring radii below are the
 * constants R_CORE / R_BODY in the fragment shader.
 */
function makeSprayBlob(): THREE.BufferGeometry {
  const SEGMENTS = 20;
  // Ring radii, and therefore the tone boundaries. The contour band is the outer
  // 14% of the radius - because these rings are concentric, a wide concentric
  // band reads as a vignette where what is wanted is a drawn edge. On a droplet
  // only a few pixels across it drops below one fragment and the particle
  // correctly resolves to a solid chip.
  //
  // Pushed outward from [0.52, 0.86, 1.0]. With the shadow ring at just over
  // half the radius, half of every droplet was the cool tone and the outer
  // eighth was contour: on screen that is a pale ring round a lighter middle,
  // and two dozen of those at near-identical sizes read as clip-art bubbles
  // scattered over the wake. The droplet is now white out to 86% with a tenth
  // of the radius of cool step and a twentieth of contour - a drawn line on a
  // large droplet, nothing at all on a small one. These are the constants
  // R_CORE and R_BODY in the fragment shader and must move with them.
  const RINGS = [0.90, 0.96, 1.0];

  const vertCount = 1 + SEGMENTS * RINGS.length;
  const pos = new Float32Array(vertCount * 3);
  const radial = new Float32Array(vertCount);

  // Teardrop: full radius toward -Y (the head), tapering to ~0.2 toward +Y (the
  // tail). The cos(2th) term is a slight lateral fattening of the head and the
  // small phase-shifted term breaks the mirror symmetry into a comma.
  // Normalised so the maximum radius is exactly 1.0.
  const shape = (th: number): number =>
    (1 - 0.74 * Math.sin(th) + 0.10 * Math.cos(2 * th) + 0.07 * Math.sin(3 * th + 0.9)) / 1.70;

  // The teardrop's mass sits toward -Y, so the raw curve straddles the origin
  // badly. Shifting every ring by this *times its own radius* recentres the
  // silhouette while keeping the three rings exact scaled copies of each other
  // about the origin - which is what keeps the shader's tone steps on triangle
  // edges rather than cutting across them.
  const Y_SHIFT = 0.42;

  let v = 1; // vertex 0 is the centre, already (0,0,0) with radial 0
  for (let r = 0; r < RINGS.length; r++) {
    const rr = RINGS[r]!;
    for (let s = 0; s < SEGMENTS; s++) {
      const th = (s / SEGMENTS) * Math.PI * 2;
      const sh = shape(th);
      pos[v * 3 + 0] = Math.cos(th) * sh * rr;
      pos[v * 3 + 1] = (Math.sin(th) * sh + Y_SHIFT) * rr;
      radial[v] = rr;
      v++;
    }
  }

  const idx: number[] = [];
  for (let s = 0; s < SEGMENTS; s++) {
    idx.push(0, 1 + s, 1 + ((s + 1) % SEGMENTS));
  }
  for (let r = 0; r < RINGS.length - 1; r++) {
    const a0 = 1 + r * SEGMENTS;
    const b0 = 1 + (r + 1) * SEGMENTS;
    for (let s = 0; s < SEGMENTS; s++) {
      const sn = (s + 1) % SEGMENTS;
      idx.push(a0 + s, b0 + s, b0 + sn);
      idx.push(a0 + s, b0 + sn, a0 + sn);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRadial', new THREE.BufferAttribute(radial, 1));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------- wake ribbon ------

/**
 * One racer's trail.
 *
 * Storage is a ring buffer of spine points; the GPU buffers are a fixed
 * allocation written in place, oldest to newest, so the index buffer can be
 * static and the geometry is never rebuilt or resized. Vertex slot 2i/2i+1 is
 * the i-th *live* point, which is why the ring's wraparound never produces a
 * segment stretched across the seam.
 */
class WakeRibbon {
  readonly mesh: THREE.Mesh;

  // --- spine ring buffer (structure of arrays; index space is 0..MAX-1) ------
  private readonly px = new Float32Array(WAKE_MAX_POINTS);
  private readonly pz = new Float32Array(WAKE_MAX_POINTS);
  /** Unit lateral (starboard) vector captured at emit time. */
  private readonly nx = new Float32Array(WAKE_MAX_POINTS);
  private readonly nz = new Float32Array(WAKE_MAX_POINTS);
  /** Half-width at emit, before spreading. */
  private readonly hw0 = new Float32Array(WAKE_MAX_POINTS);
  private readonly str = new Float32Array(WAKE_MAX_POINTS);
  /** Ribbon clock value at emit; age = clock - birth (no per-point ageing pass). */
  private readonly birth = new Float32Array(WAKE_MAX_POINTS);
  /** Cumulative arc length from the ribbon's origin, periodically rebased. */
  private readonly dist = new Float32Array(WAKE_MAX_POINTS);

  private tail = 0;
  private count = 0;
  private clock = 0;
  private arc = 0;

  private lastHeading = 0;
  private hasLast = false;

  // --- interactor feed -------------------------------------------------------
  sinceEmit = Infinity;
  lastX = 0;
  lastZ = 0;
  lastRadius = 1;
  lastStrength = 0;

  private readonly position: THREE.BufferAttribute;
  private readonly data: THREE.BufferAttribute;
  private readonly wave: THREE.BufferAttribute;

  constructor(material: THREE.ShaderMaterial, index: number) {
    const verts = WAKE_MAX_POINTS * 2;
    const geo = new THREE.BufferGeometry();

    const pos = new Float32Array(verts * 3);
    this.position = new THREE.BufferAttribute(pos, 3);
    this.position.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.position);

    // Static: which lip each vertex belongs to. Never changes, never uploaded again.
    const side = new Float32Array(verts);
    for (let i = 0; i < verts; i++) side[i] = i % 2 === 0 ? -1 : 1;
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));

    // (arc length, age 0..1, strength, current half-width)
    const dataArr = new Float32Array(verts * 4);
    this.data = new THREE.BufferAttribute(dataArr, 4);
    this.data.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aData', this.data);

    // (wave normal xyz, horizontal Jacobian). The CPU already solves both in the
    // same sampleSurface call that seats the vertex, so handing them to the
    // shader costs one buffer and no extra maths. They are what make the ribbon
    // read as material lying on moving water: the normal gives it the ocean's
    // own two-band shading over a swell, the Jacobian bunches its foam onto
    // crests and thins it in troughs.
    const waveArr = new Float32Array(verts * 4);
    this.wave = new THREE.BufferAttribute(waveArr, 4);
    this.wave.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aWave', this.wave);

    // Static index buffer covering every possible quad; draw range picks how
    // many are live. Quad j is (2j, 2j+1, 2j+2, 2j+3).
    const quads = WAKE_MAX_POINTS - 1;
    const idx = new Uint16Array(quads * 6);
    for (let j = 0; j < quads; j++) {
      const a = j * 2;
      idx[j * 6 + 0] = a;
      idx[j * 6 + 1] = a + 1;
      idx[j * 6 + 2] = a + 2;
      idx[j * 6 + 3] = a + 1;
      idx[j * 6 + 4] = a + 3;
      idx[j * 6 + 5] = a + 2;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    // Owned and maintained by hand, so three never runs computeBoundingSphere
    // over 384 vertices that we already have the bounds of.
    geo.boundingSphere = new THREE.Sphere();

    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = `WakeRibbon${index}`;
    // Vertices are absolute world positions - the transform stays identity.
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 4;
    this.mesh.userData.noOutline = true;
  }

  reset(): void {
    this.tail = 0;
    this.count = 0;
    this.clock = 0;
    this.arc = 0;
    this.hasLast = false;
    this.sinceEmit = Infinity;
    this.lastStrength = 0;
    this.mesh.geometry.setDrawRange(0, 0);
  }

  /** Index of the most recently emitted point, or -1. */
  private head(): number {
    return this.count === 0 ? -1 : (this.tail + this.count - 1) % WAKE_MAX_POINTS;
  }

  private push(x: number, z: number, heading: number, halfWidth: number, strength: number): void {
    if (this.count === WAKE_MAX_POINTS) {
      // Full: the oldest point is evicted. At racing speed capacity and lifetime
      // expire together, so this is normal rather than exceptional.
      this.tail = (this.tail + 1) % WAKE_MAX_POINTS;
      this.count--;
    }
    const i = (this.tail + this.count) % WAKE_MAX_POINTS;

    const h = this.head();
    if (h >= 0) {
      const dx = x - this.px[h]!;
      const dz = z - this.pz[h]!;
      this.arc += Math.sqrt(dx * dx + dz * dz);
    }

    this.px[i] = x;
    this.pz[i] = z;
    // heading 0 faces +Z, so forward is (sin h, cos h) and starboard is
    // cross(up, forward) = (cos h, -sin h).
    this.nx[i] = Math.cos(heading);
    this.nz[i] = -Math.sin(heading);
    this.hw0[i] = halfWidth;
    this.str[i] = strength;
    this.birth[i] = this.clock;
    this.dist[i] = this.arc;
    this.count++;
  }

  emit(
    x: number, z: number, heading: number,
    halfWidth: number, strength: number, dt: number,
  ): void {
    this.sinceEmit = 0;
    this.lastX = x;
    this.lastZ = z;
    this.lastRadius = halfWidth * 2.4 + 0.55;
    // The interactor ring is smoothed, unlike the spine points, which take the
    // instantaneous value. Throttle and slip are noisy per-frame signals and the
    // ocean's displacement response to a ring flickering at 60 Hz would read as
    // the water buzzing. ~80 ms time constant, frame-rate independent.
    this.lastStrength += (strength - this.lastStrength) * Math.min(1, dt * 12);

    if (!this.hasLast || this.count === 0) {
      this.push(x, z, heading, halfWidth, strength);
      this.lastHeading = heading;
      this.hasLast = true;
      return;
    }

    const h = this.head();
    const dx = x - this.px[h]!;
    const dz = z - this.pz[h]!;
    const d = Math.sqrt(dx * dx + dz * dz);
    const turn = Math.abs(angleDelta(this.lastHeading, heading));

    if (d < WAKE_MIN_SPACING && turn < WAKE_TURN_STEP) return;
    // A pure pirouette must not stack points on top of each other.
    if (d < 0.06) return;

    const steps = Math.min(WAKE_MAX_INSERTS, Math.max(1, Math.floor(d / WAKE_MIN_SPACING)));
    const x0 = this.px[h]!;
    const z0 = this.pz[h]!;
    const dHead = angleDelta(this.lastHeading, heading);
    for (let s = 1; s <= steps; s++) {
      const u = s / steps;
      this.push(
        x0 + dx * u,
        z0 + dz * u,
        this.lastHeading + dHead * u,
        halfWidth,
        strength,
      );
    }
    this.lastHeading = heading;
  }

  /**
   * Ages the ribbon, re-seats every live spine point on the ocean surface and
   * rewrites the vertex buffers. This is the per-frame cost centre; see the
   * class comment for why it is spent.
   */
  update(dt: number, elapsed: number): void {
    this.clock += dt;
    this.sinceEmit += dt;

    // Retire from the tail. Ages are monotonic along the ring, so one walk from
    // the oldest end is exhaustive.
    while (this.count > 0 && this.clock - this.birth[this.tail]! >= WAKE_LIFE) {
      this.tail = (this.tail + 1) % WAKE_MAX_POINTS;
      this.count--;
    }
    if (this.count === 0) {
      this.hasLast = false;
      this.mesh.geometry.setDrawRange(0, 0);
      return;
    }

    // Keep arc length small enough for float32 to stay sub-millimetre. The shift
    // is an exact multiple of the tile size, so the foam texture does not move.
    if (this.arc > WAKE_REBASE_DIST) {
      this.arc -= WAKE_REBASE_DIST;
      for (let i = 0; i < this.count; i++) {
        const k = (this.tail + i) % WAKE_MAX_POINTS;
        this.dist[k] = this.dist[k]! - WAKE_REBASE_DIST;
      }
    }

    const pos = this.position.array as Float32Array;
    const dat = this.data.array as Float32Array;
    const wav = this.wave.array as Float32Array;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < this.count; i++) {
      const k = (this.tail + i) % WAKE_MAX_POINTS;
      const age01 = Math.min(1, (this.clock - this.birth[k]!) / WAKE_LIFE);

      // sqrt: a wake opens hard in its first second, then keeps creeping wider.
      // Linear growth reads as a wedge; this reads as water pushed aside.
      const hw = this.hw0[k]! * (1 + (WAKE_SPREAD - 1) * Math.sqrt(age01));

      const x = this.px[k]!;
      const z = this.pz[k]!;
      sampleSurface(x, z, elapsed, _surf);

      // Local tangent plane: dy = -(Nx*dx + Nz*dz) / Ny. The lips sit at
      // +-(nx, nz) * hw from the spine, so the two vertical offsets are equal
      // and opposite - one dot product covers both.
      const n = _surf.normal;
      const ox = this.nx[k]! * hw;
      const oz = this.nz[k]! * hw;

      let yL: number;
      let yR: number;
      if (hw > WAKE_LIP_SAMPLE_HW) {
        // Wide segment: seat each lip on the water it is actually over. This is
        // what makes an old, spread ribbon hump over a crest and fall into a
        // trough instead of spanning both on one flat chord.
        yL = sampleHeight(x - ox, z - oz, elapsed) + WAKE_LIFT;
        yR = sampleHeight(x + ox, z + oz, elapsed) + WAKE_LIFT;
      } else {
        // Narrow segment: the tangent plane through the spine is accurate to a
        // centimetre or two here, and this is the case that runs every frame
        // for every boat right behind the transom.
        //
        // Ny is floored: on a steep crest a near-horizontal normal would send
        // the lips to infinity, and a wake lip flung 20 m into the air is a far
        // worse artefact than one that slightly under-tilts.
        const invNy = 1 / Math.max(n.y, 0.35);
        let dy = -(n.x * this.nx[k]! + n.z * this.nz[k]!) * invNy * hw;
        const dyMax = hw * 0.85;
        if (dy > dyMax) dy = dyMax;
        else if (dy < -dyMax) dy = -dyMax;
        const h = _surf.height + WAKE_LIFT;
        yL = h - dy;
        yR = h + dy;
      }

      const vL = i * 2;
      const vR = vL + 1;

      pos[vL * 3 + 0] = x - ox;
      pos[vL * 3 + 1] = yL;
      pos[vL * 3 + 2] = z - oz;
      pos[vR * 3 + 0] = x + ox;
      pos[vR * 3 + 1] = yR;
      pos[vR * 3 + 2] = z + oz;

      const arc = this.dist[k]!;
      const s = this.str[k]!;
      dat[vL * 4 + 0] = arc; dat[vL * 4 + 1] = age01; dat[vL * 4 + 2] = s; dat[vL * 4 + 3] = hw;
      dat[vR * 4 + 0] = arc; dat[vR * 4 + 1] = age01; dat[vR * 4 + 2] = s; dat[vR * 4 + 3] = hw;

      const jac = _surf.jacobian;
      wav[vL * 4 + 0] = n.x; wav[vL * 4 + 1] = n.y; wav[vL * 4 + 2] = n.z; wav[vL * 4 + 3] = jac;
      wav[vR * 4 + 0] = n.x; wav[vR * 4 + 1] = n.y; wav[vR * 4 + 2] = n.z; wav[vR * 4 + 3] = jac;

      const lo = yL < yR ? yL : yR;
      const hi = yL < yR ? yR : yL;
      if (x - hw < minX) minX = x - hw;
      if (x + hw > maxX) maxX = x + hw;
      if (z - hw < minZ) minZ = z - hw;
      if (z + hw > maxZ) maxZ = z + hw;
      if (lo < minY) minY = lo;
      if (hi > maxY) maxY = hi;
    }

    this.position.needsUpdate = true;
    this.data.needsUpdate = true;
    this.wave.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, Math.max(0, (this.count - 1) * 6));

    _box.min.set(minX, minY, minZ);
    _box.max.set(maxX, maxY, maxZ);
    _box.getBoundingSphere(this.mesh.geometry.boundingSphere!);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

// ------------------------------------------------------------- interactor ----

/** One hull's foam ring, consumed by `Ocean.setInteractors()`. */
export interface FoamInteractor {
  x: number;
  z: number;
  radius: number;
  strength: number;
}

// ------------------------------------------------------------- the system ----

export class FoamSystem {
  /**
   * Hull foam rings, rebuilt in place every `update()` - one entry per racer
   * that emitted a wake within the last `INTERACTOR_HOLD` seconds, with
   * `strength` ramping to zero as that window expires so a stopping boat's ring
   * shrinks away instead of blinking out. The array and its entries are
   * preallocated and reused; only `length` changes. The integration layer feeds
   * this straight to `Ocean.setInteractors(foam.interactors)` each frame.
   */
  readonly interactors: FoamInteractor[] = [];

  private readonly scene: THREE.Scene;
  private readonly rng: Rng;

  private readonly wakeMaterial: THREE.ShaderMaterial;
  private readonly ribbons: WakeRibbon[] = [];
  private readonly interactorPool: FoamInteractor[] = [];

  // --- spray pool (structure of arrays, live particles occupy [0, alive)) ----
  private readonly sx = new Float32Array(SPRAY_POOL);
  private readonly sy = new Float32Array(SPRAY_POOL);
  private readonly sz = new Float32Array(SPRAY_POOL);
  private readonly svx = new Float32Array(SPRAY_POOL);
  private readonly svy = new Float32Array(SPRAY_POOL);
  private readonly svz = new Float32Array(SPRAY_POOL);
  private readonly sSize = new Float32Array(SPRAY_POOL);
  private readonly sLife = new Float32Array(SPRAY_POOL);
  private readonly sInvLife = new Float32Array(SPRAY_POOL);
  private readonly sState = new Uint8Array(SPRAY_POOL);
  /** Cached surface height beneath the droplet, when it was taken, and its own refresh period. */
  private readonly sWaterY = new Float32Array(SPRAY_POOL);
  private readonly sWaterT = new Float32Array(SPRAY_POOL);
  private readonly sWaterDt = new Float32Array(SPRAY_POOL);
  private readonly sTint = new Float32Array(SPRAY_POOL * 3);
  private alive = 0;

  private readonly sprayMesh: THREE.InstancedMesh;
  private readonly sprayMaterial: THREE.ShaderMaterial;
  private readonly aOffset: THREE.InstancedBufferAttribute;
  private readonly aParams: THREE.InstancedBufferAttribute;
  private readonly aTint: THREE.InstancedBufferAttribute;
  private readonly aVel: THREE.InstancedBufferAttribute;

  /** Wrapped 0..1 foam scroll offsets, one per texture layer. */
  private readonly scroll = new THREE.Vector2();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    // fork() reads the global generator's state without advancing it, so this is
    // deterministic no matter what order subsystems are constructed in.
    this.rng = rng.fork(77);

    // ------------------------------------------------------------ ribbons ----
    this.wakeMaterial = new THREE.ShaderMaterial({
      name: 'WakeRibbon',
      glslVersion: THREE.GLSL3,
      vertexShader: WAKE_VERT,
      fragmentShader: WAKE_FRAG,
      lights: false,
      transparent: true,
      // The ribbon lies *on* the water: it must be occluded by hulls and by the
      // wave in front of it, but it must not stamp depth, or the four ribbons
      // would z-fight each other where two boats' wakes cross.
      depthTest: true,
      depthWrite: false,
      // Ribbons twist through steep chop; both faces have to draw.
      side: THREE.DoubleSide,
      // The 6 cm lift handles the general case; this handles the grazing case,
      // where the ribbon and the ocean surface are nearly parallel to the view
      // ray and 6 cm of world space is less than one depth-buffer step.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      uniforms: {
        uFoamColor: { value: PALETTE.foam.clone() },
        uFoamShade: { value: PALETTE.foamShade.clone() },
        uFoamEdge: { value: FOAM_EDGE.clone() },
        uSunDir: { value: SUN_DIR.clone() },
        uScroll: { value: this.scroll },
        uOpacity: { value: 1 },
        uCameraFar: { value: CAMERA_FAR },
      },
    });

    for (let i = 0; i < RACER_COUNT; i++) {
      const r = new WakeRibbon(this.wakeMaterial, i);
      this.ribbons.push(r);
      scene.add(r.mesh);
      this.interactorPool.push({ x: 0, z: 0, radius: 1, strength: 0 });
    }

    // -------------------------------------------------------------- spray ----
    const blob = makeSprayBlob();

    this.aOffset = new THREE.InstancedBufferAttribute(new Float32Array(SPRAY_POOL * 3), 3);
    this.aParams = new THREE.InstancedBufferAttribute(new Float32Array(SPRAY_POOL * 4), 4);
    this.aTint = new THREE.InstancedBufferAttribute(new Float32Array(SPRAY_POOL * 3), 3);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(SPRAY_POOL * 3), 3);
    this.aOffset.setUsage(THREE.DynamicDrawUsage);
    this.aParams.setUsage(THREE.DynamicDrawUsage);
    this.aTint.setUsage(THREE.DynamicDrawUsage);
    this.aVel.setUsage(THREE.DynamicDrawUsage);
    blob.setAttribute('aOffset', this.aOffset);
    blob.setAttribute('aParams', this.aParams);
    blob.setAttribute('aTint', this.aTint);
    blob.setAttribute('aVel', this.aVel);

    this.sprayMaterial = new THREE.ShaderMaterial({
      name: 'Spray',
      glslVersion: THREE.GLSL3,
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      lights: false,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uFoamColor: { value: PALETTE.foam.clone() },
        uFoamShade: { value: PALETTE.foamShade.clone() },
        uFoamEdge: { value: FOAM_EDGE.clone() },
        uOpacity: { value: 1 },
        uCameraFar: { value: CAMERA_FAR },
      },
    });

    this.sprayMesh = new THREE.InstancedMesh(blob, this.sprayMaterial, SPRAY_POOL);
    this.sprayMesh.name = 'Spray';
    // Position, scale and rotation all live in the custom instance attributes:
    // billboarding needs the camera basis, and the CPU has no business chasing
    // that. `instanceMatrix` is therefore unreferenced by the shader and gets
    // optimised out - but three allocates it zero-filled, and a zero matrix is a
    // far worse failure mode than an identity one if anything ever does read it.
    // Written once, never uploaded again.
    const ident = new THREE.Matrix4();
    for (let i = 0; i < SPRAY_POOL; i++) this.sprayMesh.setMatrixAt(i, ident);
    this.sprayMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.sprayMesh.count = 0;
    // Particles are scattered over hundreds of metres and the mesh's own
    // transform says nothing about where they are, so culling has to be off.
    this.sprayMesh.frustumCulled = false;
    this.sprayMesh.renderOrder = 6;
    this.sprayMesh.userData.noOutline = true;
    scene.add(this.sprayMesh);
  }

  // ------------------------------------------------------------- emitters ----

  /**
   * Appends to racer `index`'s wake. Called once per frame per boat; the ribbon
   * itself decides whether the boat has travelled far enough (or turned sharply
   * enough) to deserve a new spine point, so calling this every frame at any
   * frame rate produces the same trail.
   *
   * @param pos       world position the foam originates from (the stern)
   * @param heading   yaw in radians, 0 = +Z, matching BoatState.heading
   * @param halfWidth half the hull beam - the ribbon's width before it spreads
   * @param strength  0..1 foam density; drives opacity and the erosion threshold
   * @param dt        frame delta, used to smooth the hull interactor ring
   */
  emitWake(
    index: number,
    pos: THREE.Vector3,
    heading: number,
    halfWidth: number,
    strength: number,
    dt: number,
  ): void {
    if (index < 0 || index >= this.ribbons.length) return;
    const s = strength > 1 ? 1 : strength < 0 ? 0 : strength;
    if (s <= 0.002) return;
    this.ribbons[index]!.emit(pos.x, pos.z, heading, Math.max(0.12, halfWidth), s, dt);
  }

  /**
   * Throws droplets. `dir` is the launch direction; its *length* is read as a
   * speed hint, so passing a velocity vector gives fast spray off a hard landing
   * and passing a unit vector still gives a usable arc.
   *
   * @param amount intensity - roughly 8 particles per unit, capped per call
   * @param color  accepted for call-site compatibility and deliberately ignored:
   *               whitewater is white, and tinting it toward a racer's body
   *               colour is what put salmon and mauve shards in the foam
   */
  emitSpray(pos: THREE.Vector3, dir: THREE.Vector3, amount: number, color?: THREE.Color): void {
    if (amount <= 0) return;

    // Stochastic rounding keeps sub-particle amounts alive: 0.03 emits nothing
    // most frames and one droplet occasionally, rather than nothing ever.
    let n = Math.floor(amount * SPRAY_PER_AMOUNT + this.rng.next());
    if (n <= 0) return;
    if (n > SPRAY_MAX_BURST) n = SPRAY_MAX_BURST;

    const dirLen = dir.length();
    if (dirLen > 1e-4) _dir.copy(dir).multiplyScalar(1 / dirLen);
    else _dir.set(0, 1, 0);

    // Orthonormal basis for the cone. The axis pick avoids the degenerate cross
    // product when the launch direction is itself vertical.
    _axis.set(0, 1, 0);
    if (Math.abs(_dir.y) > 0.9) _axis.set(1, 0, 0);
    _t1.crossVectors(_axis, _dir).normalize();
    _t2.crossVectors(_dir, _t1);

    // Whitewater is white. The racer's colour is deliberately not consulted -
    // see SPRAY_TINT_COOL. The droplet varies only along foam-white to crest
    // cyan, and the amount is per *burst* rather than per particle so one impact
    // reads as one material rather than as confetti.
    _tint.copy(_white).lerp(SPRAY_COOL_MUL, this.rng.next() * SPRAY_TINT_COOL);

    const baseSpeed = 3.0 + dirLen * 0.6;

    for (let i = 0; i < n; i++) {
      if (this.alive >= SPRAY_POOL) return; // pool saturated: drop the rest
      const j = this.alive++;

      const spread1 = this.rng.signed() * SPRAY_CONE;
      const spread2 = this.rng.signed() * SPRAY_CONE;
      let vx = _dir.x + _t1.x * spread1 + _t2.x * spread2;
      let vy = _dir.y + _t1.y * spread1 + _t2.y * spread2;
      let vz = _dir.z + _t1.z * spread1 + _t2.z * spread2;
      const il = 1 / Math.max(1e-4, Math.sqrt(vx * vx + vy * vy + vz * vz));
      const sp = baseSpeed * this.rng.range(0.62, 1.38);
      vx *= il * sp;
      vy *= il * sp;
      vz *= il * sp;

      // Spawn scattered a little so a burst is a spray, not a starburst, and
      // pushed clear of the emitter along the launch direction so droplets do
      // not begin their life inside the hull that threw them.
      this.sx[j] = pos.x + _dir.x * SPRAY_SPAWN_PUSH + this.rng.signed() * 0.16;
      this.sy[j] = pos.y + _dir.y * SPRAY_SPAWN_PUSH + this.rng.signed() * 0.10;
      this.sz[j] = pos.z + _dir.z * SPRAY_SPAWN_PUSH + this.rng.signed() * 0.16;
      this.svx[j] = vx;
      this.svy[j] = vy;
      this.svz[j] = vz;

      // Half-extents, biased small by squaring the draw. A uniform 5.5-16.5 cm
      // draw put a third of the pool at the top of the range, and at the six to
      // ten metres a chase camera sits from the wake a 33 cm droplet is 100 px
      // - big enough for its contour ring to read as a drawn outline, and with
      // two dozen of them at much the same size the whole population read as
      // clip-art stamped on the foam. Squaring puts most droplets at 3-6 cm and
      // leaves the occasional 11 cm one, which is a size *distribution* rather
      // than a repeated stamp.
      const su = this.rng.next();
      this.sSize[j] = (0.021 + 0.062 * su * su) * (0.82 + dirLen * 0.018);
      this.sLife[j] = 0;
      this.sInvLife[j] = 1 / this.rng.range(0.55, 1.15);
      this.sState[j] = FLYING;
      this.sWaterY[j] = -1e9; // forces a real sample on the droplet's first update
      this.sWaterT[j] = -1e9;
      this.sWaterDt[j] = this.rng.range(SPRAY_H_REFRESH_MIN, SPRAY_H_REFRESH_MAX);
      this.sTint[j * 3 + 0] = _tint.r;
      this.sTint[j * 3 + 1] = _tint.g;
      this.sTint[j * 3 + 2] = _tint.b;
    }
  }

  // ---------------------------------------------------------------- tick -----

  update(dt: number, elapsed: number): void {
    // Wrapped in 0..1 tile space; RepeatWrapping makes the wrap invisible and
    // keeps the uniform from growing without bound over a long session.
    this.scroll.set(
      (this.scroll.x + dt * WAKE_SCROLL_A) % 1,
      (this.scroll.y + dt * WAKE_SCROLL_B) % 1,
    );

    for (let i = 0; i < this.ribbons.length; i++) this.ribbons[i]!.update(dt, elapsed);

    this.updateInteractors();
    this.updateSpray(dt, elapsed);
  }

  private updateInteractors(): void {
    let n = 0;
    for (let i = 0; i < this.ribbons.length; i++) {
      const r = this.ribbons[i]!;
      if (r.sinceEmit > INTERACTOR_HOLD) continue;
      const e = this.interactorPool[i]!;
      e.x = r.lastX;
      e.z = r.lastZ;
      e.radius = r.lastRadius;
      // Full strength while the boat is emitting, then a ramp to zero over the
      // back 60% of the hold window, so a boat that stops loses its ring
      // smoothly instead of having it blink out. Ramping across the *whole*
      // window would attenuate every actively-emitting boat by a frame's worth.
      e.strength = r.lastStrength *
        Math.min(1, (INTERACTOR_HOLD - r.sinceEmit) / (INTERACTOR_HOLD * 0.6));
      this.interactors[n++] = e;
    }
    // Shrinking a JS array in place; no allocation, and the pool objects the
    // trimmed slots referenced are still owned by interactorPool.
    this.interactors.length = n;
  }

  private updateSpray(dt: number, elapsed: number): void {
    const off = this.aOffset.array as Float32Array;
    const par = this.aParams.array as Float32Array;
    const tin = this.aTint.array as Float32Array;
    const vel = this.aVel.array as Float32Array;

    const drag = Math.exp(-SPRAY_DRAG * dt);

    let i = 0;
    while (i < this.alive) {
      this.sLife[i] = this.sLife[i]! + dt;

      let alpha: number;
      let sizeX: number;
      let sizeY: number;
      // Elongation along the direction of travel. A droplet moving fast draws
      // as a streak; one that has slowed to nothing draws as a round chip.
      let stretch: number;

      if (this.sState[i] === FLYING) {
        const t01 = this.sLife[i]! * this.sInvLife[i]!;
        if (t01 >= 1) { this.kill(i); continue; }

        this.svy[i] = this.svy[i]! + SPRAY_GRAVITY * dt;
        this.svx[i] = this.svx[i]! * drag;
        this.svy[i] = this.svy[i]! * drag;
        this.svz[i] = this.svz[i]! * drag;

        const x = this.sx[i]! + this.svx[i]! * dt;
        const y = this.sy[i]! + this.svy[i]! * dt;
        const z = this.sz[i]! + this.svz[i]! * dt;
        this.sx[i] = x; this.sy[i] = y; this.sz[i] = z;

        // See SPRAY_H_REFRESH: stale caches are only tolerated far from the
        // surface, so the impact itself is always tested against a live sample.
        if (y - this.sWaterY[i]! < SPRAY_H_NEAR || elapsed - this.sWaterT[i]! > this.sWaterDt[i]!) {
          sampleSurface(x, z, elapsed, _surf);
          this.sWaterY[i] = _surf.height;
          this.sWaterT[i] = elapsed;
        }

        if (y <= this.sWaterY[i]!) {
          // Impact: stop dead on the surface and flatten. The splat gets its own
          // short clock so a droplet that dies at 0.2 s and one that dies at
          // 1.1 s both leave the same mark.
          this.sState[i] = SPLAT;
          this.sLife[i] = 0;
          this.sInvLife[i] = 1 / SPRAY_SPLAT_LIFE;
          this.svx[i] = this.svx[i]! * 0.25;
          this.svy[i] = 0;
          this.svz[i] = this.svz[i]! * 0.25;
          this.sy[i] = this.sWaterY[i]! + SPRAY_SPLAT_LIFT;
        }

        // Shrink as it fades - a droplet gets smaller, it does not get ghostly.
        const shrink = 1 - 0.66 * t01 * t01;
        sizeX = this.sSize[i]! * shrink;
        sizeY = sizeX;
        const sp = Math.sqrt(
          this.svx[i]! * this.svx[i]! + this.svy[i]! * this.svy[i]! + this.svz[i]! * this.svz[i]!,
        );
        stretch = 1 + Math.min(1.35, sp * 0.075);
        // Three flat plateaus, no ramp. The final step down to nothing on a
        // particle already at a third of its size is the intended blink-out.
        alpha = t01 < 0.42 ? 1.0 : t01 < 0.74 ? 0.62 : 0.30;
      } else {
        const t01 = this.sLife[i]! * this.sInvLife[i]!;
        if (t01 >= 1) { this.kill(i); continue; }

        // The splat slides a little with its residual momentum and rides the
        // swell - it is sitting on the water, so its height is resampled every
        // frame. Splats are short-lived and few, so this costs almost nothing.
        const x = this.sx[i]! + this.svx[i]! * dt;
        const z = this.sz[i]! + this.svz[i]! * dt;
        this.sx[i] = x; this.sz[i] = z;
        sampleSurface(x, z, elapsed, _surf);
        this.sWaterY[i] = _surf.height;
        this.sy[i] = _surf.height + SPRAY_SPLAT_LIFT;

        // Squash: spreads sideways as it collapses vertically, so the impact
        // reads as a mark being made rather than a particle being deleted.
        const base = this.sSize[i]!;
        sizeX = base * (1 + 0.55 * t01);
        sizeY = base * (1 - 0.96 * t01);
        stretch = 1;
        alpha = t01 < 0.45 ? 0.9 : t01 < 0.78 ? 0.55 : 0.26;
      }

      off[i * 3 + 0] = this.sx[i]!;
      off[i * 3 + 1] = this.sy[i]!;
      off[i * 3 + 2] = this.sz[i]!;
      par[i * 4 + 0] = sizeX;
      par[i * 4 + 1] = sizeY;
      par[i * 4 + 2] = stretch;
      par[i * 4 + 3] = alpha;
      tin[i * 3 + 0] = this.sTint[i * 3 + 0]!;
      tin[i * 3 + 1] = this.sTint[i * 3 + 1]!;
      tin[i * 3 + 2] = this.sTint[i * 3 + 2]!;
      vel[i * 3 + 0] = this.svx[i]!;
      vel[i * 3 + 1] = this.svy[i]!;
      vel[i * 3 + 2] = this.svz[i]!;
      i++;
    }

    this.sprayMesh.count = this.alive;
    if (this.alive > 0) {
      this.aOffset.needsUpdate = true;
      this.aParams.needsUpdate = true;
      this.aTint.needsUpdate = true;
      this.aVel.needsUpdate = true;
    }
  }

  /** Swap-remove: the live particles stay packed in [0, alive). */
  private kill(i: number): void {
    const last = --this.alive;
    if (i === last) return;
    this.sx[i] = this.sx[last]!; this.sy[i] = this.sy[last]!; this.sz[i] = this.sz[last]!;
    this.svx[i] = this.svx[last]!; this.svy[i] = this.svy[last]!; this.svz[i] = this.svz[last]!;
    this.sSize[i] = this.sSize[last]!;
    this.sLife[i] = this.sLife[last]!;
    this.sInvLife[i] = this.sInvLife[last]!;
    this.sState[i] = this.sState[last]!;
    this.sWaterY[i] = this.sWaterY[last]!;
    this.sWaterT[i] = this.sWaterT[last]!;
    this.sWaterDt[i] = this.sWaterDt[last]!;
    this.sTint[i * 3 + 0] = this.sTint[last * 3 + 0]!;
    this.sTint[i * 3 + 1] = this.sTint[last * 3 + 1]!;
    this.sTint[i * 3 + 2] = this.sTint[last * 3 + 2]!;
  }

  // --------------------------------------------------------------- control ---

  /** Wipes every ribbon and every droplet. Used by the race restart. */
  clear(): void {
    for (let i = 0; i < this.ribbons.length; i++) this.ribbons[i]!.reset();
    this.alive = 0;
    this.sprayMesh.count = 0;
    this.interactors.length = 0;
    this.scroll.set(0, 0);
  }

  /** Global fade, for the results screen or a cinematic. */
  setOpacity(v: number): void {
    this.wakeMaterial.uniforms.uOpacity!.value = v;
    this.sprayMaterial.uniforms.uOpacity!.value = v;
  }

  /** Live particle count, for the harness's stats readout. */
  get sprayCount(): number { return this.alive; }

  dispose(): void {
    for (const r of this.ribbons) {
      this.scene.remove(r.mesh);
      r.dispose();
    }
    this.scene.remove(this.sprayMesh);
    this.sprayMesh.geometry.dispose();
    this.wakeMaterial.dispose();
    this.sprayMaterial.dispose();
  }
}
