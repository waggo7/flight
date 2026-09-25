import * as THREE from 'three';
import { clamp, smoothstep } from './scalar-math.js';
import { createRandom } from './seeded-noise.js';
import { ParticlePool } from './particle-pool.js';

// Everything that sells speed and impact: air streaks, the shockwave ring and
// vapour cone, sea spray, street dust, and spark bursts.

const random = createRandom(99);

class WindStreaks {
  constructor(count = 120) {
    this.count = count;
    this.anchors = Array.from({ length: count }, () => new THREE.Vector3(1e6, 1e6, 1e6));
    this.positions = new Float32Array(count * 6);
    this.alphas = new Float32Array(count * 2);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying float vAlpha;
        void main() { vAlpha = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() { gl_FragColor = vec4(vec3(1.0, 0.95, 0.88) * vAlpha, 1.0); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.LineSegments(geometry, material);
    this.mesh.frustumCulled = false;
    this._dir = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._rel = new THREE.Vector3();
  }

  update(camera, velocity, intensity) {
    const speed = velocity.length();
    this.mesh.visible = intensity > 0.01 && speed > 1;
    if (!this.mesh.visible) return;
    const dir = this._dir.copy(velocity).divideScalar(speed);
    const a = this._a.set(dir.z, 0, -dir.x);
    if (a.lengthSq() < 1e-4) a.set(1, 0, 0);
    a.normalize();
    const b = this._b.crossVectors(dir, a);
    const length = clamp(speed * 0.055, 0.6, 7.5);
    for (let i = 0; i < this.count; i++) {
      const p = this.anchors[i];
      const rel = this._rel.subVectors(p, camera.position);
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
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

class Shockwave {
  constructor() {
    this.ringMaterial = new THREE.ShaderMaterial({
      uniforms: { uAlpha: { value: 0 } },
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
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 96, 1), this.ringMaterial);
    this.ring.visible = false;
    this.ring.frustumCulled = false;

    const coneGeometry = new THREE.ConeGeometry(1, 1, 48, 8, true);
    coneGeometry.translate(0, -0.5, 0); // apex at the origin, opening toward -Y
    this.coneMaterial = new THREE.ShaderMaterial({
      uniforms: { uAlpha: { value: 0 }, uTime: { value: 0 } },
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
      side: THREE.DoubleSide,
    });
    this.cone = new THREE.Mesh(coneGeometry, this.coneMaterial);
    this.cone.visible = false;
    this.cone.frustumCulled = false;
    this.ringAge = Infinity;
    this.coneAge = Infinity;
    this._quat = new THREE.Quaternion();
    this._yAxis = new THREE.Vector3(0, 1, 0);
    this._zAxis = new THREE.Vector3(0, 0, 1);
  }

  trigger(position, direction) {
    this.ringAge = 0;
    this.coneAge = 0;
    this.ring.position.copy(position);
    this.ring.quaternion.setFromUnitVectors(this._zAxis, direction);
    this.ring.visible = true;
    this.cone.visible = true;
  }

  update(dt, time, heroPosition, heroDirection) {
    if (this.ring.visible) {
      this.ringAge += dt;
      const t = this.ringAge / 1.1;
      const eased = 1 - Math.pow(1 - Math.min(t, 1), 3);
      this.ring.scale.setScalar(2 + eased * 52);
      this.ringMaterial.uniforms.uAlpha.value = 1.4 * Math.pow(1 - Math.min(t, 1), 1.5);
      if (t >= 1) this.ring.visible = false;
    }
    if (this.cone.visible) {
      this.coneAge += dt;
      const t = this.coneAge / 0.55;
      this.cone.position.copy(heroPosition).addScaledVector(heroDirection, 1.1);
      this.cone.quaternion.setFromUnitVectors(this._yAxis, heroDirection);
      this.cone.scale.set(1.5 + t * 1.6, 4.2 + t * 2, 1.5 + t * 1.6);
      this.coneMaterial.uniforms.uAlpha.value = Math.sin(Math.min(t, 1) * Math.PI);
      this.coneMaterial.uniforms.uTime.value = time;
      if (t >= 1) this.cone.visible = false;
    }
  }
}

export class SpeedEffects {
  constructor(scene, plumes) {
    this.plumes = plumes;
    this.streaks = new WindStreaks();
    this.shockwave = new Shockwave();
    this.sparks = new ParticlePool({ capacity: 360, color: '#ffd7a0', additive: true, drag: 2.2 });
    this.spray = new ParticlePool({ capacity: 520, color: '#f3efe9', additive: false, gravity: 9.81, drag: 0.6 });
    this.grit = new ParticlePool({ capacity: 160, color: '#d8cfc4', additive: false, gravity: 1.5, drag: 1.8 });
    scene.add(this.streaks.mesh, this.shockwave.ring, this.shockwave.cone, this.sparks.points, this.spray.points, this.grit.points);
    this.sprayCarry = 0;
    this.streetCarry = 0;
  }

  clear() {
    this.sparks.clear();
    this.spray.clear();
    this.grit.clear();
  }

  burstSparks(position, count = 48, speed = 14, size = 1.2) {
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

  onLaunch(position, direction) {
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

  onBoom(position, direction) {
    this.shockwave.trigger(position, direction);
  }

  onImpact(position, normal, strength) {
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

  onSplash(position, strength) {
    const count = Math.round(40 + strength * 80);
    for (let i = 0; i < count; i++) {
      const theta = random() * Math.PI * 2;
      const s = 4 + random() * 10 * strength;
      this.spray.spawn(position.x, 0.3, position.z, Math.cos(theta) * s, 6 + random() * 12 * strength, Math.sin(theta) * s, 1 + random() * 0.8, 0.9 + random());
    }
  }

  update(dt, time, { camera, flight, projectionScale }) {
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
