import * as THREE from 'three';

// Position-based cloth for the cape, simulated in a frame that travels with the hero
// (translation only). In that frame the air rushes past at -heroVelocity, so the
// cape streams, ripples and settles without the anchors ever outrunning the cloth.

const GRAVITY = new THREE.Vector3(0, -9.81, 0);

export class CapeCloth {
  constructor({ cols = 11, rows = 16, topWidth = 0.42, bottomWidth = 1.08, length = 1.5 } = {}) {
    this.cols = cols;
    this.rows = rows;
    const count = cols * rows;
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.pred = new Float32Array(count * 3);
    this.normals = new Float32Array(count * 3);
    this.invMass = new Float32Array(count).fill(1);
    for (let c = 0; c < cols; c++) this.invMass[c] = 0; // top row is pinned to the shoulders

    // Flat rest layout: a trapezoid that flares toward the hem.
    this.rest = new Float32Array(count * 2);
    for (let r = 0; r < rows; r++) {
      const v = r / (rows - 1);
      const width = topWidth + (bottomWidth - topWidth) * Math.pow(v, 0.8);
      for (let c = 0; c < cols; c++) {
        const u = c / (cols - 1);
        this.rest[(r * cols + c) * 2] = (u - 0.5) * width;
        this.rest[(r * cols + c) * 2 + 1] = v * length;
      }
    }

    const constraints = [];
    const link = (a, b, stiffness) => {
      const ax = this.rest[a * 2];
      const ay = this.rest[a * 2 + 1];
      const bx = this.rest[b * 2];
      const by = this.rest[b * 2 + 1];
      constraints.push(a, b, Math.hypot(bx - ax, by - ay), stiffness);
    };
    const id = (r, c) => r * cols + c;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (c + 1 < cols) link(id(r, c), id(r, c + 1), 1);
        if (r + 1 < rows) link(id(r, c), id(r + 1, c), 1);
        if (r + 1 < rows && c + 1 < cols) {
          link(id(r, c), id(r + 1, c + 1), 0.7);
          link(id(r, c + 1), id(r + 1, c), 0.7);
        }
        if (c + 2 < cols) link(id(r, c), id(r, c + 2), 0.22);
        if (r + 2 < rows) link(id(r, c), id(r + 2, c), 0.22);
      }
    }
    this.constraints = new Float32Array(constraints);

    // Long-range attachments: no point may drift farther from its shoulder anchor than its rest path.
    this.tether = new Float32Array(count);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = id(r, c);
        const a = id(0, c);
        this.tether[i] = Math.hypot(this.rest[i * 2] - this.rest[a * 2], this.rest[i * 2 + 1] - this.rest[a * 2 + 1]) * 1.03;
      }
    }

    this.geometry = this.#buildGeometry();
    this.anchors = new Float32Array(cols * 3);
    this.prevAnchors = new Float32Array(cols * 3);
    this.time = 0;
    this._wind = new THREE.Vector3();
  }

  #buildGeometry() {
    const { cols, rows } = this;
    const geometry = new THREE.BufferGeometry();
    const uv = new Float32Array(this.count * 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        uv[(r * cols + c) * 2] = c / (cols - 1);
        uv[(r * cols + c) * 2 + 1] = 1 - r / (rows - 1);
      }
    }
    const index = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        index.push(a, d, b, b, d, e);
      }
    }
    const position = new THREE.BufferAttribute(this.pos, 3);
    position.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', position);
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    geometry.attributes.normal.setUsage(THREE.DynamicDrawUsage);
    return geometry;
  }

  // Anchors are given relative to the hero root, in world orientation.
  setAnchors(anchorArray) {
    this.prevAnchors.set(this.anchors);
    this.anchors.set(anchorArray);
  }

  // Lay the cape straight down from the anchors, flaring toward the hem, just behind the back.
  drape(anchorArray, down, back) {
    this.anchors.set(anchorArray);
    this.prevAnchors.set(anchorArray);
    const { cols, rows, rest } = this;
    const last = (cols - 1) * 3;
    const sx = anchorArray[last] - anchorArray[0];
    const sy = anchorArray[last + 1] - anchorArray[1];
    const sz = anchorArray[last + 2] - anchorArray[2];
    const sideLength = Math.hypot(sx, sy, sz) || 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const along = rest[i * 2 + 1];
        const flare = (rest[i * 2] - rest[c * 2]) / sideLength;
        for (let axis = 0; axis < 3; axis++) {
          const key = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
          const side = axis === 0 ? sx : axis === 1 ? sy : sz;
          this.pos[i * 3 + axis] = anchorArray[c * 3 + axis] + down[key] * along * 0.98 + back[key] * along * 0.14 + side * flare;
        }
        this.vel[i * 3] = this.vel[i * 3 + 1] = this.vel[i * 3 + 2] = 0;
      }
    }
    this.#refreshGeometry();
  }

  // capsule: { a: Vector3, b: Vector3, radius } relative to the hero root.
  step(dt, heroVelocity, frameAcceleration, capsule) {
    if (dt <= 0) return;
    this.time += dt;
    const substeps = Math.min(6, Math.max(2, Math.ceil(dt / (1 / 240))));
    const h = dt / substeps;
    this.#computeNormals();

    const airSpeed = heroVelocity.length();
    const wind = this._wind.copy(heroVelocity).multiplyScalar(-1);
    const gust = 0.7 + Math.min(airSpeed, 150) * 0.1;
    const flutterFreq = 5 + Math.min(airSpeed, 150) * 0.11;
    const gx = GRAVITY.x - frameAcceleration.x * 0.8;
    const gy = GRAVITY.y - frameAcceleration.y * 0.8;
    const gz = GRAVITY.z - frameAcceleration.z * 0.8;
    const normalDrag = 1 - Math.exp(-7 * h);
    const tangentDrag = 1 - Math.exp(-0.9 * h);
    const damping = Math.exp(-0.35 * h);

    const { cols, pos, vel, pred, normals, invMass } = this;
    for (let s = 0; s < substeps; s++) {
      const blend = (s + 1) / substeps;
      const phase = this.time * flutterFreq;
      for (let i = 0; i < this.count; i++) {
        const k = i * 3;
        if (invMass[i] === 0) {
          const c = i % cols;
          pred[k] = this.prevAnchors[c * 3] + (this.anchors[c * 3] - this.prevAnchors[c * 3]) * blend;
          pred[k + 1] = this.prevAnchors[c * 3 + 1] + (this.anchors[c * 3 + 1] - this.prevAnchors[c * 3 + 1]) * blend;
          pred[k + 2] = this.prevAnchors[c * 3 + 2] + (this.anchors[c * 3 + 2] - this.prevAnchors[c * 3 + 2]) * blend;
          continue;
        }
        const row = Math.floor(i / cols);
        const col = i % cols;
        const wave = Math.sin(phase - row * 0.85 + col * 0.35) * gust;
        const wave2 = Math.sin(phase * 1.7 - row * 1.3 - col * 0.5) * gust * 0.45;
        const nx = normals[k];
        const ny = normals[k + 1];
        const nz = normals[k + 2];

        let vx = vel[k] + gx * h;
        let vy = vel[k + 1] + gy * h;
        let vz = vel[k + 2] + gz * h;
        // Air relative to the cloth, with travelling ripples along the surface normal.
        const ax = wind.x + nx * (wave + wave2) - vx;
        const ay = wind.y + ny * (wave + wave2) - vy;
        const az = wind.z + nz * (wave + wave2) - vz;
        const an = ax * nx + ay * ny + az * nz;
        vx += nx * an * normalDrag + (ax - nx * an) * tangentDrag;
        vy += ny * an * normalDrag + (ay - ny * an) * tangentDrag;
        vz += nz * an * normalDrag + (az - nz * an) * tangentDrag;
        vel[k] = vx * damping;
        vel[k + 1] = vy * damping;
        vel[k + 2] = vz * damping;
        pred[k] = pos[k] + vel[k] * h;
        pred[k + 1] = pos[k + 1] + vel[k + 1] * h;
        pred[k + 2] = pos[k + 2] + vel[k + 2] * h;
      }

      this.#solveConstraints(7);
      this.#applyTethers();
      if (capsule) this.#collideCapsule(capsule);

      for (let i = 0; i < this.count; i++) {
        const k = i * 3;
        if (invMass[i] !== 0) {
          vel[k] = (pred[k] - pos[k]) / h;
          vel[k + 1] = (pred[k + 1] - pos[k + 1]) / h;
          vel[k + 2] = (pred[k + 2] - pos[k + 2]) / h;
        }
        pos[k] = pred[k];
        pos[k + 1] = pred[k + 1];
        pos[k + 2] = pred[k + 2];
      }
    }
    this.#refreshGeometry();
  }

  #solveConstraints(iterations) {
    const { constraints, pred, invMass } = this;
    for (let it = 0; it < iterations; it++) {
      for (let n = 0; n < constraints.length; n += 4) {
        const a = constraints[n];
        const b = constraints[n + 1];
        const restLength = constraints[n + 2];
        const stiffness = constraints[n + 3];
        const wa = invMass[a];
        const wb = invMass[b];
        const w = wa + wb;
        if (w === 0) continue;
        const ka = a * 3;
        const kb = b * 3;
        const dx = pred[kb] - pred[ka];
        const dy = pred[kb + 1] - pred[ka + 1];
        const dz = pred[kb + 2] - pred[ka + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-7) continue;
        const correction = ((len - restLength) / (len * w)) * stiffness;
        pred[ka] += dx * correction * wa;
        pred[ka + 1] += dy * correction * wa;
        pred[ka + 2] += dz * correction * wa;
        pred[kb] -= dx * correction * wb;
        pred[kb + 1] -= dy * correction * wb;
        pred[kb + 2] -= dz * correction * wb;
      }
    }
  }

  #applyTethers() {
    const { cols, pred, tether } = this;
    for (let i = cols; i < this.count; i++) {
      const k = i * 3;
      const ka = (i % cols) * 3;
      const dx = pred[k] - pred[ka];
      const dy = pred[k + 1] - pred[ka + 1];
      const dz = pred[k + 2] - pred[ka + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len > tether[i]) {
        const scale = tether[i] / len;
        pred[k] = pred[ka] + dx * scale;
        pred[k + 1] = pred[ka + 1] + dy * scale;
        pred[k + 2] = pred[ka + 2] + dz * scale;
      }
    }
  }

  #collideCapsule({ a, b, radius }) {
    const { pred } = this;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const abLenSq = abx * abx + aby * aby + abz * abz || 1;
    for (let i = this.cols; i < this.count; i++) {
      const k = i * 3;
      const px = pred[k] - a.x;
      const py = pred[k + 1] - a.y;
      const pz = pred[k + 2] - a.z;
      const t = Math.min(1, Math.max(0, (px * abx + py * aby + pz * abz) / abLenSq));
      const dx = px - abx * t;
      const dy = py - aby * t;
      const dz = pz - abz * t;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < radius && d > 1e-6) {
        const push = (radius - d) / d;
        pred[k] += dx * push;
        pred[k + 1] += dy * push;
        pred[k + 2] += dz * push;
      }
    }
  }

  #computeNormals() {
    const { cols, rows, pos, normals } = this;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const left = (r * cols + Math.max(c - 1, 0)) * 3;
        const right = (r * cols + Math.min(c + 1, cols - 1)) * 3;
        const up = (Math.max(r - 1, 0) * cols + c) * 3;
        const down = (Math.min(r + 1, rows - 1) * cols + c) * 3;
        const ux = pos[right] - pos[left];
        const uy = pos[right + 1] - pos[left + 1];
        const uz = pos[right + 2] - pos[left + 2];
        const vx = pos[down] - pos[up];
        const vy = pos[down + 1] - pos[up + 1];
        const vz = pos[down + 2] - pos[up + 2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        normals[i * 3] = nx;
        normals[i * 3 + 1] = ny;
        normals[i * 3 + 2] = nz;
      }
    }
  }

  #refreshGeometry() {
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  isFinite() {
    for (let i = 0; i < this.pos.length; i++) if (!Number.isFinite(this.pos[i])) return false;
    return true;
  }
}
