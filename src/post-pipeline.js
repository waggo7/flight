import * as THREE from 'three';

// HDR scene → mip-chain bloom → one composite pass (edge speed blur, dust and cloud veils,
// vignette, ACES tone mapping, sRGB, contrast, film grain). Small, fast, tuned for sunsets.

const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const prefilterFragment = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tInput, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
  c += texture2D(tInput, vUv + uTexel * vec2(0.5, -0.5)).rgb;
  c += texture2D(tInput, vUv + uTexel * vec2(-0.5, 0.5)).rgb;
  c += texture2D(tInput, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  float brightness = max(c.r, max(c.g, c.b));
  float soft = clamp(brightness - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contribution = max(soft, brightness - uThreshold) / max(brightness, 1e-4);
  gl_FragColor = vec4(min(c * contribution, vec3(60.0)), 1.0);
}
`;

const downsampleFragment = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uTexel;
varying vec2 vUv;
vec3 tap(vec2 o) { return texture2D(tInput, vUv + uTexel * o).rgb; }
void main() {
  vec3 a = tap(vec2(-2.0, 2.0)), b = tap(vec2(0.0, 2.0)), c = tap(vec2(2.0, 2.0));
  vec3 d = tap(vec2(-2.0, 0.0)), e = tap(vec2(0.0, 0.0)), f = tap(vec2(2.0, 0.0));
  vec3 g = tap(vec2(-2.0, -2.0)), h = tap(vec2(0.0, -2.0)), i = tap(vec2(2.0, -2.0));
  vec3 j = tap(vec2(-1.0, 1.0)), k = tap(vec2(1.0, 1.0)), l = tap(vec2(-1.0, -1.0)), m = tap(vec2(1.0, -1.0));
  vec3 color = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  gl_FragColor = vec4(color, 1.0);
}
`;

const upsampleFragment = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec4 d = uTexel.xyxy * vec4(1.0, 1.0, -1.0, 0.0) * uRadius;
  vec3 s = texture2D(tInput, vUv - d.xy).rgb;
  s += texture2D(tInput, vUv - d.wy).rgb * 2.0;
  s += texture2D(tInput, vUv - d.zy).rgb;
  s += texture2D(tInput, vUv + d.zw).rgb * 2.0;
  s += texture2D(tInput, vUv).rgb * 4.0;
  s += texture2D(tInput, vUv + d.xw).rgb * 2.0;
  s += texture2D(tInput, vUv + d.zy).rgb;
  s += texture2D(tInput, vUv + d.wy).rgb * 2.0;
  s += texture2D(tInput, vUv + d.xy).rgb;
  gl_FragColor = vec4(s / 16.0, 1.0);
}
`;

const compositeFragment = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uResolution;
uniform float uBloomStrength;
uniform float uExposure;
uniform float uSpeedBlur;
uniform float uVignette;
uniform float uCloud;
uniform vec3 uCloudColor;
uniform float uDust;
uniform vec3 uDustColor;
uniform float uGrain;
uniform float uContrast;
uniform float uFlash;
uniform float uTime;
varying vec2 vUv;

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFilmic(vec3 color) {
  const mat3 ACESInputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 ACESOutputMat = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602)
  );
  color *= 1.0 / 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}

vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = vUv;
  vec2 fromCenter = uv - 0.5;
  float edge = dot(fromCenter, fromCenter);

  vec3 color;
  float blur = uSpeedBlur * smoothstep(0.02, 0.25, edge);
  if (blur > 0.001) {
    color = vec3(0.0);
    float total = 0.0;
    for (int i = 0; i < 8; i++) {
      float t = float(i) / 7.0;
      float w = 1.0 - t * 0.55;
      color += texture2D(tScene, uv - fromCenter * blur * t * 0.07).rgb * w;
      total += w;
    }
    color /= total;
  } else {
    color = texture2D(tScene, uv).rgb;
  }

  color += texture2D(tBloom, uv).rgb * uBloomStrength;
  color = mix(color, uDustColor, uDust);
  color = mix(color, uCloudColor, uCloud);
  color += vec3(uFlash);
  color *= uExposure;

  float aspect = uResolution.x / uResolution.y;
  float vignette = smoothstep(1.15, 0.35, length(fromCenter * vec2(aspect, 1.0)) * 1.1);
  color *= mix(1.0 - uVignette, 1.0, vignette);

  color = toSRGB(acesFilmic(color));
  // A little grit: a gentle S-curve for bite, and film grain that lives in the mid-tones.
  color = mix(color, color * color * (3.0 - 2.0 * color), uContrast);
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  float grain = hash(gl_FragCoord.xy + fract(uTime * 7.1) * 91.0) - 0.5;
  color += grain * (uGrain * (0.35 + 0.65 * (1.0 - abs(luma * 2.0 - 1.0))) + 1.0 / 255.0);
  gl_FragColor = vec4(color, 1.0);
}
`;

export class PostPipeline {
  constructor(renderer, { bloomLevels = 5, samples = 4 } = {}) {
    this.renderer = renderer;
    this.samples = samples;
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples,
      depthBuffer: true,
    });
    this.levels = [];
    for (let i = 0; i < bloomLevels; i++) {
      this.levels.push(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(geometry);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const pass = (fragmentShader, uniforms, extra = {}) =>
      new THREE.ShaderMaterial({ vertexShader: fullscreenVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false, ...extra });

    this.prefilter = pass(prefilterFragment, {
      tInput: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 1.6 },
      uKnee: { value: 0.8 },
    });
    this.downsample = pass(downsampleFragment, { tInput: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.upsample = pass(
      upsampleFragment,
      { tInput: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } },
      { blending: THREE.AdditiveBlending, transparent: true },
    );
    this.composite = pass(compositeFragment, {
      tScene: { value: this.sceneTarget.texture },
      tBloom: { value: this.levels[0].texture },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uBloomStrength: { value: 0.75 },
      uExposure: { value: 1 },
      uSpeedBlur: { value: 0 },
      uVignette: { value: 0.36 },
      uCloud: { value: 0 },
      uCloudColor: { value: new THREE.Color('#f3e2da') },
      uDust: { value: 0 },
      uDustColor: { value: new THREE.Color('#9d8c7a') },
      uGrain: { value: 0.045 },
      uContrast: { value: 0.16 },
      uFlash: { value: 0 },
      uTime: { value: 0 },
    });
    this.settings = this.composite.uniforms;
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
    this.sceneTarget.setSize(width, height);
    let w = width;
    let h = height;
    for (const level of this.levels) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      level.setSize(w, h);
    }
    this.composite.uniforms.uResolution.value.set(width, height);
  }

  #draw(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  render(scene, camera) {
    const renderer = this.renderer;
    renderer.setRenderTarget(this.sceneTarget);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    this.prefilter.uniforms.tInput.value = this.sceneTarget.texture;
    this.prefilter.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.#draw(this.prefilter, this.levels[0]);

    for (let i = 1; i < this.levels.length; i++) {
      const source = this.levels[i - 1];
      this.downsample.uniforms.tInput.value = source.texture;
      this.downsample.uniforms.uTexel.value.set(1 / source.width, 1 / source.height);
      this.#draw(this.downsample, this.levels[i]);
    }
    for (let i = this.levels.length - 1; i > 0; i--) {
      const source = this.levels[i];
      this.upsample.uniforms.tInput.value = source.texture;
      this.upsample.uniforms.uTexel.value.set(1 / source.width, 1 / source.height);
      this.#draw(this.upsample, this.levels[i - 1]);
    }

    this.#draw(this.composite, null);
  }
}
