import * as THREE from 'three';

// The golden-hour look in one place: sun, sky palette, and the aerial-perspective
// haze every world material shares, so distant towers melt into the same sky.

export const SUN_DIRECTION = new THREE.Vector3(0.844, 0.225, 0.487).normalize();

export const PALETTE = {
  sunLight: new THREE.Color('#ffd0a0'),
  sunDisc: new THREE.Color('#ffe2bf'),
  zenith: new THREE.Color('#3a66ad'),
  horizonSun: new THREE.Color('#ffb773'),
  horizonAway: new THREE.Color('#d3a2b0'),
  sunGlow: new THREE.Color('#ff9143'),
  cloudShadeLow: new THREE.Color('#6d6a92'),
  cloudShadeHigh: new THREE.Color('#b7a4c4'),
};

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

export const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizonSun;
uniform vec3 uSkyHorizonAway;
uniform vec3 uSunGlow;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uTime;

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

export const NOISE_GLSL = /* glsl */ `
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
float fbm(vec2 p) {
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

// Patches a built-in material (Standard/Physical) with the shared haze.
// `key` must be unique per distinct `patch` so three.js compiles separate programs.
export function applyAtmosphere(material, { key = 'base', patch } = {}) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, atmosphereUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vAerialWorld;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 aerialWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          aerialWorld = instanceMatrix * aerialWorld;
        #endif
        vAerialWorld = (modelMatrix * aerialWorld).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vAerialWorld;\n${ATMOSPHERE_GLSL}`)
      .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyAerialPerspective(gl_FragColor.rgb, vAerialWorld);');
    if (patch) patch(shader);
  };
  material.customProgramCacheKey = () => `atmosphere:${key}`;
  return material;
}
