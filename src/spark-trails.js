import * as THREE from 'three';
import { LANDMARKS } from './city-skyline.js';
import { CITY_PARK } from './island-terrain.js';
import { smoothstep } from './scalar-math.js';

// Glowing sparks laid out in short trails that each tell you where to fly: down an
// avenue, around the twisting tower, over a cloud, skimming the sea, up a mountain.
// Generous pickup radius and a gentle magnet keep collecting forgiving.

const PICKUP_RADIUS = 5.5;
const MAGNET_RADIUS = 24;
const CORE_COLOR = new THREE.Color(6, 3.7, 1.5);
const RING_COLOR = new THREE.Color(3.4, 2.1, 0.8);
const HALO_COLOR = new THREE.Color(1.1, 0.56, 0.2);

const haloVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vec3 center = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float scale = length(instanceMatrix[0].xyz);
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 world = center + (camRight * position.x + camUp * position.y) * scale;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const haloFragment = /* glsl */ `
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float glow = pow(max(1.0 - d, 0.0), 2.4);
  gl_FragColor = vec4(uColor * glow, 1.0);
}
`;

export class SparkTrails {
  constructor({ city, terrain, clouds }) {
    this.clouds = clouds;
    this.sparks = [];
    this.trails = [];
    this.#layOut(city, terrain, clouds);
    this.total = this.sparks.length;
    this.collected = 0;
    this.streak = 0;
    this.lastCollectTime = -Infinity;
    this.respawnAt = Infinity;
    this.group = new THREE.Group();
    this.group.name = 'sparks';
    this.#buildMeshes();
    this._matrix = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._axis = new THREE.Vector3(0.3, 1, 0.2).normalize();
  }

  #addTrail(name, points, { drifts = false } = {}) {
    const trail = { name, sparks: [], drifts };
    for (const point of points) {
      const spark = {
        base: point.clone(),
        position: point.clone(),
        collected: false,
        pop: 0,
        phase: Math.random() * Math.PI * 2,
        trail,
        index: this.sparks.length,
      };
      trail.sparks.push(spark);
      this.sparks.push(spark);
    }
    this.trails.push(trail);
  }

  #layOut(city, terrain, clouds) {
    const clear = (p, minY = 0) => {
      // Nudge upward until the spark floats in open air.
      for (let tries = 0; tries < 40 && !city.isClear(p, 7); tries++) p.y += 6;
      p.y = Math.max(p.y, terrain.heightAt(p.x, p.z) + 8, minY);
      return p;
    };

    // 1. Down the avenue between the downtown towers.
    const avenue = [];
    for (let k = 0; k < 7; k++) {
      avenue.push(clear(new THREE.Vector3(-36 + Math.sin(k * 1.3) * 3.5, 56 + k * 6, -612 + k * 96)));
    }
    this.#addTrail('avenue', avenue);

    // 2. A rising spiral around the twisting tower.
    const twist = LANDMARKS.twist;
    const spiral = [];
    for (let k = 0; k < 9; k++) {
      const angle = k * 0.85;
      spiral.push(clear(new THREE.Vector3(twist.x + Math.cos(angle) * 54, 150 + k * 32, twist.z + Math.sin(angle) * 54)));
    }
    this.#addTrail('spiral', spiral);

    // 3. A crown around the needle of the tallest tower.
    const spire = LANDMARKS.spire;
    const crownY = (spire.top ?? 480) - 70;
    const crown = [];
    for (let k = 0; k < 6; k++) {
      const angle = (k / 6) * Math.PI * 2;
      crown.push(clear(new THREE.Vector3(spire.x + Math.cos(angle) * 40, crownY + Math.sin(angle * 2) * 6, spire.z + Math.sin(angle) * 40)));
    }
    this.#addTrail('crown', crown);

    // 4. Over the top of a big cloud (these drift with the wind).
    const cloud = clouds.largestCloudNear(0, 0, 3200);
    if (cloud) {
      const tops = [];
      for (let k = 0; k < 6; k++) {
        const t = k / 5 - 0.5;
        tops.push(new THREE.Vector3(cloud.x + t * cloud.size * 1.4, cloud.top + 14 + Math.sin(k) * 5, cloud.z + t * cloud.size * 0.3));
      }
      this.#addTrail('cloud', tops, { drifts: true });
    }

    // 5. Skimming the sea toward the western island.
    const seaDir = new THREE.Vector2(-0.91, -0.41).normalize();
    const sea = [];
    for (let k = 0; k < 7; k++) {
      const d = 1560 + k * 85;
      const p = new THREE.Vector3(seaDir.x * d + Math.sin(k * 0.9) * 10, 6, seaDir.y * d);
      p.y = Math.max(6, terrain.heightAt(p.x, p.z) + 6);
      sea.push(p);
    }
    this.#addTrail('sea', sea);

    // 6. A ring around the big mountain's summit.
    const summit = { x: 3350, z: 2550, y: 0 };
    for (let dx = -600; dx <= 600; dx += 40) {
      for (let dz = -600; dz <= 600; dz += 40) {
        const h = terrain.heightAt(3350 + dx, 2550 + dz);
        if (h > summit.y) Object.assign(summit, { x: 3350 + dx, z: 2550 + dz, y: h });
      }
    }
    const peak = [];
    for (let k = 0; k < 6; k++) {
      const angle = (k / 6) * Math.PI * 2;
      const x = summit.x + Math.cos(angle) * 170;
      const z = summit.z + Math.sin(angle) * 170;
      peak.push(new THREE.Vector3(x, Math.max(terrain.heightAt(x, z) + 35, summit.y - 40), z));
    }
    this.#addTrail('peak', peak);

    // 7. A dive column dropping into the park.
    const parkX = (CITY_PARK.minX + CITY_PARK.maxX) / 2;
    const parkZ = (CITY_PARK.minZ + CITY_PARK.maxZ) / 2;
    const dive = [];
    for (let k = 0; k < 6; k++) dive.push(new THREE.Vector3(parkX, 700 - k * 125, parkZ));
    this.#addTrail('dive', dive);
  }

  #buildMeshes() {
    const count = this.sparks.length;
    this.core = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: CORE_COLOR }), count);
    this.ring = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.04, 6, 56), new THREE.MeshBasicMaterial({ color: RING_COLOR }), count);
    this.halo = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: HALO_COLOR } },
        vertexShader: haloVertex,
        fragmentShader: haloFragment,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      count,
    );
    for (const mesh of [this.core, this.ring, this.halo]) {
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
    }
  }

  reset() {
    for (const spark of this.sparks) {
      spark.collected = false;
      spark.pop = 0;
    }
    this.collected = 0;
    this.streak = 0;
    this.respawnAt = Infinity;
  }

  update(dt, time, heroPosition, camera) {
    const events = [];
    if (time > this.respawnAt) {
      this.reset();
      events.push({ type: 'respawn' });
    }
    const drift = this.clouds.drift;
    for (const spark of this.sparks) {
      const base = this._pos.copy(spark.base);
      if (spark.trail.drifts) base.add(drift);
      base.y += Math.sin(time * 1.3 + spark.phase) * 0.7;

      if (!spark.collected) {
        const d = base.distanceTo(heroPosition);
        const pull = smoothstep(MAGNET_RADIUS, 6, d) * 0.72;
        spark.position.copy(base).lerp(heroPosition, pull);
        if (spark.position.distanceTo(heroPosition) < PICKUP_RADIUS || d < PICKUP_RADIUS) {
          events.push(this.#collect(spark, time));
        }
      } else {
        spark.position.copy(base);
        spark.pop = Math.min(1, spark.pop + dt * 3.2);
      }
    }
    this.#writeInstances(time, camera);
    return events;
  }

  #collect(spark, time) {
    spark.collected = true;
    spark.pop = 0;
    this.collected++;
    this.streak = time - this.lastCollectTime < 3.5 ? this.streak + 1 : 0;
    this.lastCollectTime = time;
    const trailDone = spark.trail.sparks.every((s) => s.collected);
    const allDone = this.collected === this.total;
    if (allDone) this.respawnAt = time + 6;
    return {
      type: 'collect',
      position: spark.position.clone(),
      streak: this.streak,
      trailDone,
      trailName: spark.trail.name,
      trailsDone: this.trails.filter((t) => t.sparks.every((s) => s.collected)).length,
      allDone,
    };
  }

  #writeInstances(time, camera) {
    const m = this._matrix;
    const q = this._quat;
    const s = this._scale;
    for (const spark of this.sparks) {
      const i = spark.index;
      let scale = 1;
      if (spark.collected) {
        const t = spark.pop;
        scale = t < 0.25 ? 1 + t * 2.4 : Math.max(0, 1.6 * (1 - (t - 0.25) / 0.75));
      }
      const distance = spark.position.distanceTo(camera.position);
      const pulse = 1 + Math.sin(time * 3 + spark.phase) * 0.08;

      q.identity();
      m.compose(spark.position, q, s.setScalar(1.05 * scale * pulse));
      this.core.setMatrixAt(i, m);

      q.setFromAxisAngle(this._axis, time * 1.4 + spark.phase);
      m.compose(spark.position, q, s.setScalar(2.5 * scale));
      this.ring.setMatrixAt(i, m);

      q.identity();
      m.compose(spark.position, q, s.setScalar((9 + distance * 0.006) * scale * pulse));
      this.halo.setMatrixAt(i, m);
    }
    this.core.instanceMatrix.needsUpdate = true;
    this.ring.instanceMatrix.needsUpdate = true;
    this.halo.instanceMatrix.needsUpdate = true;
  }

  nearestUncollected(position) {
    let best = null;
    let bestDistance = Infinity;
    for (const spark of this.sparks) {
      if (spark.collected) continue;
      const d = spark.position.distanceToSquared(position);
      if (d < bestDistance) {
        bestDistance = d;
        best = spark;
      }
    }
    return best ? best.position : null;
  }
}
