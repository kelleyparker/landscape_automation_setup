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
  /** Fade the ink toward the fog colour with distance. */
  fadeStart?: number;
  fadeEnd?: number;
  /** Render order offset; outlines must draw before their surface. */
  renderOrder?: number;
}

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

export class OutlineMaterial extends THREE.ShaderMaterial {
  constructor(opts: OutlineOptions = {}) {
    super({
      name: 'OutlineMaterial',
      glslVersion: THREE.GLSL3,
      side: THREE.BackSide,
      // Ink must not be lit, must not receive fog from three, and must write
      // depth so it occludes correctly against other boats.
      depthWrite: true,
      depthTest: true,
      lights: false,
      uniforms: {
        uThickness: { value: opts.thickness ?? 2.6 },
        uWorldPad: { value: opts.worldPad ?? 0.004 },
        uColor: { value: (opts.color ?? PALETTE.ink).clone() },
        uFadeStart: { value: opts.fadeStart ?? 220 },
        uFadeEnd: { value: opts.fadeEnd ?? 1200 },
        uResolution: OUTLINE_GLOBALS.uResolution,
        uFogColor: OUTLINE_GLOBALS.uFogColor,
      },
      vertexShader: /* glsl */ `
in vec3 ${SMOOTH_NORMAL_ATTR};
uniform float uThickness;
uniform float uWorldPad;
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
  vViewDepth = -mvPos.z;
  vec4 clip = projectionMatrix * mvPos;

  // Screen-space push: project the normal into clip space and offset by an
  // exact pixel count. This is what keeps the line width constant.
  vec3 viewNrm = normalize(mat3(viewMatrix) * worldNrm);
  vec2 clipNrm = normalize((projectionMatrix * vec4(viewNrm, 0.0)).xy + 1e-6);
  clip.xy += clipNrm * (uThickness * 2.0 / uResolution) * clip.w;

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
uniform float uCameraFarOutline;
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
  // Match the source mesh's local transform - the shell is a sibling, so it
  // needs the same placement.
  shell.position.copy(mesh.position);
  shell.quaternion.copy(mesh.quaternion);
  shell.scale.copy(mesh.scale);
  mesh.parent?.add(shell);
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
