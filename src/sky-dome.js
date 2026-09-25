import * as THREE from 'three';
import { ATMOSPHERE_GLSL, NOISE_GLSL, atmosphereUniforms } from './atmosphere.js';

const vertexShader = /* glsl */ `
varying vec3 vSkyDir;
void main() {
  vSkyDir = position;
  vec4 clip = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  clip.z = clip.w * 0.99999; // pin to the far plane so the sky sits behind everything
  gl_Position = clip;
}
`;

const fragmentShader = /* glsl */ `
${ATMOSPHERE_GLSL}
${NOISE_GLSL}
uniform float uSunDisc;
varying vec3 vSkyDir;

void main() {
  vec3 rd = normalize(vSkyDir);
  vec3 col = skyRadiance(rd);
  float sunDot = dot(rd, uSunDir);
  col += uSunColor * smoothstep(0.99955, 0.99975, sunDot) * 28.0 * uSunDisc;

  // High, stretched cirrus catching the last light.
  float above = smoothstep(0.0, 0.22, rd.y);
  if (above > 0.0) {
    vec2 plane = rd.xz / (rd.y + 0.1);
    vec2 drift = vec2(uTime * 0.0012, uTime * 0.0005);
    float streaks = fbm(plane * vec2(0.5, 1.7) + drift);
    float wisps = smoothstep(0.56, 0.92, streaks) * above;
    float lit = pow(max(sunDot, 0.0), 2.5);
    vec3 cloudColor = mix(uSkyHorizonAway * 1.08, uSunGlow * 1.7 + uSunColor * 0.5, lit);
    col = mix(col, cloudColor, wisps * 0.5);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

function createSkyMaterial(sunDisc) {
  return new THREE.ShaderMaterial({
    uniforms: { ...atmosphereUniforms, uSunDisc: { value: sunDisc } },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
  });
}

export function createSkyDome() {
  const geometry = new THREE.SphereGeometry(1, 64, 32);
  const mesh = new THREE.Mesh(geometry, createSkyMaterial(1));
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000; // after opaque geometry: only fills pixels nothing else covered
  return mesh;
}

// Prefiltered sky lighting for reflections on glass, water-lit suits and ambient fill.
export function createSkyEnvironment(renderer) {
  const scene = new THREE.Scene();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), createSkyMaterial(0));
  sky.frustumCulled = false;
  scene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0, 0.1, 10);
  pmrem.dispose();
  sky.geometry.dispose();
  sky.material.dispose();
  return target.texture;
}
