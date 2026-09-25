import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, NormalBlending, Points, ShaderMaterial } from 'three';
import type { ColorRepresentation, IUniform } from 'three';

// A fixed pool of soft round point sprites with simple ballistic motion: sparks,
// spray, glass glitter. Spawning past capacity recycles the oldest particle.
// Ported from v1 (src/particle-pool.js).

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

export interface ParticlePoolOptions {
  capacity: number;
  color: ColorRepresentation;
  /** Additive glow (sparks, glitter) instead of normal alpha blending (spray, grit). */
  additive?: boolean;
  /** Downward acceleration, m/s². */
  gravity?: number;
  /** Exponential velocity damping per second. */
  drag?: number;
  /** Largest point size on screen, in pixels. */
  maxSize?: number;
}

export class ParticlePool {
  readonly capacity: number;
  gravity: number;
  drag: number;
  /** The slot the next `spawn` writes (the oldest particle once the pool has wrapped). */
  cursor = 0;
  readonly positions: Float32Array;
  readonly velocities: Float32Array;
  /** Seconds left; a particle is dead at 0 or below. */
  readonly life: Float32Array;
  readonly maxLife: Float32Array;
  readonly baseSize: Float32Array;
  readonly sizes: Float32Array;
  readonly alphas: Float32Array;
  readonly material: ShaderMaterial;
  /** Add this to the scene. */
  readonly points: Points<BufferGeometry, ShaderMaterial>;

  private readonly uniforms: { uColor: IUniform<Color>; uScale: IUniform<number>; uMaxSize: IUniform<number> };
  private readonly positionAttribute: BufferAttribute;
  private readonly sizeAttribute: BufferAttribute;
  private readonly alphaAttribute: BufferAttribute;

  constructor({ capacity, color, additive = false, gravity = 0, drag = 0, maxSize = 160 }: ParticlePoolOptions) {
    this.capacity = capacity;
    this.gravity = gravity;
    this.drag = drag;
    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity).fill(1);
    this.baseSize = new Float32Array(capacity);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    const geometry = new BufferGeometry();
    this.positionAttribute = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
    this.sizeAttribute = new BufferAttribute(this.sizes, 1).setUsage(DynamicDrawUsage);
    this.alphaAttribute = new BufferAttribute(this.alphas, 1).setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttribute);
    geometry.setAttribute('aSize', this.sizeAttribute);
    geometry.setAttribute('aAlpha', this.alphaAttribute);
    this.uniforms = { uColor: { value: new Color(color) }, uScale: { value: 500 }, uMaxSize: { value: maxSize } };
    this.material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: pointsVertex,
      fragmentShader: pointsFragment,
      defines: additive ? { ADDITIVE: '' } : {},
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
    });
    this.points = new Points(geometry, this.material);
    this.points.frustumCulled = false;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.positions.set([x, y, z], i * 3);
    this.velocities.set([vx, vy, vz], i * 3);
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseSize[i] = size;
  }

  clear(): void {
    this.life.fill(0);
  }

  /**
   * Steps every live particle. `scale` converts world size to pixels at 1 m: drawing-buffer height
   * / (2 · tan(fov / 2)).
   */
  update(dt: number, scale: number): void {
    this.uniforms.uScale.value = scale;
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
    this.positionAttribute.needsUpdate = true;
    this.sizeAttribute.needsUpdate = true;
    this.alphaAttribute.needsUpdate = true;
  }
}
