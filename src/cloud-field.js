import * as THREE from 'three';
import { ATMOSPHERE_GLSL, atmosphereUniforms, PALETTE } from './atmosphere.js';
import { createRandom } from './seeded-noise.js';
import { smoothstep } from './scalar-math.js';

// A layer of fair-weather cumulus: soft instanced puffs with flat bases, lit warm on
// the sunward side and lilac in shade. Fly through one and it parts around you,
// then slowly billows back.

const WIND = new THREE.Vector3(2.2, 0, 0.7);
const CELL = 320;

const vertexShader = /* glsl */ `
uniform float uTime;
attribute vec4 aPuff; // cloud base, cloud top, seed
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec2 vCloudSpan;
void main() {
  mat4 world = modelMatrix * instanceMatrix;
  vec4 p = world * vec4(position, 1.0);
  vec3 n = normalize(mat3(world) * normal);
  float below = aPuff.x - p.y;
  if (below > 0.0) {
    p.y = aPuff.x - below * 0.1;
    n = normalize(mix(n, vec3(0.0, -1.0, 0.0), 0.75));
  }
  p.xyz += n * sin(uTime * 0.25 + aPuff.z * 40.0 + position.x * 2.0 + position.y * 1.5) * 1.8;
  vWorld = p.xyz;
  vNormalW = n;
  vCloudSpan = aPuff.xy;
  gl_Position = projectionMatrix * viewMatrix * p;
}
`;

const fragmentShader = /* glsl */ `
${ATMOSPHERE_GLSL.replace('uniform float uTime;', '')}
uniform vec3 uShadeLow;
uniform vec3 uShadeHigh;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec2 vCloudSpan;
void main() {
  vec3 toFrag = vWorld - cameraPosition;
  float dist = length(toFrag);
  vec3 rd = toFrag / dist;
  vec3 n = normalize(vNormalW);
  float heightT = clamp((vWorld.y - vCloudSpan.x) / max(vCloudSpan.y - vCloudSpan.x, 1.0), 0.0, 1.0);
  float wrap = clamp(dot(n, uSunDir) * 0.6 + 0.4, 0.0, 1.0);
  float light = smoothstep(0.0, 1.0, wrap * mix(0.42, 1.0, heightT));
  vec3 shade = mix(uShadeLow, uShadeHigh, heightT);
  vec3 lit = uSunColor * 1.3 + vec3(0.06, 0.05, 0.08);
  vec3 col = mix(shade, lit, light);
  col += uSkyZenith * 0.28 * max(n.y, 0.0);
  float facing = clamp(dot(n, -rd), 0.0, 1.0);
  float towardSun = pow(max(dot(rd, uSunDir), 0.0), 4.0);
  col += uSunColor * pow(1.0 - facing, 3.0) * towardSun * 2.4; // silver lining
  col = applyAerialPerspective(col, vWorld);
  float alpha = smoothstep(0.03, 0.4, facing) * smoothstep(10.0, 80.0, dist);
  gl_FragColor = vec4(col, alpha);
}
`;

export class CloudField {
  constructor({ detail = 2, count = 150 } = {}) {
    this.random = createRandom(777);
    this.puffs = [];
    this.clouds = [];
    this.drift = new THREE.Vector3();
    this.cells = new Map();
    this.disturbed = new Set();
    this.#generate(count);
    this.mesh = this.#buildMesh(detail);
    this._local = new THREE.Vector3();
    this._matrix = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
    this._center = new THREE.Vector3();
  }

  #generate(count) {
    const random = this.random;
    for (let c = 0; c < count; c++) {
      const angle = random() * Math.PI * 2;
      const distance = 500 + Math.sqrt(random()) * 6400;
      const cx = Math.cos(angle) * distance;
      const cz = Math.sin(angle) * distance;
      const size = 90 + Math.pow(random(), 1.7) * 300;
      const base = 470 + random() * 80;
      const puffCount = Math.min(15, 5 + Math.floor(size / 32));
      const cloudPuffs = [];
      let top = base;
      for (let p = 0; p < puffCount; p++) {
        const a = random() * Math.PI * 2;
        const r = Math.sqrt(random()) * size * 0.75;
        const centerWeight = 1 - r / (size * 0.75);
        const radius = size * (0.22 + 0.22 * random()) * (0.55 + 0.6 * centerWeight);
        const center = new THREE.Vector3(
          cx + Math.cos(a) * r * 1.15,
          base + radius * (0.2 + 0.5 * random() * (0.5 + centerWeight)),
          cz + Math.sin(a) * r * 0.75,
        );
        const puff = { center, radius, cloudBase: base, cloudTop: 0, seed: random(), disturb: 0, push: new THREE.Vector3() };
        cloudPuffs.push(puff);
        top = Math.max(top, center.y + radius);
      }
      for (const puff of cloudPuffs) {
        puff.cloudTop = top;
        puff.index = this.puffs.length;
        this.puffs.push(puff);
        this.#index(puff);
      }
      this.clouds.push({ x: cx, z: cz, base, top, size });
    }
  }

  #key(ix, iz) {
    return (ix + 1024) * 2048 + (iz + 1024);
  }

  #index(puff) {
    const r = puff.radius;
    for (let ix = Math.floor((puff.center.x - r) / CELL); ix <= Math.floor((puff.center.x + r) / CELL); ix++) {
      for (let iz = Math.floor((puff.center.z - r) / CELL); iz <= Math.floor((puff.center.z + r) / CELL); iz++) {
        const key = this.#key(ix, iz);
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key).push(puff);
      }
    }
  }

  #near(local, visit) {
    const list = this.cells.get(this.#key(Math.floor(local.x / CELL), Math.floor(local.z / CELL)));
    if (list) for (const puff of list) visit(puff);
  }

  #buildMesh(detail) {
    const geometry = new THREE.IcosahedronGeometry(1, detail);
    const data = new Float32Array(this.puffs.length * 4);
    this.puffs.forEach((puff, i) => data.set([puff.cloudBase, puff.cloudTop, puff.seed, 0], i * 4));
    geometry.setAttribute('aPuff', new THREE.InstancedBufferAttribute(data, 4));
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...atmosphereUniforms,
        uShadeLow: { value: PALETTE.cloudShadeLow },
        uShadeHigh: { value: PALETTE.cloudShadeHigh },
      },
      vertexShader,
      fragmentShader,
      alphaToCoverage: true,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, this.puffs.length);
    const matrix = new THREE.Matrix4();
    this.puffs.forEach((puff, i) => {
      matrix.makeScale(puff.radius, puff.radius, puff.radius).setPosition(puff.center);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.frustumCulled = false;
    return mesh;
  }

  #currentShape(puff, outCenter) {
    const ease = puff.disturb * puff.disturb * (3 - 2 * puff.disturb);
    outCenter.copy(puff.center).addScaledVector(puff.push, puff.radius * 0.5 * ease);
    return puff.radius * (1 - 0.42 * ease);
  }

  update(dt, heroPosition, heroVelocity) {
    this.drift.addScaledVector(WIND, dt);
    this.mesh.position.copy(this.drift);

    const local = this._local.copy(heroPosition).sub(this.drift);
    if (local.y > 400 && local.y < 1100 && heroVelocity.lengthSq() > 25) {
      this.#near(local, (puff) => {
        const radius = this.#currentShape(puff, this._center);
        const offset = this._center.sub(local);
        if (offset.length() < radius * 0.95 && local.y > puff.cloudBase - 4) {
          // Push the puff sideways, away from the flight line.
          const along = heroVelocity.clone().normalize();
          const away = puff.center.clone().sub(local);
          away.addScaledVector(along, -away.dot(along));
          if (away.lengthSq() < 1e-3) away.set(along.z, 0.3, -along.x);
          puff.push.lerp(away.normalize(), puff.disturb > 0.2 ? 0.2 : 1);
          puff.disturb = 1;
          this.disturbed.add(puff);
        }
      });
    }

    if (this.disturbed.size > 0) {
      for (const puff of this.disturbed) {
        puff.disturb = Math.max(0, puff.disturb - dt / 10);
        const radius = this.#currentShape(puff, this._center);
        this._matrix.compose(this._center, this._quat, this._scale.setScalar(radius));
        this.mesh.setMatrixAt(puff.index, this._matrix);
        if (puff.disturb === 0) this.disturbed.delete(puff);
      }
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // 0..1: how deep inside a cloud a point is (drives the white-out and muffled wind).
  immersion(position) {
    const local = this._local.copy(position).sub(this.drift);
    let best = 0;
    this.#near(local, (puff) => {
      if (local.y < puff.cloudBase - 3) return;
      const radius = this.#currentShape(puff, this._center);
      const d = this._center.distanceTo(local) / radius;
      best = Math.max(best, 1 - smoothstep(0.5, 1.0, d));
    });
    return best;
  }

  // Top-centre of the largest cloud near a point: a landmark for sparks above the clouds.
  largestCloudNear(x, z, maxDistance) {
    let best = null;
    for (const cloud of this.clouds) {
      const d = Math.hypot(cloud.x - x, cloud.z - z);
      if (d > maxDistance) continue;
      if (!best || cloud.size > best.size) best = cloud;
    }
    return best;
  }
}
