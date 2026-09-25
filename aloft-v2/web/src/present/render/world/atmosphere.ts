import { Color, Vector3 } from 'three';
import type { Material, WebGLProgramParametersWithUniforms } from 'three';

// The golden-hour look in one place: sun, sky palette, and the aerial-perspective haze every
// world material shares, so distant towers melt into the same sky. Ported from v1
// (src/atmosphere.js), plus a checked patch helper: every edit to a three.js shader chunk goes
// through `afterInclude` / `replaceInclude`, which throw if the chunk is missing, so a three.js
// upgrade fails loudly instead of silently dropping the look.

export const SUN_DIRECTION = new Vector3(0.844, 0.225, 0.487).normalize();

export const PALETTE = {
  sunLight: new Color('#ffd0a0'),
  sunDisc: new Color('#ffe2bf'),
  zenith: new Color('#3a66ad'),
  horizonSun: new Color('#ffb773'),
  horizonAway: new Color('#d3a2b0'),
  sunGlow: new Color('#ff9143'),
  cloudShadeLow: new Color('#6d6a92'),
  cloudShadeHigh: new Color('#b7a4c4'),
} as const;

export const atmosphereUniforms = {
  uSunDir: { value: SUN_DIRECTION },
  uSunColor: { value: PALETTE.sunLight },
  uSkyZenith: { value: PALETTE.zenith },
  uSkyHorizonSun: { value: PALETTE.horizonSun },
  uSkyHorizonAway: { value: PALETTE.horizonAway },
  uSunGlow: { value: PALETTE.sunGlow },
  uFogDensity: { value: 1 / 2500 },
  uFogFalloff: { value: 1 / 420 },
  uTime: { value: 0 },
};

// ATMOSPHERE_GLSL is assembled from parts so a shader can leave one out without string surgery.
const ATMOSPHERE_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizonSun;
uniform vec3 uSkyHorizonAway;
uniform vec3 uSunGlow;
uniform float uFogDensity;
uniform float uFogFalloff;
`;

const TIME_UNIFORM_GLSL = /* glsl */ `uniform float uTime;
`;

const ATMOSPHERE_FUNCTIONS_GLSL = /* glsl */ `
vec3 skyRadiance(vec3 rd) {
  float sunDot = dot(rd, uSunDir);
  float toward = clamp(sunDot * 0.5 + 0.5, 0.0, 1.0);
  vec3 horizon = mix(uSkyHorizonAway, uSkyHorizonSun, toward * toward);
  float h = clamp(rd.y, 0.0, 1.0);
  vec3 col = mix(uSkyZenith, horizon, pow(1.0 - h, 4.0));
  float glow = max(sunDot, 0.0);
  col += uSunGlow * (pow(glow, 5.0) * 0.32 + pow(glow, 32.0) * 0.7) * mix(1.0, 0.55, h);
  return col;
}

vec3 hazeColor(vec3 rd) {
  return skyRadiance(normalize(vec3(rd.x, max(rd.y, 0.0) * 0.35 + 0.015, rd.z)));
}

// Exponential height fog integrated along the view ray: dense near the sea,
// clear at altitude, tinted by the sky in the direction you look.
vec3 applyAerialPerspective(vec3 color, vec3 worldPos) {
  vec3 ro = cameraPosition;
  vec3 delta = worldPos - ro;
  float dist = length(delta);
  vec3 rd = delta / max(dist, 1e-3);
  float k = rd.y * uFogFalloff;
  float integral = abs(k) > 1e-6 ? (1.0 - exp(clamp(-dist * k, -80.0, 80.0))) / k : dist;
  float optical = uFogDensity * exp(-max(ro.y, 0.0) * uFogFalloff) * integral;
  float fog = 1.0 - exp(-max(optical, 0.0));
  return mix(color, hazeColor(rd), fog);
}
`;

export const ATMOSPHERE_GLSL = ATMOSPHERE_UNIFORMS_GLSL + TIME_UNIFORM_GLSL + ATMOSPHERE_FUNCTIONS_GLSL;

/**
 * ATMOSPHERE_GLSL without `uniform float uTime;`. v1's clouds declare uTime in their vertex stage
 * and kept it out of the fragment stage; this reproduces that fragment shader.
 */
export const ATMOSPHERE_GLSL_WITHOUT_TIME = ATMOSPHERE_UNIFORMS_GLSL + ATMOSPHERE_FUNCTIONS_GLSL;

/** hash12 and valueNoise: NOISE_GLSL without fbm (v1's dust shader uses only these). */
export const VALUE_NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const FBM_GLSL = /* glsl */ `float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amp * valueNoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    amp *= 0.5;
  }
  return sum;
}
`;

export const NOISE_GLSL = VALUE_NOISE_GLSL + FBM_GLSL;

/**
 * Every three.js shader chunk this project patches. tests/unit/shader-anchors.test.ts checks
 * each one still exists in three's built-in standard/physical shaders. Add to it when a patch
 * uses a new chunk.
 */
export const PATCHED_CHUNKS = [
  'common',
  'begin_vertex',
  'project_vertex',
  'color_fragment',
  'roughnessmap_fragment',
  'metalnessmap_fragment',
  'emissivemap_fragment',
  'fog_fragment',
] as const;
export type PatchedChunk = (typeof PATCHED_CHUNKS)[number];

export class ShaderPatchError extends Error {}

function includeOf(chunk: PatchedChunk): string {
  return `#include <${chunk}>`;
}

/** Insert GLSL right after `#include <chunk>`. Throws if the chunk is not in `source`. */
export function afterInclude(source: string, chunk: PatchedChunk, code: string, where: string): string {
  const include = includeOf(chunk);
  if (!source.includes(include)) throw new ShaderPatchError(`${where}: three.js shader has no ${include} (three.js upgrade?)`);
  return source.replace(include, `${include}\n${code}`);
}

/** Replace `#include <chunk>` entirely. Throws if the chunk is not in `source`. */
export function replaceInclude(source: string, chunk: PatchedChunk, code: string, where: string): string {
  const include = includeOf(chunk);
  if (!source.includes(include)) throw new ShaderPatchError(`${where}: three.js shader has no ${include} (three.js upgrade?)`);
  return source.replace(include, code);
}

export type ShaderPatch = (shader: WebGLProgramParametersWithUniforms) => void;

/**
 * Patches a built-in material (Standard/Physical) with the shared haze. `key` must be unique per
 * distinct `patch` so three.js compiles separate programs.
 */
export function applyAtmosphere<M extends Material>(material: M, { key = 'base', patch }: { key?: string; patch?: ShaderPatch } = {}): M {
  const where = `material "${key}"`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, atmosphereUniforms);
    let vertex = afterInclude(shader.vertexShader, 'common', 'varying vec3 vAerialWorld;', where);
    vertex = afterInclude(
      vertex,
      'project_vertex',
      `vec4 aerialWorld = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        aerialWorld = instanceMatrix * aerialWorld;
      #endif
      vAerialWorld = (modelMatrix * aerialWorld).xyz;`,
      where,
    );
    let fragment = afterInclude(shader.fragmentShader, 'common', `varying vec3 vAerialWorld;\n${ATMOSPHERE_GLSL}`, where);
    fragment = replaceInclude(fragment, 'fog_fragment', 'gl_FragColor.rgb = applyAerialPerspective(gl_FragColor.rgb, vAerialWorld);', where);
    shader.vertexShader = vertex;
    shader.fragmentShader = fragment;
    patch?.(shader);
  };
  material.customProgramCacheKey = () => `atmosphere:${key}`;
  return material;
}
