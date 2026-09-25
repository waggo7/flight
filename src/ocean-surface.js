import * as THREE from 'three';
import { ATMOSPHERE_GLSL, NOISE_GLSL, atmosphereUniforms } from './atmosphere.js';

// Endless sea: analytic sky reflections, a glittering sun path, turquoise shallows
// and soft shore foam. The plane follows the camera, so it always reaches the horizon.

const vertexShader = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
${ATMOSPHERE_GLSL}
${NOISE_GLSL}
uniform sampler2D uDepthMap;
uniform vec4 uDepthBounds;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
varying vec3 vWorld;

vec2 waveSlope(vec2 p, vec2 dir, float wavelength, float steepness, float t, float footprint) {
  float k = 6.2831853 / wavelength;
  float speed = sqrt(9.81 / k);
  float fade = 1.0 - smoothstep(0.35, 1.0, footprint * 2.2 / wavelength);
  float phase = dot(dir, p) * k - t * speed * k;
  return dir * (steepness * cos(phase) * fade);
}

void main() {
  vec3 toFrag = vWorld - cameraPosition;
  float dist = length(toFrag);
  vec3 rd = toFrag / dist;
  vec2 p = vWorld.xz;
  float footprint = max(length(fwidth(p)), 0.001);
  float t = uTime;

  vec2 slope = vec2(0.0);
  slope += waveSlope(p, vec2(0.96, 0.28), 61.0, 0.045, t, footprint);
  slope += waveSlope(p, vec2(-0.57, 0.82), 31.0, 0.05, t, footprint);
  slope += waveSlope(p, vec2(0.21, -0.98), 17.0, 0.055, t, footprint);
  slope += waveSlope(p, vec2(0.74, -0.67), 9.3, 0.06, t, footprint);
  slope += waveSlope(p, vec2(-0.93, -0.37), 5.1, 0.06, t, footprint);
  slope += waveSlope(p, vec2(0.38, 0.92), 2.9, 0.05, t, footprint);
  slope += waveSlope(p, vec2(-0.2, 0.98), 1.6, 0.045, t, footprint);
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

  // Distant water: normals average out, highlights broaden into a sun path.
  float far = smoothstep(150.0, 6000.0, dist);
  vec3 refl = reflect(rd, n);
  refl.y = abs(refl.y);
  float cosTheta = clamp(dot(-rd, n), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);
  vec3 sky = skyRadiance(refl);

  float sunAlign = max(dot(refl, uSunDir), 0.0);
  float shininess = mix(1400.0, 90.0, far);
  float sparkle = pow(sunAlign, shininess) * shininess * 0.018;
  float sheen = pow(sunAlign, 18.0) * 0.12;
  vec3 sunLight = uSunColor * (sparkle + sheen);

  vec2 depthUv = (p - uDepthBounds.xy) * uDepthBounds.zw;
  float inside = step(0.0, depthUv.x) * step(depthUv.x, 1.0) * step(0.0, depthUv.y) * step(depthUv.y, 1.0);
  float depth = mix(60.0, texture2D(uDepthMap, depthUv).r * 60.0, inside);
  float shallow = 1.0 - smoothstep(0.0, 24.0, depth);
  vec3 body = mix(uDeepColor, uShallowColor, shallow * shallow);
  body *= 0.55 + 0.45 * max(dot(n, uSunDir), 0.0);

  vec3 col = mix(body, sky, fresnel) + sunLight;

  float foamBand = 1.0 - smoothstep(0.6, 3.2, depth);
  float foamPulse = 0.55 + 0.45 * sin(t * 1.1 - depth * 2.4 + valueNoise(p * 0.08) * 6.0);
  float foam = foamBand * foamPulse * smoothstep(0.35, 0.75, valueNoise(p * 0.35 + t * 0.2));
  col = mix(col, vec3(0.92, 0.88, 0.84) * (0.5 + 0.6 * uSunColor), foam * 0.65);

  col = applyAerialPerspective(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createOcean({ texture, bounds }) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...atmosphereUniforms,
      uDepthMap: { value: texture },
      uDepthBounds: { value: bounds },
      uDeepColor: { value: new THREE.Color('#0a2638') },
      uShallowColor: { value: new THREE.Color('#2f9a94') },
    },
    vertexShader,
    fragmentShader,
  });
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.set(56000, 1, 56000);
  mesh.frustumCulled = false;
  mesh.receiveShadow = false;

  return {
    mesh,
    follow(camera) {
      mesh.position.set(Math.round(camera.position.x / 200) * 200, 0, Math.round(camera.position.z / 200) * 200);
    },
  };
}
