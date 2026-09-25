import * as THREE from 'three';
import { createRandom, createNoise2D } from './seeded-noise.js';
import { applyAtmosphere, NOISE_GLSL } from './atmosphere.js';
import { CITY_ISLAND, CITY_BLOCK, CITY_PARK } from './island-terrain.js';
import { clamp, lerp } from './scalar-math.js';

// A procedural skyline: glass towers downtown falling away to stone mid-rises,
// three landmark towers with open plazas around them, all instanced. Windows are
// drawn in the shader, so every facade is one draw call.

const S = CITY_BLOCK.spacing;
const LOT = S - CITY_BLOCK.street; // buildable width of one block
const DOWNTOWN = { x: 30, z: 40 };

export const LANDMARKS = {
  spire: { i: 1, j: -1 },
  twist: { i: -2, j: 2 },
  round: { i: 2, j: 4 },
};
for (const landmark of Object.values(LANDMARKS)) {
  landmark.x = landmark.i * S;
  landmark.z = landmark.j * S;
}

const GLASS_FRAMES = ['#dcd6cc', '#aab1b9', '#8e7b67', '#ebe5d9', '#5e6670', '#c7c1b6'];
const STONE_WALLS = ['#cfc0a8', '#baa58c', '#dad0c3', '#a08169', '#90969c', '#c79c7d', '#e3d7c6'];
const STYLE = { glass: 0, stone: 1, plain: 2 };
const GLASS_TINTS = ['#1f2a36', '#18302f', '#3a2718', '#2f3136'];

// Scorch marks from impacts, shared by every facade material (ring buffer of world spheres).
export const DAMAGE_SLOTS = 16;
export const damageUniform = { value: Array.from({ length: DAMAGE_SLOTS }, () => new THREE.Vector4(0, -1e5, 0, 0)) };

// Roles decide how a piece reacts to a hit: towers topple, podiums and bases only scar,
// rooftop kit shatters outright.
const STURDY_ROLES = new Set(['podium', 'base']);

class ColliderGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.stamp = 0;
  }

  #key(ix, iz) {
    return (ix + 2048) * 4096 + (iz + 2048);
  }

  insert(collider) {
    const cs = this.cellSize;
    for (let ix = Math.floor(collider.minX / cs); ix <= Math.floor(collider.maxX / cs); ix++) {
      for (let iz = Math.floor(collider.minZ / cs); iz <= Math.floor(collider.maxZ / cs); iz++) {
        const key = this.#key(ix, iz);
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key).push(collider);
      }
    }
  }

  forEachNear(minX, minZ, maxX, maxZ, visit) {
    const cs = this.cellSize;
    const stamp = ++this.stamp;
    for (let ix = Math.floor(minX / cs); ix <= Math.floor(maxX / cs); ix++) {
      for (let iz = Math.floor(minZ / cs); iz <= Math.floor(maxZ / cs); iz++) {
        const list = this.cells.get(this.#key(ix, iz));
        if (!list) continue;
        for (const collider of list) {
          if (collider.stamp === stamp) continue;
          collider.stamp = stamp;
          visit(collider);
        }
      }
    }
  }
}

const closest = new THREE.Vector3();

function closestPointOn(collider, p, out) {
  if (collider.kind === 'box') {
    return out.set(
      clamp(p.x, collider.minX, collider.maxX),
      clamp(p.y, collider.minY, collider.maxY),
      clamp(p.z, collider.minZ, collider.maxZ),
    );
  }
  const dx = p.x - collider.x;
  const dz = p.z - collider.z;
  const radial = Math.hypot(dx, dz);
  const r = Math.min(radial, collider.radius);
  const scale = radial > 1e-6 ? r / radial : 0;
  return out.set(collider.x + dx * scale, clamp(p.y, collider.minY, collider.maxY), collider.z + dz * scale);
}

export class CitySkyline {
  constructor(terrain) {
    this.terrain = terrain;
    this.random = createRandom(2024);
    this.noise = createNoise2D(99);
    this.boxes = [];
    this.rounds = [];
    this.spires = [];
    this.beacons = [];
    this.buildings = [];
    this.colliders = [];
    this.building = null;
    this.grid = new ColliderGrid(64);
    this.tallest = [];
    this.damageCursor = 0;

    this.#generate();
    this.group = new THREE.Group();
    this.group.name = 'city';
    this.#buildMeshes();
    this.pristine = Object.fromEntries(Object.entries(this.meshes).map(([kind, mesh]) => [kind, mesh.instanceMatrix.array.slice()]));
    this.dirty = new Set();
    this._matrix = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  #beginBuilding(x, z) {
    this.building = { id: this.buildings.length, x, z, pieces: [], colliders: [] };
    this.buildings.push(this.building);
    return this.building;
  }

  // ----- generation -------------------------------------------------------

  #generate() {
    const range = Math.ceil(CITY_ISLAND.radius / S);
    for (let i = -range; i <= range; i++) {
      for (let j = -range; j <= range; j++) {
        const cx = i * S;
        const cz = j * S;
        if (!this.#blockIsBuildable(cx, cz)) continue;
        const landmark = Object.entries(LANDMARKS).find(([, l]) => l.i === i && l.j === j);
        if (landmark) {
          this.#buildLandmark(landmark[0], cx, cz);
          continue;
        }
        const nearLandmark = Object.values(LANDMARKS).some((l) => Math.max(Math.abs(l.i - i), Math.abs(l.j - j)) <= 1);
        this.#buildBlock(cx, cz, nearLandmark);
      }
    }
  }

  #blockIsBuildable(cx, cz) {
    const half = LOT / 2 + 2;
    for (const [dx, dz] of [[-half, -half], [half, -half], [-half, half], [half, half], [0, 0]]) {
      const h = this.terrain.heightAt(cx + dx, cz + dz);
      if (h < CITY_ISLAND.ground - 0.6 || h > CITY_ISLAND.ground + 0.6) return false;
    }
    const overlapsPark = cx + half > CITY_PARK.minX && cx - half < CITY_PARK.maxX && cz + half > CITY_PARK.minZ && cz - half < CITY_PARK.maxZ;
    return !overlapsPark;
  }

  #buildBlock(cx, cz, nearLandmark) {
    const random = this.random;
    const distance = Math.hypot(cx - DOWNTOWN.x, cz - DOWNTOWN.z);
    const core = Math.exp(-Math.pow(distance / 560, 2));
    const midtown = Math.exp(-Math.pow(distance / 1050, 2));
    const texture = this.noise(cx * 0.0045, cz * 0.0045) * 0.5 + 0.5;
    let maxHeight = 12 + 290 * Math.pow(core, 1.15) + 55 * midtown + 45 * texture * midtown;
    if (nearLandmark) maxHeight = Math.min(maxHeight, 42);
    if (random() < (nearLandmark ? 0.35 : 0.045)) return; // an open plaza

    const ground = CITY_ISLAND.ground;
    if (maxHeight > 150 && random() < 0.82) {
      // Downtown: a podium with a single tower.
      const podium = 9 + random() * 12;
      this.#beginBuilding(cx, cz);
      this.#addBox(cx, cz, LOT - 4, LOT - 4, ground, podium, STYLE.stone, { wall: STONE_WALLS }, { role: 'podium' });
      const footprint = 24 + random() * 16;
      const height = maxHeight * (0.72 + random() * 0.45);
      const ox = (random() - 0.5) * (LOT - footprint - 6);
      const oz = (random() - 0.5) * (LOT - footprint - 6);
      this.#beginBuilding(cx + ox, cz + oz);
      if (random() < 0.12) this.#addRoundTower(cx + ox, cz + oz, footprint * 0.5, ground + podium, height);
      else this.#addTower(cx + ox, cz + oz, footprint, footprint * (0.8 + random() * 0.4), ground + podium, height);
      return;
    }

    // Everywhere else: split the block into lots of varied height.
    const splits = random() < 0.55 ? [2, 2] : random() < 0.5 ? [2, 1] : [1, 2];
    const lotW = LOT / splits[0];
    const lotD = LOT / splits[1];
    for (let a = 0; a < splits[0]; a++) {
      for (let b = 0; b < splits[1]; b++) {
        if (random() < 0.06) continue;
        const x = cx - LOT / 2 + lotW * (a + 0.5);
        const z = cz - LOT / 2 + lotD * (b + 0.5);
        const height = Math.max(9, maxHeight * Math.pow(0.3 + random() * 0.7, 1.25));
        const w = lotW - 3 - random() * 4;
        const d = lotD - 3 - random() * 4;
        this.#beginBuilding(x, z);
        if (height > 70 && random() < 0.65) this.#addTower(x, z, w, d, ground, height);
        else {
          this.#addBox(x, z, w, d, ground, height, STYLE.stone, { wall: STONE_WALLS });
          this.#addRooftop(x, z, w, d, ground + height);
        }
      }
    }
  }

  #addTower(x, z, w, d, y0, height) {
    const random = this.random;
    const tiers = height > 180 ? 1 + Math.floor(random() * 3) : height > 90 && random() < 0.45 ? 2 : 1;
    const shares = tiers === 1 ? [1] : tiers === 2 ? [0.68, 0.32] : [0.5, 0.31, 0.19];
    const frame = GLASS_FRAMES;
    const look = { wall: frame, glass: Math.floor(random() * 4), frameIndex: Math.floor(random() * frame.length) };
    let cw = w;
    let cd = d;
    let y = y0;
    for (let t = 0; t < tiers; t++) {
      const h = height * shares[t];
      this.#addBox(x, z, cw, cd, y, h, STYLE.glass, look);
      y += h;
      cw *= 0.7 + random() * 0.12;
      cd *= 0.7 + random() * 0.12;
    }
    if (height > 110 && random() < 0.7) {
      const crown = 3 + random() * 6;
      this.#addBox(x, z, cw * 0.82, cd * 0.82, y, crown, STYLE.plain, { wall: ['#77736e'] }, { role: 'crown' });
      y += crown;
    }
    if (height > 190 && random() < 0.55) {
      const spire = 18 + random() * 40;
      this.#addSpire(x, z, y, spire, 0.8 + random() * 0.5);
      y += spire;
    }
    if (height > 160) this.#addBeacon(x, y + 0.8, z);
    this.tallest.push({ x, z, top: y });
  }

  #addRoundTower(x, z, radius, y0, height) {
    const random = this.random;
    const glass = Math.floor(random() * 4);
    this.#addCylinder(x, z, radius, y0, height, STYLE.glass, { wall: GLASS_FRAMES, glass });
    this.#addCylinder(x, z, radius * 0.78, y0 + height, 5, STYLE.plain, { wall: ['#7a7671'] }, { role: 'crown' });
    this.#addBeacon(x, y0 + height + 6, z);
    this.tallest.push({ x, z, top: y0 + height + 5 });
  }

  #addRooftop(x, z, w, d, top) {
    const random = this.random;
    if (random() < 0.55) {
      const uw = 3 + random() * Math.min(8, w * 0.35);
      const ud = 3 + random() * Math.min(8, d * 0.35);
      const ox = (random() - 0.5) * (w - uw - 2);
      const oz = (random() - 0.5) * (d - ud - 2);
      this.#addBox(x + ox, z + oz, uw, ud, top, 2 + random() * 3, STYLE.plain, { wall: ['#6f6c69', '#807a73'] }, { role: 'roof' });
    }
    if (top < 60 && random() < 0.22) {
      const ox = (random() - 0.5) * (w - 6);
      const oz = (random() - 0.5) * (d - 6);
      this.#addCylinder(x + ox, z + oz, 1.8, top + 2.5, 4, STYLE.plain, { wall: ['#6b5140'] }, { role: 'roof', collide: false });
    }
  }

  #buildLandmark(name, cx, cz) {
    const ground = CITY_ISLAND.ground;
    if (name === 'spire') {
      // A slender stepped tower with a needle — the tallest thing in the city.
      this.#beginBuilding(cx, cz);
      let y = ground;
      const tiers = 9;
      for (let t = 0; t < tiers; t++) {
        const size = lerp(46, 19, t / (tiers - 1));
        const h = lerp(68, 34, t / (tiers - 1));
        this.#addBox(cx, cz, size, size, y, h, STYLE.glass, { wall: ['#e7e1d6'], glass: 3 });
        y += h;
      }
      this.#addBox(cx, cz, 12, 12, y, 10, STYLE.plain, { wall: ['#8d8983'] }, { role: 'crown' });
      y += 10;
      this.#addSpire(cx, cz, y, 74, 1.6);
      this.#addBeacon(cx, y + 75, cz);
      this.tallest.push({ x: cx, z: cz, top: y + 74 });
      LANDMARKS.spire.top = y + 74;
    } else if (name === 'twist') {
      // Stacked slabs, each turned a little further: a tower that twists as you circle it.
      const slabs = 62;
      const slabHeight = 6.8;
      const podium = 8;
      this.#beginBuilding(cx, cz);
      this.#addBox(cx, cz, LOT - 6, LOT - 6, ground, podium, STYLE.stone, { wall: ['#d6cbbb'] }, { role: 'base' });
      this.#beginBuilding(cx, cz);
      for (let s = 0; s < slabs; s++) {
        const yaw = THREE.MathUtils.degToRad(s * 1.55);
        this.#addBox(cx, cz, 31, 31, ground + podium + s * slabHeight, slabHeight, STYLE.glass, { wall: ['#b9c0c7'], glass: 1 }, { yaw, collide: false });
      }
      const top = ground + podium + slabs * slabHeight;
      this.#addCollider({ kind: 'cyl', x: cx, z: cz, radius: 19.5, minY: ground + podium, maxY: top, role: 'tower', halfWidth: 16 });
      this.#addBeacon(cx, top + 1, cz);
      this.tallest.push({ x: cx, z: cz, top });
      LANDMARKS.twist.top = top;
    } else if (name === 'round') {
      const radius = 24;
      const height = 330;
      this.#beginBuilding(cx, cz);
      this.#addCylinder(cx, cz, radius + 6, ground, 18, STYLE.stone, { wall: ['#d9cfc0'] }, { role: 'base' });
      this.#beginBuilding(cx, cz);
      this.#addCylinder(cx, cz, radius, ground + 18, height, STYLE.glass, { wall: ['#c9b89c'], glass: 2 });
      this.#addCylinder(cx, cz, radius + 2, ground + 18 + height, 5, STYLE.plain, { wall: ['#8b7a62'] }, { role: 'crown' });
      this.#addCylinder(cx, cz, radius * 0.7, ground + 23 + height, 22, STYLE.glass, { wall: ['#c9b89c'], glass: 2 }, { role: 'crown' });
      const top = ground + 45 + height;
      this.#addSpire(cx, cz, top, 38, 1.2);
      this.#addBeacon(cx, top + 39, cz);
      this.tallest.push({ x: cx, z: cz, top: top + 38 });
      LANDMARKS.round.top = top + 38;
    }
  }

  #pickColor(list) {
    return list[Math.floor(this.random() * list.length)];
  }

  #addBox(x, z, w, d, y0, h, style, look, { yaw = 0, collide = true, role = 'tower' } = {}) {
    const random = this.random;
    const color = look.frameIndex !== undefined ? look.wall[look.frameIndex] : this.#pickColor(look.wall);
    const index = this.boxes.length;
    this.boxes.push({
      x, z, w, d, y0, h, yaw, style, role,
      color,
      glass: look.glass ?? Math.floor(random() * 4),
      seed: random(),
      lit: style === STYLE.stone ? 0.035 + random() * 0.05 : 0.015 + random() * 0.03,
      building: this.building.id,
    });
    this.building.pieces.push({ kind: 'box', index });
    if (collide) {
      this.#addCollider({
        kind: 'box', role, piece: { kind: 'box', index },
        minX: x - w / 2, maxX: x + w / 2, minY: y0, maxY: y0 + h, minZ: z - d / 2, maxZ: z + d / 2,
      });
    }
  }

  #addCylinder(x, z, radius, y0, h, style, look, { collide = true, role = 'tower' } = {}) {
    const random = this.random;
    const index = this.rounds.length;
    this.rounds.push({
      x, z, radius, y0, h, style, role,
      color: this.#pickColor(look.wall),
      glass: look.glass ?? Math.floor(random() * 4),
      seed: random(),
      lit: 0.02 + random() * 0.03,
      building: this.building.id,
    });
    this.building.pieces.push({ kind: 'round', index });
    if (collide) this.#addCollider({ kind: 'cyl', role, piece: { kind: 'round', index }, x, z, radius, minY: y0, maxY: y0 + h });
  }

  #addSpire(x, z, y, height, radius) {
    this.building.pieces.push({ kind: 'spire', index: this.spires.length });
    this.spires.push({ x, z, y, height, radius, building: this.building.id });
  }

  #addBeacon(x, y, z) {
    this.building.pieces.push({ kind: 'beacon', index: this.beacons.length });
    this.beacons.push(new THREE.Vector3(x, y, z));
  }

  #addCollider(collider) {
    if (collider.kind === 'cyl') {
      collider.minX = collider.x - collider.radius;
      collider.maxX = collider.x + collider.radius;
      collider.minZ = collider.z - collider.radius;
      collider.maxZ = collider.z + collider.radius;
    }
    collider.building = this.building.id;
    collider.sturdy = STURDY_ROLES.has(collider.role);
    collider.restMaxY = collider.maxY;
    collider.disabled = false;
    this.building.colliders.push(collider);
    this.colliders.push(collider);
    this.grid.insert(collider);
  }

  // ----- rendering --------------------------------------------------------

  #buildMeshes() {
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);

    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    boxGeometry.translate(0, 0.5, 0);
    const boxMesh = this.#createInstanced(boxGeometry, createFacadeMaterial(false), this.boxes, (item) => {
      rotation.setFromAxisAngle(up, item.yaw);
      matrix.compose(new THREE.Vector3(item.x, item.y0, item.z), rotation, new THREE.Vector3(item.w, item.h, item.d));
      return matrix;
    });
    this.group.add(boxMesh);
    this.meshes = { box: boxMesh };

    const roundGeometry = new THREE.CylinderGeometry(1, 1, 1, 48, 1);
    roundGeometry.translate(0, 0.5, 0);
    const roundMesh = this.#createInstanced(roundGeometry, createFacadeMaterial(true), this.rounds, (item) => {
      rotation.identity();
      matrix.compose(new THREE.Vector3(item.x, item.y0, item.z), rotation, new THREE.Vector3(item.radius, item.h, item.radius));
      return matrix;
    });
    this.group.add(roundMesh);
    this.meshes.round = roundMesh;

    const spireGeometry = new THREE.ConeGeometry(1, 1, 10, 1);
    spireGeometry.translate(0, 0.5, 0);
    const spireMesh = new THREE.InstancedMesh(spireGeometry, createSpireMaterial(), this.spires.length);
    this.spires.forEach((item, index) => {
      matrix.compose(new THREE.Vector3(item.x, item.y, item.z), rotation.identity(), new THREE.Vector3(item.radius, item.height, item.radius));
      spireMesh.setMatrixAt(index, matrix);
    });
    spireMesh.castShadow = true;
    this.group.add(spireMesh);
    this.meshes.spire = spireMesh;

    // Aviation beacons: tiny, bright, blinking in unison.
    this.beaconMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 0.4, 0.25) });
    const beaconMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1.1, 8, 6), this.beaconMaterial, this.beacons.length);
    this.beacons.forEach((position, index) => {
      matrix.makeTranslation(position.x, position.y, position.z);
      beaconMesh.setMatrixAt(index, matrix);
    });
    this.group.add(beaconMesh);
    this.meshes.beacon = beaconMesh;
    for (const mesh of Object.values(this.meshes)) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  #createInstanced(geometry, material, items, composeMatrix) {
    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    const facade = new Float32Array(items.length * 4);
    const base = new Float32Array(items.length);
    const color = new THREE.Color();
    items.forEach((item, index) => {
      mesh.setMatrixAt(index, composeMatrix(item));
      color.set(item.color);
      mesh.setColorAt(index, color);
      facade.set([item.style, item.seed, item.glass, item.lit], index * 4);
      base[index] = item.y0;
    });
    geometry.setAttribute('aFacade', new THREE.InstancedBufferAttribute(facade, 4));
    geometry.setAttribute('aFacadeBase', new THREE.InstancedBufferAttribute(base, 1));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    return mesh;
  }

  update(time) {
    const blink = Math.pow(0.5 + 0.5 * Math.sin(time * 2.4), 6);
    this.beaconMaterial.color.setRGB(0.6 + 9 * blink, 0.03 + 0.5 * blink, 0.02 + 0.3 * blink);
  }

  // ----- queries ----------------------------------------------------------

  // Pushes the sphere out of any building it overlaps. Returns the collider it hit
  // deepest (so callers can damage it), or null.
  collideSphere(position, radius, outNormal) {
    let deepest = null;
    let deepestPenetration = -Infinity;
    outNormal.set(0, 0, 0);
    for (let pass = 0; pass < 2; pass++) {
      this.grid.forEachNear(position.x - radius, position.z - radius, position.x + radius, position.z + radius, (collider) => {
        if (collider.disabled) return;
        if (position.y - radius > collider.maxY || position.y + radius < collider.minY) return;
        closestPointOn(collider, position, closest);
        const dx = position.x - closest.x;
        const dy = position.y - closest.y;
        const dz = position.z - closest.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq >= radius * radius) return;
        const penetration = radius - Math.sqrt(distSq);
        if (penetration > deepestPenetration) {
          deepestPenetration = penetration;
          deepest = collider;
        }
        if (distSq > 1e-8) {
          const dist = Math.sqrt(distSq);
          const push = (radius - dist) / dist;
          position.x += dx * push;
          position.y += dy * push;
          position.z += dz * push;
          outNormal.x += dx / dist;
          outNormal.y += dy / dist;
          outNormal.z += dz / dist;
        } else {
          this.#exitFromInside(collider, position, radius, outNormal);
        }
      });
    }
    if (deepest) {
      if (outNormal.lengthSq() < 1e-8) outNormal.set(0, 1, 0);
      outNormal.normalize();
    }
    return deepest;
  }

  #exitFromInside(collider, position, radius, outNormal) {
    if (collider.kind === 'cyl') {
      const dx = position.x - collider.x;
      const dz = position.z - collider.z;
      const radial = Math.hypot(dx, dz) || 1e-3;
      const toSide = collider.radius - radial;
      const toTop = collider.maxY - position.y;
      if (toTop < toSide) {
        position.y = collider.maxY + radius;
        outNormal.y += 1;
      } else {
        const scale = (collider.radius + radius) / radial;
        position.x = collider.x + dx * scale;
        position.z = collider.z + dz * scale;
        outNormal.x += dx / radial;
        outNormal.z += dz / radial;
      }
      return;
    }
    const exits = [
      [position.x - collider.minX, -1, 0, 0],
      [collider.maxX - position.x, 1, 0, 0],
      [collider.maxY - position.y, 0, 1, 0],
      [position.z - collider.minZ, 0, 0, -1],
      [collider.maxZ - position.z, 0, 0, 1],
    ];
    exits.sort((a, b) => a[0] - b[0]);
    const [depth, nx, ny, nz] = exits[0];
    position.x += nx * (depth + radius);
    position.y += ny * (depth + radius);
    position.z += nz * (depth + radius);
    outNormal.x += nx;
    outNormal.y += ny;
    outNormal.z += nz;
  }

  nearestSurface(position, maxDistance) {
    let best = Infinity;
    this.grid.forEachNear(position.x - maxDistance, position.z - maxDistance, position.x + maxDistance, position.z + maxDistance, (collider) => {
      if (collider.disabled) return;
      if (position.y - maxDistance > collider.maxY || position.y + maxDistance < collider.minY) return;
      closestPointOn(collider, position, closest);
      best = Math.min(best, closest.distanceTo(position));
    });
    return best;
  }

  // Distance along a ray to the first building, for keeping the camera out of walls.
  raycast(origin, direction, maxDistance) {
    const end = { x: origin.x + direction.x * maxDistance, z: origin.z + direction.z * maxDistance };
    let best = maxDistance;
    this.grid.forEachNear(
      Math.min(origin.x, end.x) - 1, Math.min(origin.z, end.z) - 1,
      Math.max(origin.x, end.x) + 1, Math.max(origin.z, end.z) + 1,
      (collider) => {
        if (collider.disabled) return;
        const hit = rayBox(origin, direction, collider);
        if (hit >= 0 && hit < best) best = hit;
      },
    );
    return best;
  }

  isClear(position, radius) {
    return this.nearestSurface(position, radius) >= radius;
  }

  // Highest surface under (x, z) at or below `belowY`: ground, or a rooftop to land on.
  floorAt(x, z, belowY = Infinity, ignoreBuilding = -1) {
    let floor = Math.max(this.terrain.heightAt(x, z), 0);
    this.grid.forEachNear(x, z, x, z, (collider) => {
      if (collider.disabled || collider.building === ignoreBuilding) return;
      if (collider.maxY > belowY + 0.5 || collider.maxY <= floor) return;
      const inside = collider.kind === 'box'
        ? x >= collider.minX && x <= collider.maxX && z >= collider.minZ && z <= collider.maxZ
        : Math.hypot(x - collider.x, z - collider.z) <= collider.radius;
      if (inside) floor = collider.maxY;
    });
    return floor;
  }

  // ----- damage -------------------------------------------------------------

  pieceSpan({ kind, index }) {
    if (kind === 'box') return { bottom: this.boxes[index].y0, top: this.boxes[index].y0 + this.boxes[index].h };
    if (kind === 'round') return { bottom: this.rounds[index].y0, top: this.rounds[index].y0 + this.rounds[index].h };
    if (kind === 'spire') return { bottom: this.spires[index].y, top: this.spires[index].y + this.spires[index].height };
    return { bottom: this.beacons[index].y, top: this.beacons[index].y };
  }

  pieceData({ kind, index }) {
    if (kind === 'box') return this.boxes[index];
    if (kind === 'round') return this.rounds[index];
    if (kind === 'spire') return this.spires[index];
    return null;
  }

  // World matrix of a piece clipped to [bottom, top] (the whole piece by default).
  pieceMatrix(ref, out, bottom, top) {
    const data = this.pieceData(ref);
    const span = this.pieceSpan(ref);
    const y0 = bottom ?? span.bottom;
    const y1 = top ?? span.top;
    if (ref.kind === 'box') {
      this._quat.setFromAxisAngle(this._up, data.yaw);
      return out.compose(new THREE.Vector3(data.x, y0, data.z), this._quat, new THREE.Vector3(data.w, y1 - y0, data.d));
    }
    this._quat.identity();
    if (ref.kind === 'round') return out.compose(new THREE.Vector3(data.x, y0, data.z), this._quat, new THREE.Vector3(data.radius, y1 - y0, data.radius));
    return out.compose(new THREE.Vector3(data.x, data.y, data.z), this._quat, new THREE.Vector3(data.radius, data.height, data.radius));
  }

  // Shorten a piece so it ends at `top` (the stump left behind by a break).
  setPieceTop(ref, top) {
    const mesh = this.meshes[ref.kind];
    mesh.setMatrixAt(ref.index, this.pieceMatrix(ref, this._matrix, undefined, top));
    this.dirty.add(ref.kind);
  }

  hidePiece(ref) {
    this.meshes[ref.kind].setMatrixAt(ref.index, this._matrix.makeScale(0, 0, 0));
    this.dirty.add(ref.kind);
  }

  // A building gives way at `height`: colliders above vanish, the one it cuts gets shorter.
  cutBuilding(buildingId, height) {
    for (const collider of this.buildings[buildingId].colliders) {
      if (collider.minY >= height - 0.01) collider.disabled = true;
      else if (collider.maxY > height) collider.maxY = height;
    }
  }

  removeCollider(collider) {
    collider.disabled = true;
  }

  addDamage(center, radius) {
    damageUniform.value[this.damageCursor].set(center.x, center.y, center.z, radius);
    this.damageCursor = (this.damageCursor + 1) % DAMAGE_SLOTS;
  }

  // Colour to paint debris from a collider's building.
  lookOf(collider) {
    const data = collider.piece ? this.pieceData(collider.piece) : this.boxes.find((b) => b.building === collider.building);
    const wall = new THREE.Color(data?.color ?? '#9a948c');
    const glassy = data?.style === STYLE.glass;
    return { wall, glass: new THREE.Color(GLASS_TINTS[data?.glass ?? 0]), glassy };
  }

  // Push pending instance edits to the GPU; call once per frame.
  flushChanges() {
    for (const kind of this.dirty) this.meshes[kind].instanceMatrix.needsUpdate = true;
    this.dirty.clear();
  }

  restore() {
    for (const [kind, matrices] of Object.entries(this.pristine)) {
      this.meshes[kind].instanceMatrix.array.set(matrices);
      this.meshes[kind].instanceMatrix.needsUpdate = true;
    }
    for (const collider of this.colliders) {
      collider.disabled = false;
      collider.maxY = collider.restMaxY;
    }
    for (const slot of damageUniform.value) slot.set(0, -1e5, 0, 0);
    this.damageCursor = 0;
    this.dirty.clear();
  }
}

function rayBox(origin, direction, c) {
  let tMin = 0;
  let tMax = Infinity;
  const axes = [
    [origin.x, direction.x, c.minX, c.maxX],
    [origin.y, direction.y, c.minY, c.maxY],
    [origin.z, direction.z, c.minZ, c.maxZ],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return -1;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return -1;
  }
  return tMin;
}

export function createSpireMaterial() {
  return applyAtmosphere(new THREE.MeshStandardMaterial({ color: '#d9d2c6', metalness: 0.9, roughness: 0.28 }), { key: 'spire' });
}

// Facade material for instanced towers. `falling` pieces crumble away (dissolve) and
// show a dark gutted interior through the gaps.
export function createFacadeMaterial(round, { falling = false } = {}) {
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.8,
    metalness: 0,
    envMapIntensity: 1,
    side: falling ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (falling) material.defines = { FACADE_FALLING: '' };
  const key = `facade-${round ? 'round' : 'box'}${falling ? '-falling' : ''}`;
  return applyAtmosphere(material, { key, patch: (shader) => patchFacade(shader, round) });
}

function patchFacade(shader, round) {
  shader.uniforms.uDamage = damageUniform;
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
      attribute vec4 aFacade;
      attribute float aFacadeBase;
      flat varying vec4 vFacade;
      varying vec3 vFacadeLocal;
      varying vec3 vFacadeNormal;
      varying vec2 vFacadeSpan;
      varying float vFacadeBase;
      #ifdef FACADE_FALLING
        attribute float aCrumble;
        flat varying float vCrumble;
      #endif`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vec3 facadeScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
      vFacadeLocal = position * facadeScale;
      vFacadeNormal = normal;
      vFacade = aFacade;
      vFacadeBase = aFacadeBase;
      vFacadeSpan = abs(normal.x) > 0.5
        ? vec2((position.z + 0.5) * facadeScale.z, facadeScale.z)
        : vec2((position.x + 0.5) * facadeScale.x, facadeScale.x);
      #ifdef FACADE_FALLING
        vCrumble = aCrumble;
      #endif`,
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      ${NOISE_GLSL}
      uniform vec4 uDamage[${DAMAGE_SLOTS}];
      flat varying vec4 vFacade;
      varying vec3 vFacadeLocal;
      varying vec3 vFacadeNormal;
      varying vec2 vFacadeSpan;
      varying float vFacadeBase;
      #ifdef FACADE_FALLING
        flat varying float vCrumble;
      #endif`,
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      #ifdef FACADE_FALLING
        float crumbleNoise = valueNoise(vFacadeLocal.xz * 0.3 + vFacadeLocal.y * 0.09) * 0.6 + valueNoise(vFacadeLocal.zy * 0.8 + 3.1) * 0.4;
        float crumbleFront = vCrumble * 1.35 - 0.2;
        if (crumbleNoise < crumbleFront) discard;
        // Cut the section away around the camera so bursting through never blacks out the view.
        if (distance(vAerialWorld, cameraPosition) < 15.0 + (crumbleNoise - 0.5) * 6.0) discard;
        float charredEdge = 1.0 - smoothstep(crumbleFront, crumbleFront + 0.07, crumbleNoise);
      #endif
      float glassStyle = 1.0 - step(0.5, vFacade.x);
      float plainStyle = step(1.5, vFacade.x);
      vec3 facadeN = normalize(vFacadeNormal);
      float wall = 1.0 - step(0.5, abs(facadeN.y));
      float cellWidth = mix(2.9, 1.6, glassStyle);
      ${round
        ? `float facadeRadius = max(length(vFacadeLocal.xz), 0.001);
           float columns = max(floor(6.2831853 * facadeRadius / cellWidth), 8.0);
           float cellU = (atan(vFacadeLocal.z, vFacadeLocal.x) / 6.2831853 + 0.5) * columns;`
        : `float columns = max(floor(vFacadeSpan.y / cellWidth), 1.0);
           float cellU = vFacadeSpan.x / vFacadeSpan.y * columns;`}
      float facadeHeight = vFacadeLocal.y + vFacadeBase;
      float cellV = facadeHeight / mix(3.7, 3.45, glassStyle);
      vec2 cell = vec2(cellU, cellV);
      vec2 cellId = floor(cell);
      vec2 cellF = fract(cell);
      vec2 cellFw = fwidth(cell);
      vec2 paneLo = mix(vec2(0.2, 0.25), vec2(0.07, 0.12), glassStyle);
      vec2 paneHi = mix(vec2(0.8, 0.8), vec2(0.93, 0.95), glassStyle);
      vec2 inLo = smoothstep(paneLo - cellFw, paneLo + cellFw, cellF);
      vec2 inHi = 1.0 - smoothstep(paneHi - cellFw, paneHi + cellFw, cellF);
      float pane = inLo.x * inLo.y * inHi.x * inHi.y;
      float paneAverage = (paneHi.x - paneLo.x) * (paneHi.y - paneLo.y);
      float farBlend = smoothstep(0.3, 0.85, max(cellFw.x, cellFw.y));
      pane = mix(pane, paneAverage, farBlend) * wall * (1.0 - plainStyle);

      // Scorch and blown-out windows around impacts.
      float scorch = 0.0;
      #ifndef FACADE_FALLING
        for (int i = 0; i < ${DAMAGE_SLOTS}; i++) {
          vec4 damage = uDamage[i];
          if (damage.w <= 0.0) continue;
          float reach = length(vAerialWorld - damage.xyz) / damage.w;
          if (reach > 1.4) continue;
          float jag = valueNoise(vAerialWorld.xz * 0.23 + vAerialWorld.y * 0.19 + float(i) * 7.3);
          scorch = max(scorch, 1.0 - smoothstep(0.4, 1.05, reach + (jag - 0.5) * 0.6));
        }
      #endif
      pane *= 1.0 - smoothstep(0.15, 0.55, scorch);

      float windowLit = step(hash12(cellId + floor(vFacade.y * 997.0)), vFacade.w) * pane * (1.0 - farBlend * 0.8);
      vec3 glassTint = vFacade.z < 0.5 ? vec3(0.1, 0.15, 0.22)
        : vFacade.z < 1.5 ? vec3(0.07, 0.15, 0.16)
        : vFacade.z < 2.5 ? vec3(0.21, 0.13, 0.08)
        : vec3(0.17, 0.18, 0.2);
      diffuseColor.rgb = mix(diffuseColor.rgb, glassTint, pane);

      // Weathering: rain streaks down the walls, soot at street level, patchy roofs.
      float streaks = valueNoise(vec2(cellU * 0.45 + vFacade.y * 31.0, facadeHeight * 0.035));
      float grime = wall * smoothstep(0.45, 0.95, streaks) * 0.16 * (1.0 - farBlend * 0.5);
      grime += (1.0 - wall) * valueNoise(vFacadeLocal.xz * 0.12 + vFacade.y * 9.0) * 0.18;
      diffuseColor.rgb *= 1.0 - grime;
      diffuseColor.rgb *= mix(0.48, 1.0, smoothstep(4.0, 48.0, vAerialWorld.y));
      diffuseColor.rgb *= mix(0.72, 1.0, wall);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045, 0.04, 0.036), scorch * 0.9);
      #ifdef FACADE_FALLING
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.04, 0.035, 0.03), charredEdge);
        if (!gl_FrontFacing) {
          diffuseColor.rgb = vec3(0.03, 0.028, 0.026);
          pane = 0.0;
          windowLit = 0.0;
        }
      #endif`,
    )
    .replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, 0.1, pane);`,
    )
    .replace(
      '#include <metalnessmap_fragment>',
      `#include <metalnessmap_fragment>
      metalnessFactor = mix(metalnessFactor, mix(0.55, 0.88, glassStyle), pane);`,
    )
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      totalEmissiveRadiance += vec3(1.0, 0.62, 0.32) * windowLit * 0.9;`,
    );
}
