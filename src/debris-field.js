import * as THREE from 'three';
import { applyAtmosphere } from './atmosphere.js';

// Chunks of concrete and cladding: they tumble, bounce once or twice, come to rest on
// streets and rooftops, linger for a while, then sink away. One instanced draw call.

const GRAVITY = 9.81;
const FREE = 0;
const FLYING = 1;
const RESTING = 2;

export class DebrisField {
  constructor({ capacity = 900, floorAt }) {
    this.capacity = capacity;
    this.floorAt = floorAt;
    this.cursor = 0;
    this.state = new Uint8Array(capacity);
    this.position = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.rotation = new Float32Array(capacity * 4);
    this.spin = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity * 3);
    this.floor = new Float32Array(capacity);
    this.floorTimer = new Float32Array(capacity);
    this.rest = new Float32Array(capacity);
    this.linger = new Float32Array(capacity);

    const material = applyAtmosphere(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, metalness: 0.04 }), {
      key: 'debris',
      patch: (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          if (distance(vAerialWorld, cameraPosition) < 2.8) discard;`,
        );
      },
    });
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, hidden);
      this.mesh.setColorAt(i, white);
    }
    this.live = 0;
    this._matrix = new THREE.Matrix4();
    this._position = new THREE.Vector3();
    this._quaternion = new THREE.Quaternion();
    this._step = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
    this._axis = new THREE.Vector3();
  }

  spawn(x, y, z, vx, vy, vz, size, color) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.state[i] = FLYING;
    this.position.set([x, y, z], i * 3);
    this.velocity.set([vx, vy, vz], i * 3);
    const q = this._quaternion.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    this.rotation.set([q.x, q.y, q.z, q.w], i * 4);
    const spinRate = 2 + Math.random() * 6;
    this.spin.set([(Math.random() - 0.5) * spinRate, (Math.random() - 0.5) * spinRate, (Math.random() - 0.5) * spinRate], i * 3);
    this.size.set([size * (0.6 + Math.random() * 0.8), size * (0.4 + Math.random() * 0.7), size * (0.6 + Math.random() * 0.8)], i * 3);
    this.floor[i] = this.floorAt(x, z, y);
    this.floorTimer[i] = 0.15;
    this.rest[i] = 0;
    this.linger[i] = 18 + Math.random() * 10;
    this.mesh.setColorAt(i, color);
    this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    const hidden = this._matrix.makeScale(0, 0, 0);
    for (let i = 0; i < this.capacity; i++) {
      this.state[i] = FREE;
      this.mesh.setMatrixAt(i, hidden);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.live = 0;
  }

  update(dt) {
    if (dt <= 0) return;
    let live = 0;
    let changed = false;
    const drag = Math.exp(-0.12 * dt);
    for (let i = 0; i < this.capacity; i++) {
      const state = this.state[i];
      if (state === FREE) continue;
      live++;
      const k = i * 3;
      const halfHeight = this.size[k + 1] * 0.5;
      let shrink = 1;

      if (state === FLYING) {
        this.velocity[k] *= drag;
        this.velocity[k + 1] = this.velocity[k + 1] * drag - GRAVITY * dt;
        this.velocity[k + 2] *= drag;
        this.position[k] += this.velocity[k] * dt;
        this.position[k + 1] += this.velocity[k + 1] * dt;
        this.position[k + 2] += this.velocity[k + 2] * dt;

        const q = this._quaternion.fromArray(this.rotation, i * 4);
        const sx = this.spin[k];
        const sy = this.spin[k + 1];
        const sz = this.spin[k + 2];
        const rate = Math.hypot(sx, sy, sz);
        if (rate > 1e-4) {
          this._step.setFromAxisAngle(this._axis.set(sx / rate, sy / rate, sz / rate), rate * dt);
          q.premultiply(this._step);
          q.toArray(this.rotation, i * 4);
        }

        this.floorTimer[i] -= dt;
        if (this.floorTimer[i] <= 0) {
          this.floorTimer[i] = 0.2;
          this.floor[i] = this.floorAt(this.position[k], this.position[k + 2], this.position[k + 1] + halfHeight);
        }
        if (this.position[k + 1] - halfHeight < this.floor[i]) {
          this.position[k + 1] = this.floor[i] + halfHeight * 0.85;
          if (this.velocity[k + 1] < -4) {
            this.velocity[k + 1] *= -0.28;
            this.velocity[k] *= 0.5;
            this.velocity[k + 2] *= 0.5;
            this.spin[k] *= 0.5;
            this.spin[k + 1] *= 0.5;
            this.spin[k + 2] *= 0.5;
          } else {
            this.state[i] = RESTING;
          }
        }
        changed = true;
      } else {
        this.rest[i] += dt;
        const over = this.rest[i] - this.linger[i];
        if (over > 0) {
          this.position[k + 1] -= dt * 0.8;
          shrink = Math.max(0, 1 - over / 3);
          changed = true;
          if (shrink === 0) {
            this.state[i] = FREE;
            this.mesh.setMatrixAt(i, this._matrix.makeScale(0, 0, 0));
            continue;
          }
        } else {
          continue; // resting and unchanged: keep last matrix
        }
      }

      this._position.set(this.position[k], this.position[k + 1], this.position[k + 2]);
      this._quaternion.fromArray(this.rotation, i * 4);
      this._scale.set(this.size[k] * shrink, this.size[k + 1] * shrink, this.size[k + 2] * shrink);
      this.mesh.setMatrixAt(i, this._matrix.compose(this._position, this._quaternion, this._scale));
    }
    this.live = live;
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
