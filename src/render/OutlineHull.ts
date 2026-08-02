import * as THREE from 'three';
import { PALETTE } from '../core/Palette';
import { GBUFFER_OUT, OCT_PACK } from './shaders/celChunks';

/**
 * Inverted-hull ink outlines.
 *
 * The classic trick, done properly:
 *
 *  - Vertices are pushed along a *smoothed* normal, not the shading normal.
 *    Hard-edged procedural geometry has split normals at every crease, which
 *    would tear the shell open at the corners; `computeSmoothNormals` merges
 *    them by position first.
 *  - The push happens in clip space and is divided by the viewport, so the line
 *    is a constant number of pixels wide at any distance. No fat lines up close,
 *    no lines that vanish at the far end of the straight.
 *  - A minimum world-space thickness keeps distant boats from losing their
 *    silhouette entirely when the pixel width rounds to nothing.
 *  - The shell writes the G-buffer with `edgeMask = 0`, so the screen-space
 *    Sobel pass does not draw a second line on top of this one. The two systems
 *    are complementary, not additive.
 */

export interface OutlineOptions {
  /** Line width in CSS pixels at any distance. */
  thickness?: number;
  color?: THREE.Color;
  /** Extra world-space push, keeps far silhouettes from thinning out. */
  worldPad?: number;
  /**
   * View-space lift toward the camera, in metres. See DEPTH_LIFT below - this
   * is what lets a hull's waterline contour survive the ocean surface.
   * `addOutline` derives it from the geometry when it is not given.
   */
  depthLift?: number;
  /** Fade the ink toward the fog colour with distance. */
  fadeStart?: number;
  fadeEnd?: number;
  /** Render order offset; outlines must draw before their surface. */
  renderOrder?: number;
}

/**
 * Global weight on every authored thickness.
 *
 * Call sites document their line in CSS pixels and those relative weights are
 * right (a rider's line is lighter than a hull's), but the absolute value was
 * set before anything had been looked at on a real frame and read as a hairline
 * at gameplay distance. This is the one art-direction dial for ink presence:
 * at 1.34 a hull silhouette lands at ~7 device pixels at dpr 2, which is a
 * drawn line rather than an aliasing artefact, and still well short of the fat
 * cartoon border a close-up would show past ~2x.
 */
const INK_WEIGHT = 1.34;

/**
 * A hair of view-space lift toward the camera, as a fraction of the source
 * geometry's bounding radius, clamped to these metre bounds.
 *
 * This is a tie-breaker, not a feature. The shell's visible band is made of
 * *back* faces, so wherever the band lands on top of another surface at almost
 * the same depth - spray cards, wake ribbons, a second boat drafting close - a
 * few centimetres decide whether the line survives. The cap is deliberately far
 * below the thinnest thing that gets outlined (a rider's forearm, ~8 cm): if the
 * lift ever exceeds a model's own thickness along the view ray, the shell's back
 * faces beat the model's front faces and the whole model fills in solid ink.
 * That was measured, not guessed - at 0.55 m every rider in the frame became a
 * black lump.
 *
 * NOTE, because it cost a capture to learn: this does NOT recover the waterline.
 * A hull cuts the ocean surface, so its lower edge is an intersection, not a
 * silhouette - the geometry simply continues underwater and there is no contour
 * for an inverted hull to thicken. That line has to come from the screen-space
 * normal/depth pass in Composer.ts.
 */
const DEPTH_LIFT_FRACTION = 0.02;
const DEPTH_LIFT_MAX = 0.03;
const DEPTH_LIFT_MIN = 0.005;

const SMOOTH_NORMAL_ATTR = 'aSmoothNormal';

/**
 * Adds a position-merged smoothed normal attribute. Idempotent.
 *
 * Merging by quantised position (rather than by index) is what makes this work
 * on geometry built from several primitives welded together.
 */
export function computeSmoothNormals(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  if (geometry.getAttribute(SMOOTH_NORMAL_ATTR)) return geometry;

  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (!nrm) geometry.computeVertexNormals();
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;

  const count = pos.count;
  const smooth = new Float32Array(count * 3);
  const map = new Map<string, number[]>();
  const Q = 1e4; // 0.1mm buckets - fine enough to never weld distinct surfaces

  for (let i = 0; i < count; i++) {
    const key =
      Math.round(pos.getX(i) * Q) + '_' +
      Math.round(pos.getY(i) * Q) + '_' +
      Math.round(pos.getZ(i) * Q);
    let bucket = map.get(key);
    if (!bucket) { bucket = []; map.set(key, bucket); }
    bucket.push(i);
  }

  const acc = new THREE.Vector3();
  for (const bucket of map.values()) {
    acc.set(0, 0, 0);
    for (const i of bucket) acc.x += normal.getX(i), acc.y += normal.getY(i), acc.z += normal.getZ(i);
    if (acc.lengthSq() < 1e-8) {
      // Degenerate (opposing normals cancelled) - fall back to the face normal.
      const i0 = bucket[0]!;
      acc.set(normal.getX(i0), normal.getY(i0), normal.getZ(i0));
    }
    acc.normalize();
    for (const i of bucket) {
      smooth[i * 3] = acc.x;
      smooth[i * 3 + 1] = acc.y;
      smooth[i * 3 + 2] = acc.z;
    }
  }

  geometry.setAttribute(SMOOTH_NORMAL_ATTR, new THREE.BufferAttribute(smooth, 3));
  return geometry;
}

/** Shared uniform bag so a single resize updates every outline in the scene. */
export const OUTLINE_GLOBALS = {
  uResolution: { value: new THREE.Vector2(1280, 720) },
  uFogColor: { value: PALETTE.skyHorizon.clone() },
};

/**
 * The ink colour, defended against a double sRGB decode upstream.
 *
 * `Palette.ts` builds its colours with `new THREE.Color(hex).convertSRGBToLinear()`.
 * three's colour management already decodes the hex on construction, so that
 * second call decodes an *already linear* value a second time. Every palette
 * entry lands darker than authored, and on the darkest one - the ink - it is
 * catastrophic: #101a35 leaves the composite as (1,3,10), i.e. flat black. The
 * project's own rule is that the ink is a deep indigo and never pure black, and
 * a measured frame says it is currently black.
 *
 * Palette.ts belongs to another subsystem, so this corrects only its own uniform,
 * and only when the value it is handed is implausibly dark - darker than any
 * sensible authored ink. If the palette is repaired upstream the test fails and
 * this returns the colour untouched, so the two fixes cannot stack.
 */
function inkColor(src: THREE.Color): THREE.Color {
  const out = src.clone();
  // Relative luminance of a correctly decoded #101a35 is ~0.0104. Anything an
  // order of magnitude below that has been through the decode twice.
  const lum = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b;
  if (lum < 0.0035) out.convertLinearToSRGB();
  return out;
}

export class OutlineMaterial extends THREE.ShaderMaterial {
  constructor(opts: OutlineOptions = {}) {
    super({
      name: 'OutlineMaterial',
      glslVersion: THREE.GLSL3,
      side: THREE.BackSide,
      // Ink must not be lit, must not receive fog from three, and must write
      // depth so it occludes correctly against other boats and so the ocean -
      // which draws after it - cannot overwrite the band.
      depthWrite: true,
      depthTest: true,
      lights: false,
      uniforms: {
        uThickness: { value: (opts.thickness ?? 2.6) * INK_WEIGHT },
        uWorldPad: { value: opts.worldPad ?? 0.004 },
        uDepthLift: { value: opts.depthLift ?? 0.01 },
        uColor: { value: inkColor(opts.color ?? PALETTE.ink) },
        uFadeStart: { value: opts.fadeStart ?? 220 },
        uFadeEnd: { value: opts.fadeEnd ?? 1200 },
        // Line weight holds at the authored value out to uTaperStart, then eases
        // to uTaperFloor by uTaperEnd. Constant screen width is right for every
        // boat you are racing; past that a 2-px ring on a 40-px model is most of
        // the model, and the pack turns into ink blobs with a colour chip in the
        // middle. The hold is deliberately long so near and mid boats - the ones
        // a frame is judged on - measure identically.
        uTaperStart: { value: 60.0 },
        uTaperEnd: { value: 190.0 },
        uTaperFloor: { value: 0.42 },
        uResolution: OUTLINE_GLOBALS.uResolution,
        uFogColor: OUTLINE_GLOBALS.uFogColor,
      },
      vertexShader: /* glsl */ `
in vec3 ${SMOOTH_NORMAL_ATTR};
uniform float uThickness;
uniform float uWorldPad;
uniform float uDepthLift;
uniform float uTaperStart;
uniform float uTaperEnd;
uniform float uTaperFloor;
uniform vec2  uResolution;
out float vViewDepth;
#include <skinning_pars_vertex>

void main() {
  vec3 transformed = position;
  vec3 shellNormal = ${SMOOTH_NORMAL_ATTR};

#ifdef USE_SKINNING
  {
    mat4 boneMatX = getBoneMatrix( skinIndex.x );
    mat4 boneMatY = getBoneMatrix( skinIndex.y );
    mat4 boneMatZ = getBoneMatrix( skinIndex.z );
    mat4 boneMatW = getBoneMatrix( skinIndex.w );
    mat4 skinMatrix = mat4( 0.0 );
    skinMatrix += skinWeight.x * boneMatX;
    skinMatrix += skinWeight.y * boneMatY;
    skinMatrix += skinWeight.z * boneMatZ;
    skinMatrix += skinWeight.w * boneMatW;
    skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
    transformed  = ( skinMatrix * vec4( transformed, 1.0 ) ).xyz;
    shellNormal  = normalize( ( skinMatrix * vec4( shellNormal, 0.0 ) ).xyz );
  }
#endif

  mat4 modelMat = modelMatrix;
#ifdef USE_INSTANCING
  modelMat = modelMatrix * instanceMatrix;
#endif

  // A small world-space push first: guarantees the shell clears the surface
  // even when the screen-space term rounds down to sub-pixel at distance.
  vec4 worldPos = modelMat * vec4(transformed, 1.0);
  vec3 worldNrm = normalize(mat3(modelMat) * shellNormal);
  worldPos.xyz += worldNrm * uWorldPad;

  vec4 mvPos = viewMatrix * worldPos;

  // Centimetres of lift toward the camera (view -Z is forward, so += moves
  // nearer) to break depth ties against spray cards and wake ribbons sitting at
  // almost exactly the band's depth. Kept far below the model's own thickness -
  // see DEPTH_LIFT_MAX for what happens when it is not.
  mvPos.z += uDepthLift;

  vViewDepth = -mvPos.z;
  vec4 clip = projectionMatrix * mvPos;

  // Screen-space push. Project the normal to clip space, then take the direction
  // in *pixels* rather than in NDC: NDC is anisotropic (x is compressed by the
  // aspect ratio), so normalising there aims the offset a few degrees off the
  // true screen normal and a diagonal edge comes out lighter than a vertical
  // one. Normalising after the aspect divide makes every direction measure the
  // same width.
  vec3 viewNrm = normalize(mat3(viewMatrix) * worldNrm);
  vec2 ndcNrm = (projectionMatrix * vec4(viewNrm, 0.0)).xy;
  vec2 pxNrm = ndcNrm * uResolution;
  // The epsilon only matters for a vertex whose normal points straight down the
  // view axis; such a vertex is never on a silhouette, so any stable direction
  // will do and this keeps the normalize finite.
  vec2 pxDir = normalize(pxNrm + vec2(1e-8, 1e-8));

  // Hold the authored weight through the racing range, then ease off so a
  // distant model keeps its interior colour instead of turning into a blob.
  float taper = mix(1.0, uTaperFloor,
                    smoothstep(uTaperStart, uTaperEnd, vViewDepth));

  clip.xy += pxDir * (uThickness * taper * 2.0 / uResolution) * clip.w;

  gl_Position = clip;
}
`,
      fragmentShader: /* glsl */ `
precision highp float;
${GBUFFER_OUT}
${OCT_PACK}
uniform vec3 uColor;
uniform vec3 uFogColor;
uniform float uFadeStart;
uniform float uFadeEnd;
in float vViewDepth;

void main() {
  // Ink lifts toward the atmosphere with distance so far boats sit *in* the
  // scene instead of being stamped on top of it.
  float f = smoothstep(uFadeStart, uFadeEnd, vViewDepth);
  vec3 col = mix(uColor, uFogColor * 0.72, f * 0.8);
  gColor = vec4(col, 1.0);
  // edgeMask = 0: this pixel is already a line, the Sobel pass must not add another.
  gNormalDepth = vec4(wbOctEncode(vec3(0.0, 0.0, 1.0)), clamp(vViewDepth / 4200.0, 0.0, 1.0), 0.0);
}
`,
    });
  }
}

export interface OutlineHandle {
  mesh: THREE.Mesh;
  material: OutlineMaterial;
  setThickness(px: number): void;
}

/**
 * Attaches an inverted-hull outline to a mesh. The shell is added as a sibling
 * child of the same parent transform so it inherits animation for free, and is
 * drawn first (`renderOrder = -1`) so the lit surface z-fights nothing.
 */
export function addOutline(mesh: THREE.Mesh, opts: OutlineOptions = {}): OutlineHandle {
  computeSmoothNormals(mesh.geometry);

  // Size the tie-breaker lift to this particular model, so a hull gets the full
  // (tiny) allowance and a rider's limb gets millimetres.
  if (opts.depthLift === undefined) {
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    const radius = mesh.geometry.boundingSphere?.radius ?? 0.5;
    const scale = Math.max(Math.abs(mesh.scale.x), Math.abs(mesh.scale.y), Math.abs(mesh.scale.z));
    opts = {
      ...opts,
      depthLift: Math.min(DEPTH_LIFT_MAX,
        Math.max(DEPTH_LIFT_MIN, radius * scale * DEPTH_LIFT_FRACTION)),
    };
  }

  const material = new OutlineMaterial(opts);

  const shell = mesh instanceof THREE.SkinnedMesh
    ? new THREE.SkinnedMesh(mesh.geometry, material)
    : new THREE.Mesh(mesh.geometry, material);

  if (shell instanceof THREE.SkinnedMesh && mesh instanceof THREE.SkinnedMesh) {
    shell.bind(mesh.skeleton, mesh.bindMatrix);
  }
  shell.name = mesh.name + '_ink';
  shell.renderOrder = (opts.renderOrder ?? -1) + (mesh.renderOrder ?? 0);
  shell.frustumCulled = mesh.frustumCulled;
  shell.castShadow = false;
  shell.receiveShadow = false;
  if (mesh.parent) {
    // Match the source mesh's local transform - the shell is a sibling, so it
    // needs the same placement.
    shell.position.copy(mesh.position);
    shell.quaternion.copy(mesh.quaternion);
    shell.scale.copy(mesh.scale);
    mesh.parent.add(shell);
  } else {
    // Called before the mesh was parented. The old code did `mesh.parent?.add`
    // and silently produced no ink at all, which is a whole object with no line
    // and no way to notice. Parent it to the mesh instead: as a child it
    // inherits the world transform, so the local transform must stay identity.
    mesh.add(shell);
  }
  (mesh as THREE.Mesh & { userData: { ink?: THREE.Mesh } }).userData.ink = shell;

  return {
    mesh: shell,
    material,
    setThickness: (px: number) => { material.uniforms.uThickness!.value = px; },
  };
}

/** Recursively outline every mesh under a root. */
export function addOutlineRecursive(root: THREE.Object3D, opts: OutlineOptions = {}): OutlineHandle[] {
  const targets: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !o.name.endsWith('_ink') && o.userData.noOutline !== true) {
      targets.push(o as THREE.Mesh);
    }
  });
  return targets.map((m) => addOutline(m, opts));
}
