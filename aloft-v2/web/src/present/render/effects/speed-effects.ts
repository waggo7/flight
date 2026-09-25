import {
  AdditiveBlending, BufferAttribute, BufferGeometry, ConeGeometry, DoubleSide, DynamicDrawUsage, LineSegments, Mesh, RingGeometry,
  ShaderMaterial, Vector3,
} from 'three';
import type { Camera, IUniform, Object3D, Vector3Like } from 'three';
import { clamp, smoothstep } from '../../../core/scalar-math';
import { createRandom, type RandomSource } from '../../../core/seeded-noise';
import type { DustPlumes } from './dust-plumes';
import { ParticlePool } from './particle-pool';

// Everything that sells speed and impact: air streaks, the shockwave ring and
// vapour cone, sea spray, street dust, and spark bursts. Ported from v1 (src/speed-effects.js).

/** What the effects read from the flight state each frame. `FlightModel` satisfies it. */
export interface SpeedEffectsFlight {
  readonly position: Vector3;
  readonly velocity: Vector3;
  /** Unit heading. */
  readonly forward: Vector3;
  readonly speed: number;
  /** 0..1: how hard the hero is rushing along a surface. */
  readonly surfaceRush: number;
  readonly overWater: boolean;
  /** Height above the ground or sea, m. */
  readonly groundClearance: number;
}

export interface SpeedEffectsFrame {
  readonly camera: Camera;
  readonly flight: SpeedEffectsFlight;
  /** Drawing-buffer height / (2 · tan(fov / 2)): world size → pixels at 1 m, for the particle pools. */
  readonly projectionScale: number;
}

class WindStreaks {
  readonly anchors: Vector3[];
  readonly positions: Float32Array;
  readonly alphas: Float32Array;
  readonly mesh: LineSegments<BufferGeometry, ShaderMaterial>;
  private readonly positionAttribute: BufferAttribute;
  private readonly alphaAttribute: BufferAttribute;
  private readonly dir = new Vector3();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly rel = new Vector3();

  constructor(
    private readonly random: RandomSource,
    readonly count = 120,
  ) {
    this.anchors = Array.from({ length: count }, () => new Vector3(1e6, 1e6, 1e6));
    this.positions = new Float32Array(count * 6);
    this.alphas = new Float32Array(count * 2);
    const geometry = new BufferGeometry();
    this.positionAttribute = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
    this.alphaAttribute = new BufferAttribute(this.alphas, 1).setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttribute);
    geometry.setAttribute('aAlpha', this.alphaAttribute);
    const material = new ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying float vAlpha;
        void main() { vAlpha = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() { gl_FragColor = vec4(vec3(1.0, 0.95, 0.88) * vAlpha, 1.0); }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.mesh = new LineSegments(geometry, material);
    this.mesh.frustumCulled = false;
  }

  update(camera: Camera, velocity: Vector3, intensity: number): void {
    const speed = velocity.length();
    this.mesh.visible = intensity > 0.01 && speed > 1;
    if (!this.mesh.visible) return;
    const random = this.random;
    const dir = this.dir.copy(velocity).divideScalar(speed);
    const a = this.a.set(dir.z, 0, -dir.x);
    if (a.lengthSq() < 1e-4) a.set(1, 0, 0);
    a.normalize();
    const b = this.b.crossVectors(dir, a);
    const length = clamp(speed * 0.055, 0.6, 7.5);
    for (let i = 0; i < this.count; i++) {
      const p = this.anchors[i];
      const rel = this.rel.subVectors(p, camera.position);
      const along = rel.dot(dir);
      if (along < -3 || rel.lengthSq() > 170 * 170) {
        const ahead = 25 + random() * 120;
        const radius = 8 + Math.pow(random(), 0.7) * 30;
        const angle = random() * Math.PI * 2;
        p.copy(camera.position)
          .addScaledVector(dir, ahead)
          .addScaledVector(a, Math.cos(angle) * radius)
          .addScaledVector(b, Math.sin(angle) * radius);
      }
      const distance = p.distanceTo(camera.position);
      const alpha = intensity * smoothstep(6, 18, distance) * (1 - smoothstep(70, 150, distance)) * 0.36;
      const k = i * 6;
      this.positions[k] = p.x;
      this.positions[k + 1] = p.y;
      this.positions[k + 2] = p.z;
      this.positions[k + 3] = p.x + dir.x * length;
      this.positions[k + 4] = p.y + dir.y * length;
      this.positions[k + 5] = p.z + dir.z * length;
      this.alphas[i * 2] = alpha;
      this.alphas[i * 2 + 1] = 0;
    }
    this.positionAttribute.needsUpdate = true;
    this.alphaAttribute.needsUpdate = true;
  }
}

class Shockwave {
  readonly ring: Mesh<RingGeometry, ShaderMaterial>;
  readonly cone: Mesh<ConeGeometry, ShaderMaterial>;
  ringAge = Infinity;
  coneAge = Infinity;
  private readonly ringUniforms: { uAlpha: IUniform<number> } = { uAlpha: { value: 0 } };
  private readonly coneUniforms: { uAlpha: IUniform<number>; uTime: IUniform<number> } = { uAlpha: { value: 0 }, uTime: { value: 0 } };
  private readonly yAxis = new Vector3(0, 1, 0);
  private readonly zAxis = new Vector3(0, 0, 1);

  constructor() {
    const ringMaterial = new ShaderMaterial({
      uniforms: this.ringUniforms,
      vertexShader: /* glsl */ `
        varying vec2 vLocal;
        void main() { vLocal = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uAlpha;
        varying vec2 vLocal;
        void main() {
          float r = length(vLocal);
          float band = smoothstep(0.78, 0.94, r) * (1.0 - smoothstep(0.95, 1.0, r));
          gl_FragColor = vec4(vec3(1.0, 0.94, 0.86) * band * uAlpha, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    this.ring = new Mesh(new RingGeometry(0.75, 1, 96, 1), ringMaterial);
    this.ring.visible = false;
    this.ring.frustumCulled = false;

    const coneGeometry = new ConeGeometry(1, 1, 48, 8, true);
    coneGeometry.translate(0, -0.5, 0); // apex at the origin, opening toward -Y
    const coneMaterial = new ShaderMaterial({
      uniforms: this.coneUniforms,
      vertexShader: /* glsl */ `
        varying float vAlong;
        varying vec3 vNormalV;
        varying vec3 vViewDir;
        void main() {
          vAlong = -position.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vNormalV = normalize(normalMatrix * normal);
          vViewDir = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uAlpha;
        uniform float uTime;
        varying float vAlong;
        varying vec3 vNormalV;
        varying vec3 vViewDir;
        void main() {
          float rim = 1.0 - abs(dot(normalize(vNormalV), normalize(vViewDir)));
          float body = smoothstep(0.02, 0.25, vAlong) * (1.0 - smoothstep(0.55, 1.0, vAlong));
          float bands = 0.75 + 0.25 * sin(vAlong * 40.0 - uTime * 30.0);
          float a = pow(rim, 1.5) * body * bands * uAlpha;
          gl_FragColor = vec4(vec3(0.97, 0.95, 0.93), a * 0.55);
        }`,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    this.cone = new Mesh(coneGeometry, coneMaterial);
    this.cone.visible = false;
    this.cone.frustumCulled = false;
  }

  trigger(position: Vector3, direction: Vector3): void {
    this.ringAge = 0;
    this.coneAge = 0;
    this.ring.position.copy(position);
    this.ring.quaternion.setFromUnitVectors(this.zAxis, direction);
    this.ring.visible = true;
    this.cone.visible = true;
  }

  update(dt: number, time: number, heroPosition: Vector3, heroDirection: Vector3): void {
    if (this.ring.visible) {
      this.ringAge += dt;
      const t = this.ringAge / 1.1;
      const eased = 1 - Math.pow(1 - Math.min(t, 1), 3);
      this.ring.scale.setScalar(2 + eased * 52);
      this.ringUniforms.uAlpha.value = 1.4 * Math.pow(1 - Math.min(t, 1), 1.5);
      if (t >= 1) this.ring.visible = false;
    }
    if (this.cone.visible) {
      this.coneAge += dt;
      const t = this.coneAge / 0.55;
      this.cone.position.copy(heroPosition).addScaledVector(heroDirection, 1.1);
      this.cone.quaternion.setFromUnitVectors(this.yAxis, heroDirection);
      this.cone.scale.set(1.5 + t * 1.6, 4.2 + t * 2, 1.5 + t * 1.6);
      this.coneUniforms.uAlpha.value = Math.sin(Math.min(t, 1) * Math.PI);
      this.coneUniforms.uTime.value = time;
      if (t >= 1) this.cone.visible = false;
    }
  }
}

export class SpeedEffects {
  readonly streaks: WindStreaks;
  readonly shockwave: Shockwave;
  readonly sparks = new ParticlePool({ capacity: 360, color: '#ffd7a0', additive: true, drag: 2.2 });
  readonly spray = new ParticlePool({ capacity: 520, color: '#f3efe9', additive: false, gravity: 9.81, drag: 0.6 });
  readonly grit = new ParticlePool({ capacity: 160, color: '#d8cfc4', additive: false, gravity: 1.5, drag: 1.8 });
  sprayCarry = 0;
  streetCarry = 0;

  // v1 drew every streak, burst and spray particle from one module-level stream seeded 99; each
  // instance owns that stream now (same sequence for the one instance the game makes).
  private readonly random = createRandom(99);

  /** Adds its meshes to `scene` (or any parent); street dust and launch/impact puffs go to `plumes`. */
  constructor(
    scene: Object3D,
    readonly plumes: DustPlumes,
  ) {
    this.streaks = new WindStreaks(this.random);
    this.shockwave = new Shockwave();
    scene.add(this.streaks.mesh, this.shockwave.ring, this.shockwave.cone, this.sparks.points, this.spray.points, this.grit.points);
  }

  /** Kills every particle (Restart). Streaks and the shockwave fade on their own. */
  clear(): void {
    this.sparks.clear();
    this.spray.clear();
    this.grit.clear();
  }

  burstSparks(position: Vector3Like, count = 48, speed = 14, size = 1.2): void {
    const random = this.random;
    for (let i = 0; i < count; i++) {
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      const s = speed * (0.4 + random() * 0.6);
      this.sparks.spawn(
        position.x, position.y, position.z,
        Math.sin(phi) * Math.cos(theta) * s, Math.cos(phi) * s, Math.sin(phi) * Math.sin(theta) * s,
        0.7 + random() * 0.6, size * (0.6 + random() * 0.8),
      );
    }
  }

  onLaunch(position: Vector3Like, direction: Vector3Like): void {
    const random = this.random;
    for (let i = 0; i < 40; i++) {
      const theta = random() * Math.PI * 2;
      const s = 8 + random() * 8;
      this.grit.spawn(
        position.x, position.y - 0.4, position.z,
        Math.cos(theta) * s - direction.x * 6, (random() - 0.3) * 3, Math.sin(theta) * s - direction.z * 6,
        0.6 + random() * 0.5, 1.4 + random(),
      );
    }
    for (let i = 0; i < 5; i++) {
      const theta = (i / 5) * Math.PI * 2;
      this.plumes.puff(position.x, position.y - 0.8, position.z, {
        size: 3, growth: 3, life: 2.4, rise: 0.5, alpha: 0.28, vx: Math.cos(theta) * 7 - direction.x * 4, vz: Math.sin(theta) * 7 - direction.z * 4,
      });
    }
  }

  onBoom(position: Vector3, direction: Vector3): void {
    this.shockwave.trigger(position, direction);
  }

  onImpact(position: Vector3Like, normal: Vector3Like, strength: number): void {
    const random = this.random;
    const count = Math.round(10 + strength * 30);
    for (let i = 0; i < count; i++) {
      const s = 3 + random() * 9 * strength;
      this.grit.spawn(
        position.x, position.y, position.z,
        normal.x * s + (random() - 0.5) * 6, normal.y * s + (random() - 0.5) * 6, normal.z * s + (random() - 0.5) * 6,
        0.6 + random() * 0.7, 1 + random() * 1.5,
      );
    }
    for (let i = 0; i < 2 + Math.round(strength * 3); i++) {
      this.plumes.puff(position.x + (random() - 0.5) * 3, position.y, position.z + (random() - 0.5) * 3, {
        size: 4 + strength * 5, growth: 2.2, life: 3.5, rise: 0.8, alpha: 0.4, vx: normal.x * 3, vz: normal.z * 3, darkness: 0.15,
      });
    }
  }

  onSplash(position: Vector3Like, strength: number): void {
    const random = this.random;
    const count = Math.round(40 + strength * 80);
    for (let i = 0; i < count; i++) {
      const theta = random() * Math.PI * 2;
      const s = 4 + random() * 10 * strength;
      this.spray.spawn(position.x, 0.3, position.z, Math.cos(theta) * s, 6 + random() * 12 * strength, Math.sin(theta) * s, 1 + random() * 0.8, 0.9 + random());
    }
  }

  /** Call once per frame with sim dt and sim time. */
  update(dt: number, time: number, { camera, flight, projectionScale }: SpeedEffectsFrame): void {
    const random = this.random;
    const speed = flight.speed;
    const streakIntensity = smoothstep(38, 100, speed) + flight.surfaceRush * 0.4;
    this.streaks.update(camera, flight.velocity, clamp(streakIntensity, 0, 1));

    this.shockwave.update(dt, time, flight.position, flight.forward);

    // Sea spray while skimming low over water.
    if (flight.overWater && flight.groundClearance < 9 && speed > 22) {
      const closeness = 1 - smoothstep(1.5, 9, flight.groundClearance);
      this.sprayCarry += dt * closeness * speed * 2.4;
      const f = flight.forward;
      while (this.sprayCarry >= 1) {
        this.sprayCarry -= 1;
        const side = (random() - 0.5) * 2;
        this.spray.spawn(
          flight.position.x - f.x * 2 + f.z * side, 0.25, flight.position.z - f.z * 2 - f.x * side,
          f.z * side * 5 + f.x * speed * 0.2, 3 + random() * 7 * closeness, -f.x * side * 5 + f.z * speed * 0.2,
          0.7 + random() * 0.7, 0.6 + random() * 0.9,
        );
      }
    }

    // Street dust kicked up when skimming low over land.
    if (!flight.overWater && flight.groundClearance < 8 && speed > 28) {
      const closeness = 1 - smoothstep(1.5, 8, flight.groundClearance);
      this.streetCarry += dt * closeness * speed * 0.16;
      const f = flight.forward;
      while (this.streetCarry >= 1) {
        this.streetCarry -= 1;
        const side = (random() - 0.5) * 6;
        const ground = flight.position.y - flight.groundClearance;
        this.plumes.puff(flight.position.x - f.x * 3 + f.z * side, ground + 1.5, flight.position.z - f.z * 3 - f.x * side, {
          size: 3 + random() * 3, growth: 3, life: 3 + random() * 2, rise: 0.7, alpha: 0.35,
          vx: f.x * speed * 0.15 + f.z * side, vz: f.z * speed * 0.15 - f.x * side, darkness: 0.1,
        });
      }
    }

    this.sparks.update(dt, projectionScale);
    this.spray.update(dt, projectionScale);
    this.grit.update(dt, projectionScale);
  }
}
