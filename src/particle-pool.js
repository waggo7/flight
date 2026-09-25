import * as THREE from 'three';

// A fixed pool of soft round point sprites with simple ballistic motion: sparks,
// spray, glass glitter. Spawning past capacity recycles the oldest particle.

const pointsVertex = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
uniform float uScale;
uniform float uMaxSize;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.1), 0.0, uMaxSize);
  vAlpha = aAlpha * smoothstep(1.5, 5.0, -mv.z); // no giant blobs right at the lens
}
`;

const pointsFragment = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.0, 1.0, d);
  a *= a * vAlpha;
  if (a < 0.003) discard;
  #ifdef ADDITIVE
    gl_FragColor = vec4(uColor * a, 1.0);
  #else
    gl_FragColor = vec4(uColor, a);
  #endif
}
`;

export class ParticlePool {
  constructor({ capacity, color, additive, gravity = 0, drag = 0, maxSize = 160 }) {
    this.capacity = capacity;
    this.gravity = gravity;
    this.drag = drag;
    this.cursor = 0;
    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity).fill(1);
    this.baseSize = new Float32Array(capacity);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uScale: { value: 500 }, uMaxSize: { value: maxSize } },
      vertexShader: pointsVertex,
      fragmentShader: pointsFragment,
      defines: additive ? { ADDITIVE: '' } : {},
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
  }

  spawn(x, y, z, vx, vy, vz, life, size) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.positions.set([x, y, z], i * 3);
    this.velocities.set([vx, vy, vz], i * 3);
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseSize[i] = size;
  }

  clear() {
    this.life.fill(0);
  }

  update(dt, scale) {
    this.material.uniforms.uScale.value = scale;
    const drag = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        this.alphas[i] = 0;
        this.sizes[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = i * 3;
      this.velocities[k] *= drag;
      this.velocities[k + 1] = this.velocities[k + 1] * drag - this.gravity * dt;
      this.velocities[k + 2] *= drag;
      this.positions[k] += this.velocities[k] * dt;
      this.positions[k + 1] += this.velocities[k + 1] * dt;
      this.positions[k + 2] += this.velocities[k + 2] * dt;
      const t = 1 - Math.max(this.life[i], 0) / this.maxLife[i];
      this.alphas[i] = Math.min(1, t * 8) * (1 - t) * (1 - t);
      this.sizes[i] = this.baseSize[i] * (0.6 + t * 0.9);
    }
    const geometry = this.points.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aSize.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
  }
}
