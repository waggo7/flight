import { Color, DoubleSide, MeshPhysicalMaterial, MeshStandardMaterial } from 'three';
import type { Material, WebGLProgramParametersWithUniforms } from 'three';
import type { HeroPalette } from '../../../core/hero-definition';
import { afterInclude } from '../world/atmosphere';

// A hero's materials, built per hero from its palette (v1 shared module-level singletons):
//   suit  the body; panel seams and a faint weave drawn from bind-pose (object-space) coordinates
//   trim  gloves, boots, belt, mask and the emblem, in vertex colours: aSurface 0 = trim cloth,
//         1 = accent metal, 2 = glowing accent (emblem, lenses), which brightens with uGlow
//   skin  skin, hair, eyes and lips, in vertex colours
//   cape  the cloth cape (double-sided, the inside shaded)
// Every one keeps v1's warm rim light, patched in only through the checked `afterInclude`.

export interface HeroMaterialSet {
  readonly suit: MeshPhysicalMaterial;
  readonly trim: MeshPhysicalMaterial;
  readonly skin: MeshStandardMaterial;
  readonly cape: MeshPhysicalMaterial;
  /** 0..1: boost or slam charge; the emblem glows with it. */
  setGlow(amount: number): void;
  dispose(): void;
}

interface RimLight {
  strength: number;
  color: string;
  /** Multiplies the colour of back faces (the inside of the cape). */
  innerShade: number;
}

type ShaderPatch = (shader: WebGLProgramParametersWithUniforms, where: string) => void;

/** Rim light (v1's hero look) plus an optional material-specific patch, under one cache key. */
function patchHeroMaterial<M extends Material>(material: M, key: string, rim: RimLight, patch?: ShaderPatch): M {
  const rimColor = new Color(rim.color);
  const where = `hero ${key} material`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.uniforms.uRimStrength = { value: rim.strength };
    let fragment = afterInclude(shader.fragmentShader, 'common', 'uniform vec3 uRimColor;\nuniform float uRimStrength;', where);
    fragment = afterInclude(fragment, 'color_fragment', `diffuseColor.rgb *= gl_FrontFacing ? 1.0 : ${rim.innerShade.toFixed(2)};`, where);
    fragment = afterInclude(
      fragment,
      'emissivemap_fragment',
      `float rimFacing = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
totalEmissiveRadiance += uRimColor * pow(rimFacing, 3.0) * uRimStrength;`,
      where,
    );
    shader.fragmentShader = fragment;
    patch?.(shader, where);
  };
  material.customProgramCacheKey = () => `hero-${key}:${rim.strength}:${rim.innerShade}`;
  return material;
}

/** Suit: seams and weave from the bind-pose position, so they stay on the body as it moves. */
const patchSuit: ShaderPatch = (shader, where) => {
  shader.vertexShader = afterInclude(shader.vertexShader, 'common', 'varying vec3 vSuitPosition;', where);
  shader.vertexShader = afterInclude(shader.vertexShader, 'begin_vertex', 'vSuitPosition = position;', where);
  let fragment = afterInclude(
    shader.fragmentShader,
    'common',
    /* glsl */ `varying vec3 vSuitPosition;
uniform float uSuitScale;
// 0..1 closeness to a line where f = 0, anti-aliased by the screen-space rate of f.
float seamLine(float f, float width) {
  float w = max(fwidth(f), 1e-5);
  return 1.0 - smoothstep(width, width + w * 1.5, abs(f));
}
float suitSeams(vec3 p) {
  float s = 0.0;
  float ax = abs(p.x);
  // Torso panels: a waist band, a V from the shoulders to the sternum, side seams.
  if (ax < 0.24 && p.y > -0.22 && p.y < 0.47) {
    s = max(s, seamLine(p.y - 0.02, 0.0028));
    if (p.z > 0.0 && p.y > 0.12) s = max(s, seamLine((p.y - 0.45) + 0.95 * ax, 0.0025));
    s = max(s, seamLine(p.z + 0.01, 0.0025) * step(0.1, ax));
  }
  // Limbs: a seam down the outside of each arm and leg.
  if (p.y < -0.24 || ax > 0.25) s = max(s, seamLine(p.z, 0.0022) * step(0.05, ax));
  return s;
}
float suitWeave(vec3 p) {
  vec2 q = vec2(p.x + p.z, p.y) * 900.0;
  float fade = 1.0 - smoothstep(0.35, 0.9, max(fwidth(q.x), fwidth(q.y)));
  return (sin(q.x) * sin(q.y)) * fade;
}`,
    where,
  );
  fragment = afterInclude(
    fragment,
    'color_fragment',
    /* glsl */ `vec3 suitP = vSuitPosition / uSuitScale;
float suitSeam = suitSeams(suitP);
float suitThread = suitWeave(suitP);
diffuseColor.rgb *= (1.0 - 0.22 * suitSeam) * (1.0 + 0.025 * suitThread);`,
    where,
  );
  fragment = afterInclude(fragment, 'roughnessmap_fragment', 'roughnessFactor = clamp(roughnessFactor + 0.18 * suitSeam + 0.04 * suitThread, 0.0, 1.0);', where);
  shader.fragmentShader = fragment;
};

function createTrimPatch(glowUniform: { value: number }): ShaderPatch {
  return (shader, where) => {
    shader.uniforms.uGlow = glowUniform;
    shader.vertexShader = afterInclude(shader.vertexShader, 'common', 'attribute float aSurface;\nvarying float vSurface;', where);
    shader.vertexShader = afterInclude(shader.vertexShader, 'begin_vertex', 'vSurface = aSurface;', where);
    let fragment = afterInclude(shader.fragmentShader, 'common', 'varying float vSurface;\nuniform float uGlow;', where);
    fragment = afterInclude(fragment, 'roughnessmap_fragment', 'roughnessFactor = mix(roughnessFactor, 0.26, clamp(vSurface, 0.0, 1.0));', where);
    fragment = afterInclude(fragment, 'metalnessmap_fragment', 'metalnessFactor = mix(metalnessFactor, 0.92, clamp(vSurface, 0.0, 1.0) * (1.0 - step(1.5, vSurface) * 0.6));', where);
    fragment = afterInclude(
      fragment,
      'emissivemap_fragment',
      'totalEmissiveRadiance += diffuseColor.rgb * step(1.5, vSurface) * (0.35 + 3.2 * uGlow);',
      where,
    );
    shader.fragmentShader = fragment;
  };
}

/** Fresh materials for one hero. `scale` = the rig's size factor (seams are laid out for scale 1). */
export function createHeroMaterials(palette: Readonly<HeroPalette>, scale = 1): HeroMaterialSet {
  const glow = { value: 0 };
  const suitScale = { value: scale };
  const suit = patchHeroMaterial(
    new MeshPhysicalMaterial({
      color: palette.suit, roughness: 0.5, sheen: 0.55, sheenColor: new Color(palette.suit).lerp(new Color('#fff0da'), 0.6), sheenRoughness: 0.45,
      clearcoat: 0.2, clearcoatRoughness: 0.55,
    }),
    'suit',
    { strength: 0.35, color: '#ffd9b0', innerShade: 1 },
    (shader, where) => {
      shader.uniforms.uSuitScale = suitScale;
      patchSuit(shader, where);
    },
  );
  const trim = patchHeroMaterial(
    new MeshPhysicalMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.4, metalness: 0.05, clearcoat: 0.55, clearcoatRoughness: 0.3 }),
    'trim',
    { strength: 0.25, color: '#ffd9b0', innerShade: 1 },
    createTrimPatch(glow),
  );
  const skin = patchHeroMaterial(
    new MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.58 }),
    'skin',
    { strength: 0.22, color: '#ffc9a0', innerShade: 1 },
  );
  const cape = patchHeroMaterial(
    new MeshPhysicalMaterial({
      color: palette.cape, roughness: 0.6, sheen: 1, sheenColor: new Color(palette.cape).lerp(new Color('#ffb080'), 0.55), sheenRoughness: 0.35,
      side: DoubleSide,
    }),
    'cape',
    { strength: 0.3, color: '#ff9a70', innerShade: 0.62 },
  );
  return {
    suit,
    trim,
    skin,
    cape,
    setGlow(amount) {
      glow.value = Math.min(1, Math.max(0, amount));
    },
    dispose() {
      suit.dispose();
      trim.dispose();
      skin.dispose();
      cape.dispose();
    },
  };
}
