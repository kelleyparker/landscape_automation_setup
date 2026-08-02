import * as THREE from 'three';
import { PALETTE, SUN_DIR, AMBIENT } from '../core/Palette';
import { TEX } from '../core/Textures';
import {
  GBUFFER_OUT, OCT_PACK, GBUFFER_WRITE, CEL_LIGHTING, CEL_VARYINGS, CEL_VARYINGS_FRAG,
} from './shaders/celChunks';

/**
 * The one material every solid surface in WAVEBREAK uses.
 *
 * It is a GLSL3 `ShaderMaterial` writing two render targets (colour +
 * normal/depth), so the screen-space edge pass has a proper G-buffer to work
 * with. Lighting is entirely non-physical: a quantised ramp, a hard specular
 * step, a fresnel rim and a matcap. There is no roughness, no metalness, no
 * environment probe and no light rig - the sun is a single uniform vector.
 *
 * Injection points (`vertexHead`/`vertexBody`/`fragmentHead`/`fragmentBody`)
 * let subsystems add displacement or custom colouring without forking the
 * shader, which keeps the look consistent across boats, riders and course
 * furniture.
 */

export interface CelOptions {
  color?: THREE.Color;
  /** Overrides the default 4-band ramp. */
  ramp?: THREE.Texture;
  matcap?: THREE.Texture | null;
  matcapStrength?: number;
  rimColor?: THREE.Color;
  rimPower?: number;
  rimStrength?: number;
  /**
   * Where the rim band starts, in 0..1 fresnel space. Hard threshold, not a
   * falloff. Lower = wider contour.
   */
  rimThreshold?: number;
  /** Distance from the outer rim edge to the hotter inner step. */
  rimWidth?: number;
  /**
   * Slides the whole diffuse band set along the ramp. Positive walks the
   * terminator toward the shadow side, which is how a symmetric figure avoids a
   * terminator down its own centreline.
   */
  bandBias?: number;
  /**
   * Floor colour for the darkest band. Nothing rendered through this material
   * is allowed below its luma - a near-black fill reads as missing geometry.
   */
  shadowFloor?: THREE.Color;
  specColor?: THREE.Color;
  specThreshold?: number;
  specPower?: number;
  specStrength?: number;
  specSoftness?: number;
  /** Light wrap, 0..1. Round forms want ~0.25; flat panels want ~0.05. */
  wrap?: number;
  /** Additive self-illumination, multiplied by `color`. */
  emissive?: number;
  /** How strongly the screen-space Sobel pass draws interior lines here. */
  edgeMask?: number;
  /** Multiply albedo by the geometry's vertex colours. */
  vertexColors?: boolean;
  transparent?: boolean;
  opacity?: number;
  depthWrite?: boolean;
  side?: THREE.Side;
  /** Extra uniforms merged in; also visible to the injection points. */
  uniforms?: Record<string, THREE.IUniform>;
  vertexHead?: string;
  vertexBody?: string;
  fragmentHead?: string;
  fragmentBody?: string;
  defines?: Record<string, string | number | boolean>;
  name?: string;
}

const DEFAULTS: Required<Omit<CelOptions,
  'ramp' | 'matcap' | 'uniforms' | 'vertexHead' | 'vertexBody' | 'fragmentHead' | 'fragmentBody' | 'defines' | 'name' | 'side' | 'color' | 'rimColor' | 'specColor' | 'shadowFloor'>> = {
  matcapStrength: 0.1,
  rimPower: 2.2,
  rimStrength: 0.9,
  rimThreshold: 0.52,
  rimWidth: 0.2,
  bandBias: 0,
  specThreshold: 0.62,
  specPower: 44,
  specStrength: 0.9,
  specSoftness: 0.012,
  wrap: 0.22,
  emissive: 0,
  edgeMask: 1,
  vertexColors: false,
  transparent: false,
  opacity: 1,
  depthWrite: true,
};

/**
 * The floor every solid surface is lifted to. A cool navy, not a grey: the
 * darks in this palette are a colour, and lifting toward neutral would drain
 * them. Sits at roughly 13% luma, which is the point where a mass stops reading
 * as a hole in the model and starts reading as shadow.
 */
const SHADOW_FLOOR = new THREE.Color(0.028, 0.045, 0.135);

export class CelMaterial extends THREE.ShaderMaterial {
  declare uniforms: Record<string, THREE.IUniform>;

  constructor(opts: CelOptions = {}) {
    const o = { ...DEFAULTS, ...opts };
    const color = opts.color ?? PALETTE.hullLight;
    const rimColor = opts.rimColor ?? PALETTE.waterCrest;
    const specColor = opts.specColor ?? PALETTE.hullLight;

    const uniforms: Record<string, THREE.IUniform> = {
      uColor: { value: color.clone() },
      uRamp: { value: opts.ramp ?? TEX.ramp },
      uSunDir: { value: SUN_DIR.clone() },
      uSunColor: { value: new THREE.Color(1.0, 0.985, 0.94) },
      uAmbient: { value: AMBIENT.clone() },
      uShadowFloor: { value: (opts.shadowFloor ?? SHADOW_FLOOR).clone() },
      uBandBias: { value: o.bandBias },
      uRimColor: { value: rimColor.clone() },
      uRimPower: { value: o.rimPower },
      uRimStrength: { value: o.rimStrength },
      uRimThreshold: { value: o.rimThreshold },
      uRimWidth: { value: o.rimWidth },
      uSpecColor: { value: specColor.clone() },
      uSpecThreshold: { value: o.specThreshold },
      uSpecPower: { value: o.specPower },
      uSpecStrength: { value: o.specStrength },
      uSpecSoftness: { value: o.specSoftness },
      uMatcap: { value: opts.matcap === null ? TEX.matcapGloss : (opts.matcap ?? TEX.matcapGloss) },
      uMatcapStrength: { value: opts.matcap === null ? 0 : o.matcapStrength },
      uWrap: { value: o.wrap },
      uEmissive: { value: o.emissive },
      uEdgeMask: { value: o.edgeMask },
      uOpacity: { value: o.opacity },
      uCameraFar: { value: 4200 },
      uTime: { value: 0 },
      ...(opts.uniforms ?? {}),
    };

    const defines: Record<string, string | number | boolean> = { ...(opts.defines ?? {}) };
    if (o.vertexColors) defines.WB_VERTEX_COLOR = 1;

    super({
      name: opts.name ?? 'CelMaterial',
      glslVersion: THREE.GLSL3,
      uniforms,
      defines,
      lights: false,
      transparent: o.transparent,
      depthWrite: o.depthWrite,
      side: opts.side ?? THREE.FrontSide,
      vertexColors: false, // handled manually so instancing colours also work
      vertexShader: /* glsl */ `
${CEL_VARYINGS}
uniform float uTime;
#ifdef WB_VERTEX_COLOR
in vec3 color;
#endif
#include <skinning_pars_vertex>
${opts.vertexHead ?? ''}

void main() {
  vec3 objectPosition = position;
  vec3 objectNormal = normal;
  vColorMul = vec3(1.0);
#ifdef WB_VERTEX_COLOR
  vColorMul = color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColorMul *= instanceColor;
#endif

${opts.vertexBody ?? ''}

  vec3 transformed = objectPosition;
  vec3 transformedNormal = objectNormal;

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
    transformed = ( skinMatrix * vec4( transformed, 1.0 ) ).xyz;
    transformedNormal = normalize( ( skinMatrix * vec4( transformedNormal, 0.0 ) ).xyz );
  }
#endif

  mat4 modelMat = modelMatrix;
  mat3 normalMat = normalMatrix;
#ifdef USE_INSTANCING
  modelMat = modelMatrix * instanceMatrix;
  normalMat = normalMatrix * mat3(instanceMatrix);
#endif

  vec4 worldPos = modelMat * vec4(transformed, 1.0);
  vWorldPos = worldPos.xyz;
  vWorldNormal = normalize(mat3(modelMat) * transformedNormal);
  vec4 mvPos = viewMatrix * worldPos;
  vViewNormal = normalize(normalMat * transformedNormal);
  vViewDepth = -mvPos.z;
  gl_Position = projectionMatrix * mvPos;
}
`,
      fragmentShader: /* glsl */ `
precision highp float;
${GBUFFER_OUT}
${CEL_VARYINGS_FRAG}
${OCT_PACK}
${GBUFFER_WRITE}
${CEL_LIGHTING}
uniform vec3  uColor;
uniform float uEmissive;
uniform float uEdgeMask;
uniform float uOpacity;
uniform float uTime;
${opts.fragmentHead ?? ''}

void main() {
  vec3 albedo = uColor * vColorMul;
  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uSunDir);
  float alpha = uOpacity;
  float edgeMask = uEdgeMask;

${opts.fragmentBody ?? ''}

  vec3 col = wbCelDiffuse(albedo, N, L);
  vec3 spec = wbCelSpecular(N, V, L);
  col += spec * (albedo * 0.35 + 0.65);
  col += wbCelRim(N, V, L);
  col += wbMatcap(normalize(vViewNormal)) * uMatcapStrength * albedo;
  col += albedo * uEmissive;

  gColor = vec4(col, alpha);
  wbWriteGBuffer(normalize(vViewNormal), vViewDepth, edgeMask);
}
`,
    });
  }

  get color(): THREE.Color { return this.uniforms.uColor!.value as THREE.Color; }
  set color(c: THREE.Color) { (this.uniforms.uColor!.value as THREE.Color).copy(c); }

  setTime(t: number): void { this.uniforms.uTime!.value = t; }
}

/** Convenience factory so call sites read as data rather than as `new`. */
export function makeCelMaterial(opts: CelOptions = {}): CelMaterial {
  return new CelMaterial(opts);
}

// -------------------------------------------------------------------------
// Presets. Subsystems should reach for these before inventing new tunings, so
// the whole game keeps one lighting response.
// -------------------------------------------------------------------------

export const CEL_PRESETS = {
  /**
   * Glossy painted hull.
   *
   * The matcap is held right down. It used to sit at 0.2 and, minified onto a
   * hull, it smeared a soft radial gradient across exactly the planes the band
   * step was supposed to break - the hull ended up one flat fill with a
   * gradient on top. The banding does the work now; the matcap is a garnish.
   *
   * Rim is on hard and always: the hull's shadow side sits against deep water
   * of almost the same value, and a thin ink line alone is not enough to keep
   * them apart at distance.
   */
  hull: (color: THREE.Color): CelOptions => ({
    color,
    matcap: TEX.matcapGloss,
    matcapStrength: 0.08,
    specPower: 62,
    specThreshold: 0.55,
    specStrength: 0.85,
    rimColor: PALETTE.waterCrest,
    rimStrength: 1.25,
    rimPower: 2.0,
    rimThreshold: 0.46,
    rimWidth: 0.24,
    wrap: 0.18,
    bandBias: 0.06,
    edgeMask: 1.0,
  }),
  /**
   * Brushed metal trim and hard-surface course furniture.
   *
   * The matcap was carrying this material at 0.45, which is why a gate pylon
   * read as a smoothly shaded cylinder: the ramp bands were there but a
   * mip-averaged radial gradient sat over the top of them at nearly half
   * strength. Down to 0.14, and the diffuse bands carry the form.
   */
  metal: (color: THREE.Color): CelOptions => ({
    color,
    matcap: TEX.matcapMetal,
    matcapStrength: 0.14,
    specPower: 28,
    specThreshold: 0.48,
    specStrength: 1.0,
    rimColor: PALETTE.waterCrest,
    rimStrength: 1.0,
    rimPower: 2.0,
    rimThreshold: 0.5,
    rimWidth: 0.22,
    wrap: 0.08,
    edgeMask: 0.9,
  }),
  /** Skin: soft wrap, almost no spec, warm bounce from the matcap. */
  skin: (color: THREE.Color): CelOptions => ({
    color,
    matcap: TEX.matcapSkin,
    matcapStrength: 0.12,
    specPower: 20,
    specThreshold: 0.86,
    specStrength: 0.25,
    rimColor: PALETTE.sunGlow,
    rimStrength: 0.9,
    rimPower: 2.6,
    rimThreshold: 0.5,
    rimWidth: 0.22,
    wrap: 0.34,
    bandBias: 0.1,
    edgeMask: 0.55,
  }),
  /**
   * Matte fabric / rubber - the rider's suit.
   *
   * bandBias is the load-bearing value here. With the bias at zero the
   * terminator landed on the centreline of a symmetric standing figure and cut
   * it into two flat panels. Pushing it positive walks the boundary around to
   * roughly three-quarters across the torso, so the lit side reads as the front
   * of a volume and the shadow as its turning edge. The wrap is tighter than it
   * was for the same reason: a wide wrap flattens the step out along the ribs.
   *
   * The rim is cream rather than cyan: the rider has to separate from the hull
   * as well as from the water, and the hull's rim is already cyan.
   */
  cloth: (color: THREE.Color): CelOptions => ({
    color,
    matcap: null,
    specStrength: 0.12,
    specThreshold: 0.9,
    rimColor: PALETTE.foam,
    rimStrength: 1.15,
    rimPower: 2.0,
    rimThreshold: 0.44,
    rimWidth: 0.24,
    wrap: 0.3,
    bandBias: 0.14,
    edgeMask: 0.8,
  }),
  /** Glowing course furniture: mostly emissive, no interior lines. */
  glow: (color: THREE.Color, emissive = 0.9): CelOptions => ({
    color,
    matcap: null,
    emissive,
    specStrength: 0,
    rimColor: color,
    rimStrength: 1.4,
    rimPower: 1.6,
    wrap: 0.5,
    edgeMask: 0.25,
  }),
} as const;
