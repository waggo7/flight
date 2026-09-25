import * as THREE from 'three';
import { DESTRUCTION } from './flight-tuning.js';
import { createFacadeMaterial, createSpireMaterial } from './city-skyline.js';
import { ParticlePool } from './particle-pool.js';
import { DebrisField } from './debris-field.js';
import { clamp } from './scalar-math.js';

// What happens when a hero hits a building too hard. A glancing or slow hit scars the
// facade and sheds debris; a hard hit makes the tower give way at the impact height:
// the section above tips over in the direction of travel, slides off its stump,
// crumbles as it falls and lands in a burst of rubble and dust. Never a game over.

const GRAVITY = 9.81;
const UP = new THREE.Vector3(0, 1, 0);
const CONCRETE = new THREE.Color('#948c82');
const SOOT = new THREE.Color('#403a35');
const FALLING_CAPACITY = { box: 200, round: 24, spire: 24 };

// Pure: which pieces stay, which get shortened to a stump, and which fall, when a
// building gives way at `height`. Pieces are { ref, bottom, top }.
export function planSplit(pieces, height) {
  const plan = { keep: [], shorten: [], fall: [] };
  for (const piece of pieces) {
    if (piece.top <= height + 0.01) plan.keep.push(piece);
    else if (piece.bottom >= height - 0.01) plan.fall.push({ ...piece });
    else {
      plan.shorten.push({ ...piece, top: height });
      plan.fall.push({ ...piece, bottom: height });
    }
  }
  return plan;
}

export class CityDestruction {
  constructor({ city, dust }) {
    this.city = city;
    this.dust = dust;
    this.enabled = true;
    this.groups = [];
    this.events = [];
    this.lastHit = new Map();
    this.time = 0;
    this.toppled = 0;
    this.group = new THREE.Group();
    this.group.name = 'destruction';
    this.debris = new DebrisField({ capacity: DESTRUCTION.debrisCapacity, floorAt: (x, z, y) => city.floorAt(x, z, y) });
    this.glass = new ParticlePool({ capacity: 700, color: '#fff2df', additive: true, gravity: GRAVITY, drag: 0.3, maxSize: 36 });
    this.group.add(this.debris.mesh, this.glass.points);
    this.#buildFallingMeshes();

    this._matrix = new THREE.Matrix4();
    this._point = new THREE.Vector3();
    this._velocity = new THREE.Vector3();
    this._lever = new THREE.Vector3();
    this._step = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
    this._color = new THREE.Color();
  }

  #buildFallingMeshes() {
    const make = (geometry, material, capacity, facade) => {
      if (facade) {
        geometry.setAttribute('aFacade', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('aFacadeBase', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('aCrumble', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage));
      }
      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (facade) mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const round = new THREE.CylinderGeometry(1, 1, 1, 40, 1);
    round.translate(0, 0.5, 0);
    const cone = new THREE.ConeGeometry(1, 1, 10, 1);
    cone.translate(0, 0.5, 0);
    this.falling = {
      box: make(box, createFacadeMaterial(false, { falling: true }), FALLING_CAPACITY.box, true),
      round: make(round, createFacadeMaterial(true, { falling: true }), FALLING_CAPACITY.round, true),
      spire: make(cone, createSpireMaterial(), FALLING_CAPACITY.spire, false),
    };
  }

  takeEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  // Called by the flight model when the hero hits a building. Returns what gave way.
  smash(collider, point, normal, velocity, impact) {
    if (!this.enabled || !collider || collider.disabled || impact < DESTRUCTION.dentSpeed) return null;
    const last = this.lastHit.get(collider.building) ?? -Infinity;
    if (this.time - last < 0.25) return null;
    this.lastHit.set(collider.building, this.time);

    const strength = clamp((impact - DESTRUCTION.dentSpeed) / (DESTRUCTION.breakSpeed * 1.5), 0.08, 1);
    const look = this.city.lookOf(collider);
    const sideHit = Math.abs(normal.y) < 0.6;
    const breaking = collider.role === 'roof' || (!collider.sturdy && sideHit && impact >= DESTRUCTION.breakSpeed);
    this.#scar(point, normal, velocity, strength, look, breaking);

    if (collider.role === 'roof') {
      this.#shatter(collider, velocity, look);
      return { brokeThrough: true, strength, kind: 'shatter' };
    }
    if (collider.sturdy || !sideHit || impact < DESTRUCTION.breakSpeed) return { brokeThrough: false, strength, kind: 'dent' };
    if (!this.#topple(collider, point, normal, velocity, impact, look)) return { brokeThrough: false, strength, kind: 'dent' };
    return { brokeThrough: true, strength: Math.max(strength, 0.65), kind: 'topple' };
  }

  #chunkColor(look) {
    const roll = Math.random();
    const base = roll < 0.3 && look.glassy ? look.glass : roll < 0.65 ? look.wall : CONCRETE;
    return this._color.copy(base).lerp(SOOT, Math.random() * 0.35);
  }

  // Scorch mark, a spray of chunks and glass, and a puff of dust at the point of impact.
  // When the hero breaks through, the spray follows them out the far side; a dent
  // kicks it back off the wall.
  #scar(point, normal, velocity, strength, look, breaking) {
    this.city.addDamage(this._point.copy(point).addScaledVector(normal, -1.2), 3.5 + strength * 9);
    const heading = this._axis.copy(velocity).normalize();
    const chunks = Math.round(6 + strength * 26);
    for (let i = 0; i < chunks; i++) {
      const v = this._velocity;
      if (breaking) {
        v.copy(velocity).multiplyScalar(0.25 + Math.random() * 0.45);
        v.x += (Math.random() - 0.5) * 12;
        v.y += Math.random() * 7;
        v.z += (Math.random() - 0.5) * 12;
      } else {
        v.copy(normal).multiplyScalar(2 + Math.random() * 7 * strength).addScaledVector(velocity, 0.08);
        v.x += (Math.random() - 0.5) * 5;
        v.y += Math.random() * 4;
        v.z += (Math.random() - 0.5) * 5;
      }
      const ahead = breaking ? 3 + Math.random() * 4 : 0;
      this.debris.spawn(
        point.x + heading.x * ahead + (Math.random() - 0.5) * 3,
        point.y + (Math.random() - 0.5) * 3,
        point.z + heading.z * ahead + (Math.random() - 0.5) * 3,
        v.x, v.y, v.z,
        0.3 + Math.random() * (0.5 + strength * 1.1),
        this.#chunkColor(look),
      );
    }
    const glints = Math.round((look.glassy ? 45 : 14) + strength * 60);
    for (let i = 0; i < glints; i++) {
      const v = breaking
        ? this._velocity.copy(velocity).multiplyScalar(0.2 + Math.random() * 0.4)
        : this._velocity.copy(normal).multiplyScalar(2 + Math.random() * 10);
      this.glass.spawn(
        point.x, point.y, point.z,
        v.x + (Math.random() - 0.5) * 10, v.y + Math.random() * 6, v.z + (Math.random() - 0.5) * 10,
        1.2 + Math.random() * 1.4, 0.3 + Math.random() * 0.45,
      );
    }
    const puffs = Math.round(2 + strength * 5);
    for (let i = 0; i < puffs; i++) {
      this.dust.puff(point.x + normal.x * 2 + (Math.random() - 0.5) * 4, point.y + (Math.random() - 0.5) * 3, point.z + normal.z * 2 + (Math.random() - 0.5) * 4, {
        size: 5 + strength * 9, growth: 2.4, life: 5 + strength * 4, rise: 1, alpha: 0.5,
        vx: normal.x * 3 + velocity.x * 0.04, vz: normal.z * 3 + velocity.z * 0.04, darkness: 0.1 + Math.random() * 0.25,
      });
    }
  }

  // Small rooftop kit simply bursts apart.
  #shatter(collider, velocity, look) {
    const data = this.city.pieceData(collider.piece);
    this.city.hidePiece(collider.piece);
    this.city.removeCollider(collider);
    const count = Math.round(clamp(data.w * data.h * data.d * 0.12, 8, 28));
    for (let i = 0; i < count; i++) {
      this.debris.spawn(
        data.x + (Math.random() - 0.5) * data.w,
        data.y0 + Math.random() * data.h,
        data.z + (Math.random() - 0.5) * data.d,
        velocity.x * 0.3 + (Math.random() - 0.5) * 8, 2 + Math.random() * 6, velocity.z * 0.3 + (Math.random() - 0.5) * 8,
        0.4 + Math.random() * 0.9, this.#chunkColor(look),
      );
    }
  }

  #topple(collider, point, normal, velocity, impact, look) {
    const city = this.city;
    const building = city.buildings[collider.building];
    const splitHeight = Math.max(collider.minY + 1.5, point.y - DESTRUCTION.stumpClearance);
    const pieces = building.pieces.map((ref) => ({ ref, ...city.pieceSpan(ref) }));
    const plan = planSplit(pieces, splitHeight);
    const solids = plan.fall.filter((piece) => piece.ref.kind === 'box' || piece.ref.kind === 'round');
    if (!solids.length) return false;
    const height = Math.max(...plan.fall.map((piece) => piece.top)) - splitHeight;
    if (height < 4) return false;
    this.#makeRoom(plan.fall);

    for (const piece of plan.shorten) city.setPieceTop(piece.ref, splitHeight);
    for (const piece of plan.fall) {
      if (!plan.shorten.some((stump) => stump.ref === piece.ref)) city.hidePiece(piece.ref);
    }
    city.cutBuilding(building.id, splitHeight);

    // The section's resting bounds, pivot edge and tipping axis.
    const bounds = new THREE.Box3();
    for (const piece of solids) {
      const data = city.pieceData(piece.ref);
      const rotated = piece.ref.kind === 'box' && data.yaw !== 0;
      const halfX = piece.ref.kind === 'round' ? data.radius : rotated ? Math.hypot(data.w, data.d) / 2 : data.w / 2;
      const halfZ = piece.ref.kind === 'round' ? data.radius : rotated ? Math.hypot(data.w, data.d) / 2 : data.d / 2;
      bounds.expandByPoint(new THREE.Vector3(data.x - halfX, piece.bottom, data.z - halfZ));
      bounds.expandByPoint(new THREE.Vector3(data.x + halfX, piece.top, data.z + halfZ));
    }
    const restCenter = bounds.getCenter(new THREE.Vector3());
    const push = new THREE.Vector3(velocity.x, 0, velocity.z);
    if (push.lengthSq() < 1) push.set(-normal.x, 0, -normal.z);
    push.normalize();
    const cut = solids.reduce((low, piece) => (piece.bottom < low.bottom ? piece : low));
    const cutData = city.pieceData(cut.ref);
    const halfWidth = collider.halfWidth
      ?? (cut.ref.kind === 'round' ? cutData.radius : Math.abs(push.x) * cutData.w * 0.5 + Math.abs(push.z) * cutData.d * 0.5);
    const pivot = new THREE.Vector3(cutData.x + push.x * halfWidth, splitHeight, cutData.z + push.z * halfWidth);
    const axis = new THREE.Vector3().crossVectors(UP, push).normalize();

    const corners = [];
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) corners.push(new THREE.Vector3(x, y, z));
      }
    }
    const group = {
      pieces: plan.fall
        .filter((piece) => piece.ref.kind !== 'beacon')
        .map((piece) => {
          const data = city.pieceData(piece.ref);
          return {
            kind: piece.ref.kind,
            data,
            bottom: piece.bottom,
            color: new THREE.Color(data.color ?? '#d9d2c6'),
            rest: city.pieceMatrix(piece.ref, new THREE.Matrix4(), piece.bottom, piece.top),
          };
        }),
      pivot,
      axis,
      theta: 0,
      omega: clamp((impact / height) * DESTRUCTION.toppleKick, 0.08, 1.1),
      phase: 'topple',
      restCenter,
      restBox: bounds,
      corners,
      com: restCenter.clone(),
      quaternion: new THREE.Quaternion(),
      velocity: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      transform: new THREE.Matrix4(),
      building: building.id,
      height,
      width: halfWidth * 2,
      crumble: 0,
      crumbleRate: 1 / clamp(2.5 + height / 60, 2.5, 7.5),
      age: 0,
      emitDebris: 0,
      emitDust: 0,
      emitGlass: 0,
      look,
    };
    this.groups.push(group);

    // A scorched, ragged stump with rubble on top.
    city.addDamage(new THREE.Vector3(cutData.x, splitHeight, cutData.z), halfWidth * 1.5 + 4);
    for (let i = 0; i < 10; i++) {
      this.debris.spawn(
        cutData.x + (Math.random() - 0.5) * halfWidth * 1.6, splitHeight + 2 + Math.random() * 3, cutData.z + (Math.random() - 0.5) * halfWidth * 1.6,
        (Math.random() - 0.5) * 3, 1 + Math.random() * 3, (Math.random() - 0.5) * 3,
        0.8 + Math.random() * 1.6, this.#chunkColor(look),
      );
    }
    this.toppled++;
    this.events.push({ type: 'collapse', position: restCenter.clone(), height, first: this.toppled === 1 });
    return true;
  }

  // Keep within the falling-piece budget by finishing the oldest sections early.
  #makeRoom(incoming) {
    const needed = { box: 0, round: 0, spire: 0 };
    for (const piece of incoming) if (piece.ref.kind in needed) needed[piece.ref.kind]++;
    const used = () => {
      const counts = { box: 0, round: 0, spire: 0 };
      for (const group of this.groups) for (const piece of group.pieces) counts[piece.kind]++;
      return counts;
    };
    while (this.groups.length) {
      const counts = used();
      const overBudget = Object.keys(needed).some((kind) => counts[kind] + needed[kind] > FALLING_CAPACITY[kind]);
      if (!overBudget && this.groups.length < DESTRUCTION.maxFalling) break;
      this.#finish(this.groups[0], this.groups[0].com, false);
    }
  }

  #updateTransform(group) {
    group.transform.makeRotationFromQuaternion(group.quaternion);
    const offset = this._point.copy(group.restCenter).applyQuaternion(group.quaternion).negate().add(group.com);
    group.transform.setPosition(offset);
  }

  #pointVelocity(group, point, out) {
    if (group.phase === 'topple') {
      return out.copy(group.axis).multiplyScalar(group.omega).cross(this._lever.subVectors(point, group.pivot));
    }
    return out.copy(group.spin).cross(this._lever.subVectors(point, group.com)).add(group.velocity);
  }

  #randomPointIn(group, out) {
    const box = group.restBox;
    out.set(
      box.min.x + Math.random() * (box.max.x - box.min.x),
      box.min.y + Math.random() * (box.max.y - box.min.y),
      box.min.z + Math.random() * (box.max.z - box.min.z),
    );
    return out.applyMatrix4(group.transform);
  }

  #stepGroup(group, dt) {
    group.age += dt;
    if (group.phase === 'topple') {
      // A rod tipping about its base edge: slow at first, then accelerating. Tall
      // sections use a capped height so they go over at a watchable pace.
      const alpha = ((3 * GRAVITY) / (2 * clamp(group.height, 8, 110))) * Math.sin(group.theta + 0.15);
      group.omega += alpha * dt;
      group.theta += group.omega * dt;
      group.quaternion.setFromAxisAngle(group.axis, group.theta);
      group.com.copy(group.restCenter).sub(group.pivot).applyQuaternion(group.quaternion).add(group.pivot);
      if (group.theta > DESTRUCTION.releaseAngle || group.age > 4) {
        group.phase = 'fall';
        group.spin.copy(group.axis).multiplyScalar(group.omega);
        group.velocity.copy(group.spin).cross(this._lever.subVectors(group.com, group.pivot));
      }
    } else {
      group.velocity.y -= GRAVITY * dt;
      group.com.addScaledVector(group.velocity, dt);
      const rate = group.spin.length();
      if (rate > 1e-5) {
        this._step.setFromAxisAngle(this._axis.copy(group.spin).divideScalar(rate), rate * dt);
        group.quaternion.premultiply(this._step);
      }
    }
    this.#updateTransform(group);
    group.crumble = Math.min(1, group.crumble + dt * group.crumbleRate);

    // The section sheds chunks, glass and dust as it breaks up.
    const scale = clamp(group.width / 14, 0.7, 1.7);
    group.emitDebris += dt * clamp(group.height * group.width * 0.01, 10, 48);
    while (group.emitDebris >= 1) {
      group.emitDebris -= 1;
      const p = this.#randomPointIn(group, this._point);
      const v = this.#pointVelocity(group, p, this._velocity);
      this.debris.spawn(
        p.x, p.y, p.z,
        v.x + (Math.random() - 0.5) * 7, v.y + (Math.random() - 0.5) * 4, v.z + (Math.random() - 0.5) * 7,
        (0.7 + Math.random() * 2) * scale, this.#chunkColor(group.look),
      );
    }
    group.emitGlass += dt * (group.look.glassy ? 50 : 14);
    while (group.emitGlass >= 1) {
      group.emitGlass -= 1;
      const p = this.#randomPointIn(group, this._point);
      const v = this.#pointVelocity(group, p, this._velocity);
      this.glass.spawn(p.x, p.y, p.z, v.x + (Math.random() - 0.5) * 10, v.y + Math.random() * 4, v.z + (Math.random() - 0.5) * 10, 1.4 + Math.random() * 1.6, 0.3 + Math.random() * 0.5);
    }
    group.emitDust += dt * clamp(group.height * 0.05, 3, 10);
    while (group.emitDust >= 1) {
      group.emitDust -= 1;
      const p = this.#randomPointIn(group, this._point);
      this.dust.puff(p.x, p.y, p.z, { size: 10 + Math.random() * 12 * scale, growth: 2.2, life: 7 + Math.random() * 4, rise: 0.6, alpha: 0.5, darkness: Math.random() * 0.3 });
    }

    // Landing: the lowest corner meets the ground or a rooftop.
    let lowest = Infinity;
    let lowestPoint = null;
    for (const corner of group.corners) {
      const world = this._lever.copy(corner).applyMatrix4(group.transform);
      if (world.y < lowest) {
        lowest = world.y;
        lowestPoint = world.clone();
      }
    }
    const floor = this.city.floorAt(lowestPoint.x, lowestPoint.z, lowestPoint.y + 2, group.building);
    if (group.phase === 'fall' && lowest <= floor + 0.5) this.#finish(group, lowestPoint, true);
    else if (group.crumble >= 1 || group.age > 9) this.#finish(group, group.com, false);
  }

  // The section is gone: a final burst of rubble and a spreading dust cloud.
  #finish(group, at, landed) {
    const index = this.groups.indexOf(group);
    if (index < 0) return;
    this.groups.splice(index, 1);
    const ground = this.city.floorAt(at.x, at.z, at.y + 2, group.building);
    const spread = group.width * 0.6;
    const chunks = Math.round(clamp(group.height * 0.7, 24, 110));
    for (let i = 0; i < chunks; i++) {
      const angle = Math.random() * Math.PI * 2;
      const out = 3 + Math.random() * 10;
      this.debris.spawn(
        at.x + Math.cos(angle) * Math.random() * spread, at.y + Math.random() * 4, at.z + Math.sin(angle) * Math.random() * spread,
        Math.cos(angle) * out + group.velocity.x * 0.2, 2 + Math.random() * 9, Math.sin(angle) * out + group.velocity.z * 0.2,
        (0.8 + Math.random() * 2.4) * clamp(group.width / 14, 0.7, 1.6), this.#chunkColor(group.look),
      );
    }
    const puffs = Math.round(clamp(group.height * 0.12, 8, 26));
    for (let i = 0; i < puffs; i++) {
      const angle = Math.random() * Math.PI * 2;
      const out = 4 + Math.random() * 8;
      const y = landed ? ground + 3 + Math.random() * 6 : at.y + (Math.random() - 0.5) * 10;
      this.dust.puff(at.x + Math.cos(angle) * spread * 0.5, y, at.z + Math.sin(angle) * spread * 0.5, {
        size: 14 + Math.random() * 20, growth: 2.4, life: 9 + Math.random() * 5, rise: 1.4, alpha: 0.6,
        vx: Math.cos(angle) * out, vz: Math.sin(angle) * out, darkness: Math.random() * 0.35,
      });
    }
    for (let i = 0; i < 80; i++) {
      this.glass.spawn(at.x, at.y + 2, at.z, (Math.random() - 0.5) * 20, 3 + Math.random() * 10, (Math.random() - 0.5) * 20, 1.2 + Math.random() * 1.5, 0.3 + Math.random() * 0.5);
    }
    this.events.push({ type: 'collapse-impact', position: at.clone(), height: group.height, landed });
  }

  #writeFalling() {
    const counts = { box: 0, round: 0, spire: 0 };
    for (const group of this.groups) {
      for (const piece of group.pieces) {
        const mesh = this.falling[piece.kind];
        const i = counts[piece.kind];
        if (i >= FALLING_CAPACITY[piece.kind]) continue;
        counts[piece.kind]++;
        mesh.setMatrixAt(i, this._matrix.multiplyMatrices(group.transform, piece.rest));
        if (piece.kind === 'spire') continue;
        const data = piece.data;
        mesh.setColorAt(i, piece.color);
        mesh.geometry.attributes.aFacade.array.set([data.style, data.seed, data.glass, data.lit], i * 4);
        mesh.geometry.attributes.aFacadeBase.array[i] = piece.bottom;
        mesh.geometry.attributes.aCrumble.array[i] = Math.pow(group.crumble, 2.2);
      }
    }
    for (const [kind, mesh] of Object.entries(this.falling)) {
      mesh.count = counts[kind];
      if (!counts[kind]) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (kind === 'spire') continue;
      mesh.instanceColor.needsUpdate = true;
      mesh.geometry.attributes.aFacade.needsUpdate = true;
      mesh.geometry.attributes.aFacadeBase.needsUpdate = true;
      mesh.geometry.attributes.aCrumble.needsUpdate = true;
    }
  }

  update(dt, time, projectionScale) {
    this.time = time;
    if (dt > 0) for (const group of [...this.groups]) this.#stepGroup(group, dt);
    this.#writeFalling();
    this.debris.update(dt);
    this.glass.update(dt, projectionScale);
    this.city.flushChanges();
  }

  reset() {
    this.groups.length = 0;
    this.#writeFalling();
    this.debris.clear();
    this.glass.clear();
    this.lastHit.clear();
    this.toppled = 0;
    this.events.length = 0;
    this.city.restore();
  }
}
