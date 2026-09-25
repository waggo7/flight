import type { CityBlueprint, ColliderSpec } from '../core/city-blueprint';
import type { IslandHeights } from '../core/island-terrain-height';
import { Vector3 } from '../core/math';
import type { GameWorld } from './world-contracts';

// Temporary collision world for M1: v1's XZ hash grid over the blueprint's colliders, with v1's
// push-out, nearest-surface, ray and floor queries. M2 replaces it with Rapier behind the same
// GameWorld contract, so nothing else changes when it goes.

export interface CityCollider extends ColliderSpec {
  readonly index: number;
  disabled: boolean;
  /** Current top (lowered when a building is cut); restMaxY is the pristine one. */
  maxY: number;
  readonly restMaxY: number;
  stamp: number;
}

const CELL = 64;
const cellKey = (ix: number, iz: number): number => (ix + 2048) * 4096 + (iz + 2048);

function closestPointOn(collider: CityCollider, p: Vector3, out: Vector3): Vector3 {
  if (collider.kind === 'box') {
    return out.set(
      Math.min(Math.max(p.x, collider.minX), collider.maxX),
      Math.min(Math.max(p.y, collider.minY), collider.maxY),
      Math.min(Math.max(p.z, collider.minZ), collider.maxZ),
    );
  }
  const dx = p.x - collider.x;
  const dz = p.z - collider.z;
  const radial = Math.hypot(dx, dz);
  const r = Math.min(radial, collider.radius);
  const scale = radial > 1e-6 ? r / radial : 0;
  return out.set(collider.x + dx * scale, Math.min(Math.max(p.y, collider.minY), collider.maxY), collider.z + dz * scale);
}

function rayBox(origin: Vector3, direction: Vector3, c: CityCollider): number {
  let tMin = 0;
  let tMax = Infinity;
  const axes: [number, number, number, number][] = [
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

const closest = new Vector3();

export class CityCollisionGrid implements GameWorld<CityCollider> {
  readonly colliders: CityCollider[];
  private readonly cells = new Map<number, CityCollider[]>();
  private stamp = 0;

  constructor(
    blueprint: CityBlueprint,
    private readonly heights: IslandHeights,
  ) {
    this.colliders = blueprint.colliders.map((spec, index) => ({ ...spec, index, disabled: false, restMaxY: spec.maxY, stamp: 0 }));
    for (const collider of this.colliders) {
      for (let ix = Math.floor(collider.minX / CELL); ix <= Math.floor(collider.maxX / CELL); ix++) {
        for (let iz = Math.floor(collider.minZ / CELL); iz <= Math.floor(collider.maxZ / CELL); iz++) {
          const key = cellKey(ix, iz);
          const list = this.cells.get(key) ?? [];
          list.push(collider);
          this.cells.set(key, list);
        }
      }
    }
  }

  private forEachNear(minX: number, minZ: number, maxX: number, maxZ: number, visit: (collider: CityCollider) => void): void {
    const stamp = ++this.stamp;
    for (let ix = Math.floor(minX / CELL); ix <= Math.floor(maxX / CELL); ix++) {
      for (let iz = Math.floor(minZ / CELL); iz <= Math.floor(maxZ / CELL); iz++) {
        const list = this.cells.get(cellKey(ix, iz));
        if (!list) continue;
        for (const collider of list) {
          if (collider.stamp === stamp || collider.disabled) continue;
          collider.stamp = stamp;
          visit(collider);
        }
      }
    }
  }

  groundHeight(x: number, z: number): number {
    return this.heights.heightAt(x, z);
  }

  /** v1's collideSphere: pushes the sphere out of any building it overlaps (two passes); returns the deepest. */
  resolveSphere(position: Vector3, _previous: Vector3, radius: number, outNormal: Vector3): CityCollider | null {
    let deepest: CityCollider | null = null;
    let deepestPenetration = -Infinity;
    outNormal.set(0, 0, 0);
    for (let pass = 0; pass < 2; pass++) {
      this.forEachNear(position.x - radius, position.z - radius, position.x + radius, position.z + radius, (collider) => {
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
          this.exitFromInside(collider, position, radius, outNormal);
        }
      });
    }
    if (deepest) {
      if (outNormal.lengthSq() < 1e-8) outNormal.set(0, 1, 0);
      outNormal.normalize();
    }
    return deepest;
  }

  private exitFromInside(collider: CityCollider, position: Vector3, radius: number, outNormal: Vector3): void {
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
    const exits: [number, number, number, number][] = [
      [position.x - collider.minX, -1, 0, 0],
      [collider.maxX - position.x, 1, 0, 0],
      [collider.maxY - position.y, 0, 1, 0],
      [position.z - collider.minZ, 0, 0, -1],
      [collider.maxZ - position.z, 0, 0, 1],
    ];
    exits.sort((a, b) => a[0] - b[0]);
    const [depth, nx, ny, nz] = exits[0]!;
    position.x += nx * (depth + radius);
    position.y += ny * (depth + radius);
    position.z += nz * (depth + radius);
    outNormal.x += nx;
    outNormal.y += ny;
    outNormal.z += nz;
  }

  nearestSurface(position: Vector3, maxDistance: number): number {
    let best = Infinity;
    this.forEachNear(position.x - maxDistance, position.z - maxDistance, position.x + maxDistance, position.z + maxDistance, (collider) => {
      if (position.y - maxDistance > collider.maxY || position.y + maxDistance < collider.minY) return;
      closestPointOn(collider, position, closest);
      best = Math.min(best, closest.distanceTo(position));
    });
    return best;
  }

  /** Distance along a ray to the first building (cylinders treated as boxes, as in v1), or maxDistance. */
  raycast(origin: Vector3, direction: Vector3, maxDistance: number): number {
    const endX = origin.x + direction.x * maxDistance;
    const endZ = origin.z + direction.z * maxDistance;
    let best = maxDistance;
    this.forEachNear(Math.min(origin.x, endX) - 1, Math.min(origin.z, endZ) - 1, Math.max(origin.x, endX) + 1, Math.max(origin.z, endZ) + 1, (collider) => {
      const hit = rayBox(origin, direction, collider);
      if (hit >= 0 && hit < best) best = hit;
    });
    return best;
  }

  isClear(position: Vector3, radius: number): boolean {
    return this.nearestSurface(position, radius) >= radius;
  }

  /** Highest surface under (x, z) at or below `belowY`: ground or sea, or a rooftop to land on. */
  floorAt(x: number, z: number, belowY = Infinity, ignoreBuilding = -1): number {
    let floor = Math.max(this.heights.heightAt(x, z), 0);
    this.forEachNear(x, z, x, z, (collider) => {
      if (collider.building === ignoreBuilding) return;
      if (collider.maxY > belowY + 0.5 || collider.maxY <= floor) return;
      const inside =
        collider.kind === 'box'
          ? x >= collider.minX && x <= collider.maxX && z >= collider.minZ && z <= collider.maxZ
          : Math.hypot(x - collider.x, z - collider.z) <= collider.radius;
      if (inside) floor = collider.maxY;
    });
    return floor;
  }
}
