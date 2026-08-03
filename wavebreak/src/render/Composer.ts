import * as THREE from 'three';
import type { Engine } from '../core/Engine';
import { PALETTE } from '../core/Palette';
import { OUTLINE_GLOBALS } from './OutlineHull';
import { FULLSCREEN_VERT, BRIGHT_FRAG, BLUR_FRAG, COMPOSITE_FRAG } from './shaders/postShaders';

/**
 * The post stack, hand-rolled.
 *
 * `EffectComposer` is deliberately not used. It owns two full-size targets and
 * copies between them on every pass, and it has no notion of a multi-target
 * G-buffer - we would end up re-rendering the scene a second time just to get
 * normals, which at four boats plus an infinite ocean is the single most
 * expensive thing we could do. Instead the scene is drawn exactly once into a
 * two-attachment MRT and everything after that is three cheap fullscreen
 * triangles.
 *
 * The chain:
 *
 *   scene ──► sceneRT  [0] linear HDR colour
 *                      [1] vec4(octNormal.xy, depth/far, edgeMask)
 *             │
 *             ├─ bright ──► bloomA (half res)
 *             │      blurH ──► bloomB ──► blurV ──► bloomA
 *             │
 *             └─ composite(sceneRT[0], sceneRT[1], bloomA) ──► screen
 *
 * The composite is where the interior ink lives. Silhouettes are *not* drawn
 * here - those are the inverted-hull shells from `OutlineHull.ts`, which write
 * `edgeMask = 0` so this pass knows to keep its hands off them. Two line
 * systems, one drawing, no doubled strokes.
 *
 * Total cost is one scene pass plus one full-res and two half-res fullscreen
 * passes; measured against the 2 ms budget at 2560x1440 the composite dominates
 * (nine G-buffer taps) and the bloom is close to free at quarter the pixels.
 */

// ------------------------------------------------------------------ tuning --

/**
 * Depth-edge threshold, expressed as a fraction of the centre depth: a surface
 * has to step by ~7.5% of its own distance across the Sobel footprint to draw.
 * Tuned so hull seams and gate frames ink while a 65-degree deck plane does not.
 */
const DEPTH_THRESHOLD = 0.075;

/**
 * Normal-edge threshold as `1 - dot`. 0.20 is a ~37-degree crease, which lands
 * between "chamfered panel break" (wanted) and "curvature across two texels on
 * a round hull" (four orders of magnitude smaller, never triggers).
 */
const NORMAL_THRESHOLD = 0.20;

/**
 * The same two thresholds for surfaces that have opted all the way in to the ink
 * - anything whose `edgeMask` clears 0.85, which is hulls, metal and cloth. The
 * composite interpolates between each conservative value above and its hard twin
 * here using `smoothstep(0.45, 0.85, edgeMask)`.
 *
 * The pair above have to stay conservative because they are what the OCEAN gets,
 * and the ocean is a million grazing triangles running to the horizon. But that
 * conservatism was also what starved the interior pass: 0.20 is a 37-degree
 * crease, and almost nothing a boat is made of breaks that sharply, so panel
 * lines simply never drew. 0.060 is a ~20-degree crease, which is where a
 * chamfered panel break actually lives.
 *
 * Splitting them rather than lowering them is what keeps the ocean and the
 * silhouettes safe; the arithmetic for both is written out in the composite.
 */
const DEPTH_THRESHOLD_HARD = 0.040;
const NORMAL_THRESHOLD_HARD = 0.060;

const EDGE_STRENGTH = 1.0;

/** How far the ink multiply pulls a line's value down before tinting. */
const INK_DARKEN = 0.30;
/** How far the darkened value is then dragged toward the indigo ink hue. */
const INK_TINT = 0.55;

/** Luma above which a pixel is allowed to glow. Cel flats top out near 1.1. */
const BLOOM_THRESHOLD = 0.85;
/** Additive strength of the quantised glow. Subtle by design. */
const BLOOM_STRENGTH = 0.42;
/** Multiplier on the blur tap offsets; 1.0 gives ~+-13 full-res pixels. */
const BLOOM_RADIUS = 1.0;

const SATURATION = 1.06;
const VIGNETTE = 0.13;

/**
 * Reference height the Sobel tap radius is normalised against. At 900 px tall
 * the radius is exactly one texel; at 1440p it widens to 1.6 so a line keeps
 * the same *apparent* weight instead of halving when the buffer doubles.
 */
const EDGE_REFERENCE_HEIGHT = 900;

/**
 * Clear value for G-buffer attachment 1 where nothing was drawn:
 * octEncode(0,0,1) = (0.5, 0.5), depth01 = 1 (the far plane), edgeMask = 0.
 * Clearing to the scene clear *colour* instead would plant a mid-distance
 * surface with a full edge mask behind everything, and any gap in the sky dome
 * would ink itself a border.
 */
const GBUFFER_CLEAR = new Float32Array([0.5, 0.5, 1.0, 0.0]);

// Module-scope scratch. Nothing in render() may allocate.
const _size = new THREE.Vector2();
const _cssSize = new THREE.Vector2();

/** The fullscreen triangle. One primitive, no seam, no wasted quad helpers. */
function makeFullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // Covers NDC [-1,1]^2 with a single oversized triangle; the excess is clipped.
  g.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  // uv = (ndc + 1) / 2, so vUv is 0..1 over the visible region.
  g.setAttribute('uv', new THREE.BufferAttribute(
    new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  return g;
}

function postMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, name: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name,
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    lights: false,
    transparent: false,
  });
}

export class Composer {
  private readonly engine: Engine;

  /** Two-attachment scene target: colour + normal/depth/edgeMask. */
  private readonly sceneRT: THREE.WebGLRenderTarget;
  /** Half-res bloom ping-pong. */
  private readonly bloomA: THREE.WebGLRenderTarget;
  private readonly bloomB: THREE.WebGLRenderTarget;

  private readonly triScene = new THREE.Scene();
  private readonly triCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly tri: THREE.Mesh;

  private readonly brightMat: THREE.ShaderMaterial;
  private readonly blurMat: THREE.ShaderMaterial;
  private readonly compositeMat: THREE.ShaderMaterial;

  private width = 1;
  private height = 1;
  private bloomEnabled = true;
  private edgesEnabled = true;

  /** WebGL2 handle, kept only for the per-attachment clear. */
  private readonly gl2: WebGL2RenderingContext | null;

  constructor(engine: Engine) {
    this.engine = engine;
    const renderer = engine.renderer;

    renderer.getDrawingBufferSize(_size);
    this.width = Math.max(1, Math.floor(_size.x));
    this.height = Math.max(1, Math.floor(_size.y));
    const bw = Math.max(1, this.width >> 1);
    const bh = Math.max(1, this.height >> 1);

    // HalfFloat, not UnsignedByte: attachment 1 stores linear depth and an oct
    // normal, both of which band visibly at 8 bits, and attachment 0 has to
    // carry emissives above 1.0 for the bright pass to have anything to find.
    // NearestFilter on the scene target is non-negotiable - the Sobel reads
    // exact texels, and a bilinear tap would blur the very steps it looks for.
    this.sceneRT = new THREE.WebGLRenderTarget(this.width, this.height, {
      count: 2,
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
    this.sceneRT.textures[0]!.name = 'gColor';
    this.sceneRT.textures[1]!.name = 'gNormalDepth';

    // The bloom chain *wants* bilinear - the blur leans on hardware filtering
    // for its paired taps, and glow has no hard edges to protect.
    const bloomOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    };
    this.bloomA = new THREE.WebGLRenderTarget(bw, bh, bloomOpts);
    this.bloomB = new THREE.WebGLRenderTarget(bw, bh, bloomOpts);

    this.brightMat = postMaterial(BRIGHT_FRAG, {
      uScene: { value: this.sceneRT.textures[0]! },
      uTexel: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
      uThreshold: { value: BLOOM_THRESHOLD },
    }, 'PostBright');

    this.blurMat = postMaterial(BLUR_FRAG, {
      uSource: { value: this.bloomA.textures[0]! },
      uDirection: { value: new THREE.Vector2() },
    }, 'PostBlur');

    this.compositeMat = postMaterial(COMPOSITE_FRAG, {
      uScene: { value: this.sceneRT.textures[0]! },
      uNormalDepth: { value: this.sceneRT.textures[1]! },
      uBloom: { value: this.bloomA.textures[0]! },
      uTexel: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
      uEdgeRadius: { value: 1 },
      uDepthThreshold: { value: DEPTH_THRESHOLD },
      uNormalThreshold: { value: NORMAL_THRESHOLD },
      uDepthThresholdHard: { value: DEPTH_THRESHOLD_HARD },
      uNormalThresholdHard: { value: NORMAL_THRESHOLD_HARD },
      uEdgeStrength: { value: EDGE_STRENGTH },
      uInk: { value: PALETTE.inkSoft.clone() },
      uInkDarken: { value: INK_DARKEN },
      uInkTint: { value: INK_TINT },
      uBloomStrength: { value: BLOOM_STRENGTH },
      uSaturation: { value: SATURATION },
      uVignette: { value: VIGNETTE },
      uAspect: { value: 1 },
      uTanHalfFov: { value: 0.5 },
    }, 'PostComposite');

    this.tri = new THREE.Mesh(makeFullscreenTriangle(), this.compositeMat);
    this.tri.frustumCulled = false;
    this.triScene.add(this.tri);

    const ctx = renderer.getContext();
    this.gl2 = typeof WebGL2RenderingContext !== 'undefined' && ctx instanceof WebGL2RenderingContext
      ? ctx
      : null;

    // three zeroes renderer.info at the top of every render() call. With four
    // render() calls per frame the harness's stats() would report the composite
    // triangle and nothing else - one draw call, two triangles, for a frame that
    // drew the whole race. Take ownership of the reset so the numbers cover the
    // entire frame, which is what `tools/shoot.mjs` is actually asking for.
    renderer.info.autoReset = false;

    this.applySizeUniforms();
  }

  // --------------------------------------------------------------- sizing ---

  /**
   * Rebuilds every size-derived uniform. Called on construction and whenever
   * the drawing buffer changes underneath us.
   */
  private applySizeUniforms(): void {
    const texel = 1 / this.width;
    const texelY = 1 / this.height;

    (this.brightMat.uniforms.uTexel!.value as THREE.Vector2).set(texel, texelY);
    (this.compositeMat.uniforms.uTexel!.value as THREE.Vector2).set(texel, texelY);

    // Resolution-independent line weight: one texel at the reference height,
    // wider as the buffer grows. Clamped at 1 so a low-res or heavily
    // downscaled buffer never asks for a sub-texel offset, which with
    // NearestFilter would sample the centre texel nine times and kill the edge.
    this.compositeMat.uniforms.uEdgeRadius!.value =
      Math.max(1, this.height / EDGE_REFERENCE_HEIGHT);

    // Textures survive setSize (the objects are reused, only the GPU storage is
    // recreated), but rebinding is free and keeps this correct if that changes.
    this.brightMat.uniforms.uScene!.value = this.sceneRT.textures[0]!;
    this.compositeMat.uniforms.uScene!.value = this.sceneRT.textures[0]!;
    this.compositeMat.uniforms.uNormalDepth!.value = this.sceneRT.textures[1]!;
    this.compositeMat.uniforms.uBloom!.value = this.bloomA.textures[0]!;

    // The inverted-hull shells size their screen-space push against this, and
    // nothing else in the engine owns a resize hook. Their thickness is
    // documented in CSS pixels, so this is the CSS size, not the drawing buffer.
    this.engine.renderer.getSize(_cssSize);
    (OUTLINE_GLOBALS.uResolution.value as THREE.Vector2).set(
      Math.max(1, _cssSize.x), Math.max(1, _cssSize.y));
  }

  /**
   * Polls the drawing buffer size. The Engine's adaptive resolution controller
   * changes it at runtime without telling anyone, so this runs every frame - it
   * is two integer compares against a cached `getDrawingBufferSize`, which is
   * itself only a multiply on the renderer's own state.
   */
  private syncSize(force: boolean): void {
    this.engine.renderer.getDrawingBufferSize(_size);
    const w = Math.max(1, Math.floor(_size.x));
    const h = Math.max(1, Math.floor(_size.y));
    if (!force && w === this.width && h === this.height) return;

    this.width = w;
    this.height = h;
    const bw = Math.max(1, w >> 1);
    const bh = Math.max(1, h >> 1);
    this.sceneRT.setSize(w, h);
    this.bloomA.setSize(bw, bh);
    this.bloomB.setSize(bw, bh);
    this.applySizeUniforms();
  }

  /**
   * Re-reads the drawing buffer and rebuilds everything derived from it.
   * `render()` already polls, so this only exists for callers that want the
   * targets correct *before* the next frame. `RenderTarget.setSize` no-ops when
   * the dimensions match, so calling this spuriously costs nothing.
   */
  resize(): void {
    this.syncSize(true);
  }

  // -------------------------------------------------------------- controls ---

  /**
   * Toggles the two effects. Disabling bloom skips its three passes outright;
   * disabling edges collapses the nine G-buffer taps behind a uniform branch,
   * which is coherent across the whole draw and therefore actually free.
   */
  setEnabled(edges: boolean, bloom: boolean): void {
    this.edgesEnabled = edges;
    this.bloomEnabled = bloom;
    this.compositeMat.uniforms.uEdgeStrength!.value = edges ? EDGE_STRENGTH : 0;
    this.compositeMat.uniforms.uBloomStrength!.value = bloom ? BLOOM_STRENGTH : 0;
  }

  get edgesOn(): boolean { return this.edgesEnabled; }
  get bloomOn(): boolean { return this.bloomEnabled; }

  // ---------------------------------------------------------------- render ---

  render(): void {
    const renderer = this.engine.renderer;
    this.syncSize(false);
    renderer.info.reset();

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    // --- 1. scene into the G-buffer ---------------------------------------
    renderer.setRenderTarget(this.sceneRT);
    // The post materials draw with depthWrite off, so the GL depth mask is
    // still false from last frame's composite and glClear would silently skip
    // the depth buffer - the scene would accumulate depth forever and sort
    // itself into garbage after one frame. three's own background pass forces
    // these three flags before it clears; taking the clear over means taking
    // that responsibility too.
    renderer.state.buffers.depth.setTest(true);
    renderer.state.buffers.depth.setMask(true);
    renderer.state.buffers.color.setMask(true);
    renderer.clear(true, true, false);
    // gl.clear paints *every* draw buffer with the same clear colour, which is
    // meaningless for attachment 1. Repaint it with a real "empty" G-buffer
    // value so the Sobel sees far-plane depth and a zero edge mask wherever no
    // geometry landed, instead of a plausible-looking surface made of sky blue.
    if (this.gl2 && this.sceneRT.textures.length > 1) {
      this.gl2.clearBufferfv(this.gl2.COLOR, 1, GBUFFER_CLEAR);
    }
    renderer.render(this.engine.scene, this.engine.camera);

    // The harness retargets the camera between shots and the rig kicks FOV with
    // speed, so the composite's view-ray reconstruction is refreshed per frame.
    const cam = this.engine.camera;
    this.compositeMat.uniforms.uTanHalfFov!.value = Math.tan(cam.fov * 0.5 * THREE.MathUtils.DEG2RAD);
    this.compositeMat.uniforms.uAspect!.value = cam.aspect;

    // --- 2. bloom ----------------------------------------------------------
    if (this.bloomEnabled) {
      const bw = this.bloomA.width;
      const bh = this.bloomA.height;

      // bright + downsample: full res -> bloomA (half res)
      this.tri.material = this.brightMat;
      renderer.setRenderTarget(this.bloomA);
      renderer.render(this.triScene, this.triCamera);

      // horizontal: bloomA -> bloomB
      this.tri.material = this.blurMat;
      this.blurMat.uniforms.uSource!.value = this.bloomA.textures[0]!;
      (this.blurMat.uniforms.uDirection!.value as THREE.Vector2)
        .set(BLOOM_RADIUS / bw, 0);
      renderer.setRenderTarget(this.bloomB);
      renderer.render(this.triScene, this.triCamera);

      // vertical: bloomB -> bloomA (which the composite samples)
      this.blurMat.uniforms.uSource!.value = this.bloomB.textures[0]!;
      (this.blurMat.uniforms.uDirection!.value as THREE.Vector2)
        .set(0, BLOOM_RADIUS / bh);
      renderer.setRenderTarget(this.bloomA);
      renderer.render(this.triScene, this.triCamera);
    }

    // --- 3. composite to the screen ----------------------------------------
    this.tri.material = this.compositeMat;
    renderer.setRenderTarget(null);
    renderer.render(this.triScene, this.triCamera);

    renderer.autoClear = prevAutoClear;
  }

  // --------------------------------------------------------------- teardown --

  dispose(): void {
    this.sceneRT.dispose();
    this.bloomA.dispose();
    this.bloomB.dispose();
    this.tri.geometry.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
  }
}
