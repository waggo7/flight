import { Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, PlaneGeometry, ShaderMaterial } from 'three';
import type { Vector3Like } from 'three';
import { smoothstep } from '../../../core/scalar-math';
import type { RandomSource } from '../../../core/seeded-noise';
import { ATMOSPHERE_GLSL, VALUE_NOISE_GLSL, atmosphereUniforms } from '../world/atmosphere';

// Billowing dust: camera-facing puffs shaded like little spheres (sunlit side warm,
// shadow side violet-grey), so a crowd of them reads as a rolling cloud of grit.
// Ported from v1 (src/dust-plumes.js).

const vertexShader = /* glsl */ `
attribute vec4 aDust; // alpha, rotation, seed, darkness
varying vec2 vUv;
varying vec4 vDust;
varying vec3 vCenter;
varying vec3 vRight;
varying vec3 vUp;
void main() {
  vec3 center = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float scale = length(instanceMatrix[0].xyz);
  // Puffs that engulf the camera would fill the screen with overdraw; fade them out
  // (the post veil takes over) and skip them entirely once invisible.
  float nearFade = smoothstep(0.45, 1.3, distance(cameraPosition, center) / scale);
  if (nearFade * aDust.x < 0.004) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  float c = cos(aDust.y);
  float s = sin(aDust.y);
  vec2 corner = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 world = center + (right * corner.x + up * corner.y) * scale;
  vUv = uv;
  vDust = vec4(aDust.x * nearFade, aDust.yzw);
  vCenter = center;
  vRight = right;
  vUp = up;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const fragmentShader = /* glsl */ `
${ATMOSPHERE_GLSL}
${VALUE_NOISE_GLSL}
uniform vec3 uDustLit;
uniform vec3 uDustShade;
varying vec2 vUv;
varying vec4 vDust;
varying vec3 vCenter;
varying vec3 vRight;
varying vec3 vUp;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float billow = valueNoise(vUv * 3.0 + vDust.z * 19.0) * 0.65 + valueNoise(vUv * 6.5 + vDust.z * 7.0) * 0.35;
  float body = 1.0 - smoothstep(0.25, 1.0, sqrt(r2) + (billow - 0.5) * 0.7);
  float alpha = body * vDust.x;
  if (alpha < 0.004) discard;
  vec3 toCamera = normalize(cameraPosition - vCenter);
  vec3 normal = normalize(vRight * p.x + vUp * p.y + toCamera * sqrt(max(1.0 - r2, 0.0)));
  float light = clamp(dot(normal, uSunDir) * 0.55 + 0.5, 0.0, 1.0);
  vec3 col = mix(uDustShade, uDustLit, light * (0.75 + 0.25 * billow));
  col *= 1.0 - vDust.w * 0.55;
  col = applyAerialPerspective(col, vCenter);
  gl_FragColor = vec4(col, alpha);
}
`;

export interface DustPuffOptions {
  /** Starting diameter, m. */
  size?: number;
  /** Final diameter as a multiple of `size`. */
  growth?: number;
  /** Seconds; each puff gets 80–120% of this. */
  life?: number;
  /** Upward speed the puff eases toward, m/s. */
  rise?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  /** Peak opacity. */
  alpha?: number;
  /** 0..1: darkens the puff by up to 55%. */
  darkness?: number;
}

export class DustPlumes {
  readonly capacity: number;
  /** The slot the next `puff` writes (the oldest once the pool has wrapped). */
  cursor = 0;
  readonly position: Float32Array;
  readonly velocity: Float32Array;
  readonly size: Float32Array;
  readonly growth: Float32Array;
  readonly rise: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly alpha: Float32Array;
  readonly spin: Float32Array;
  /** Rotation, seed, darkness per puff. */
  readonly look: Float32Array;
  /** Per drawn instance: alpha, rotation, seed, darkness. */
  readonly packed: Float32Array;
  readonly dustAttribute: InstancedBufferAttribute;
  /** Add this to the scene. Only the first `active` instances are drawn. */
  readonly mesh: InstancedMesh<PlaneGeometry, ShaderMaterial>;
  /** Live puffs after the last `update`. */
  active = 0;

  private readonly matrix = new Matrix4();

  /**
   * `random` varies each puff's life, spin, rotation and noise seed. v1 used Math.random (the
   * default); pass a seeded source for reproducible frames.
   */
  constructor(
    capacity = 340,
    private readonly random: RandomSource = Math.random,
  ) {
    this.capacity = capacity;
    this.position = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.growth = new Float32Array(capacity);
    this.rise = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.look = new Float32Array(capacity * 3);
    this.packed = new Float32Array(capacity * 4);

    const geometry = new PlaneGeometry(1, 1);
    this.dustAttribute = new InstancedBufferAttribute(this.packed, 4).setUsage(DynamicDrawUsage);
    geometry.setAttribute('aDust', this.dustAttribute);
    const material = new ShaderMaterial({
      uniforms: {
        ...atmosphereUniforms,
        uDustLit: { value: new Color('#dcc7ab') },
        uDustShade: { value: new Color('#6c6270') },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  puff(x: number, y: number, z: number, { size = 10, growth = 2.2, life = 7, rise = 1.2, vx = 0, vy = 0, vz = 0, alpha = 0.55, darkness = 0 }: DustPuffOptions = {}): void {
    const random = this.random;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.position.set([x, y, z], i * 3);
    this.velocity.set([vx, vy, vz], i * 3);
    this.size[i] = size;
    this.growth[i] = growth;
    this.rise[i] = rise;
    this.age[i] = 0;
    this.life[i] = life * (0.8 + random() * 0.4);
    this.alpha[i] = alpha;
    this.spin[i] = (random() - 0.5) * 0.3;
    this.look[i * 3] = random() * Math.PI * 2;
    this.look[i * 3 + 1] = random();
    this.look[i * 3 + 2] = darkness;
  }

  clear(): void {
    this.life.fill(0);
    this.age.fill(0);
  }

  /** Rough density of dust around a point, for the in-cloud veil. */
  densityAt(point: Vector3Like): number {
    let density = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.age[i] >= this.life[i]) continue;
      const k = i * 3;
      const radius = this.currentSize(i) * 0.5;
      const dx = point.x - this.position[k];
      const dy = point.y - this.position[k + 1];
      const dz = point.z - this.position[k + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < radius) density += (1 - d / radius) * this.currentAlpha(i);
    }
    return Math.min(1, density);
  }

  private currentSize(i: number): number {
    const t = Math.min(1, this.age[i] / this.life[i]);
    return this.size[i] * (1 + (this.growth[i] - 1) * (1 - (1 - t) * (1 - t)));
  }

  private currentAlpha(i: number): number {
    const t = Math.min(1, this.age[i] / this.life[i]);
    return this.alpha[i] * smoothstep(0, 0.1, t) * (1 - smoothstep(0.45, 1, t));
  }

  /** Ages, drifts (toward `wind`, m/s) and packs the live puffs. Call once per frame with sim dt. */
  update(dt: number, wind: Vector3Like): void {
    let slot = 0;
    const drag = Math.exp(-0.9 * dt);
    for (let i = 0; i < this.capacity; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      const k = i * 3;
      this.velocity[k] = this.velocity[k] * drag + wind.x * (1 - drag);
      this.velocity[k + 1] = this.velocity[k + 1] * drag + this.rise[i] * (1 - drag);
      this.velocity[k + 2] = this.velocity[k + 2] * drag + wind.z * (1 - drag);
      this.position[k] += this.velocity[k] * dt;
      this.position[k + 1] += this.velocity[k + 1] * dt;
      this.position[k + 2] += this.velocity[k + 2] * dt;
      this.look[i * 3] += this.spin[i] * dt;

      // Pack live puffs to the front so the draw call only covers what exists.
      const size = this.currentSize(i);
      this.matrix.makeScale(size, size, size).setPosition(this.position[k], this.position[k + 1], this.position[k + 2]);
      this.mesh.setMatrixAt(slot, this.matrix);
      this.packed[slot * 4] = this.currentAlpha(i);
      this.packed[slot * 4 + 1] = this.look[i * 3];
      this.packed[slot * 4 + 2] = this.look[i * 3 + 1];
      this.packed[slot * 4 + 3] = this.look[i * 3 + 2];
      slot++;
    }
    this.active = slot;
    this.mesh.count = slot;
    if (slot > 0) {
      this.dustAttribute.needsUpdate = true;
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
