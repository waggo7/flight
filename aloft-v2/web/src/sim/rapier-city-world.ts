import type RAPIER from '@dimforge/rapier3d-compat';
import type { IslandHeights } from '../core/island-terrain-height';
import { Vector3 } from '../core/math';
import type { ColliderOwner, PhysicsWorld } from './physics-world';
import type { GameWorld } from './world-contracts';

// The GameWorld contract over Rapier: the hero is query-only (a swept ball, never a body), the
// camera casts rays at buildings and big sections, and floors come from a downward ray. Dead
// owners are filtered out because Rapier's query tree only refreshes during a step.

export interface WorldHit {
  collider: RAPIER.Collider;
  owner: ColliderOwner;
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const scratch = new Vector3();
const motion = new Vector3();

export class RapierCityWorld implements GameWorld<WorldHit> {
  private readonly heroBall: RAPIER.Ball;
  /** Buildings the hero just broke through; skipped for a moment so the burst isn't a second hit. */
  private readonly passThrough = new Map<number, number>();
  private clock = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly heights: IslandHeights,
    heroRadius: number,
  ) {
    this.heroBall = new physics.rapier.Ball(heroRadius);
  }

  /** Advance the pass-through timers (call once per sim step). */
  tick(dt: number): void {
    this.clock += dt;
    for (const [building, until] of this.passThrough) if (until <= this.clock) this.passThrough.delete(building);
  }

  /** Let the hero pass through `building`'s colliders for `seconds` (v1 used 0.25 s after a smash). */
  allowPassThrough(building: number, seconds: number): void {
    this.passThrough.set(building, this.clock + seconds);
  }

  private queryable = (collider: RAPIER.Collider): boolean => {
    const owner = this.physics.ownerOf(collider);
    return !!owner && owner.alive && !this.passThrough.has(owner.building);
  };

  groundHeight(x: number, z: number): number {
    return this.heights.heightAt(x, z);
  }

  resolveSphere(position: Vector3, previous: Vector3, radius: number, outNormal: Vector3): WorldHit | null {
    const { world, groups } = this.physics;
    let result: WorldHit | null = null;
    motion.subVectors(position, previous);
    const distance = motion.length();
    // 1) Sweep from where the step started, so nothing is skipped at 108 m/s.
    if (distance > 1e-6) {
      const hit = world.castShape(previous, IDENTITY, motion, this.heroBall, 0, 1, true, undefined, groups.heroQuery, undefined, undefined, this.queryable);
      if (hit && hit.time_of_impact < 1) {
        const owner = this.physics.ownerOf(hit.collider)!;
        const t = Math.max(0, hit.time_of_impact - 1e-3 / distance);
        position.copy(previous).addScaledVector(motion, t);
        outNormal.set(hit.normal1.x, hit.normal1.y, hit.normal1.z).normalize();
        result = { collider: hit.collider, owner };
      }
    }
    // 2) Push out of anything still overlapping (rotated slabs, starting inside, moving pieces).
    for (let pass = 0; pass < 2; pass++) {
      const projection = world.projectPoint(position, false, undefined, groups.heroQuery, undefined, undefined, this.queryable);
      if (!projection) break;
      scratch.set(projection.point.x, projection.point.y, projection.point.z);
      const gap = scratch.distanceTo(position);
      if (projection.isInside) {
        // Centre inside the solid: leave through the nearest surface point.
        const direction = scratch.clone().sub(position).normalize();
        position.copy(scratch).addScaledVector(direction, radius);
        if (!result) outNormal.copy(direction);
      } else if (gap < radius - 1e-4) {
        const direction = position.clone().sub(scratch).divideScalar(Math.max(gap, 1e-6));
        position.copy(scratch).addScaledVector(direction, radius);
        if (!result) outNormal.copy(direction);
      } else break;
      if (!result) {
        const collider = world.getCollider(projection.collider.handle);
        result = { collider, owner: this.physics.ownerOf(collider)! };
      }
    }
    return result;
  }

  nearestSurface(position: Vector3, maxDistance: number): number {
    const projection = this.physics.world.projectPoint(position, true, undefined, this.physics.groups.cameraQuery, undefined, undefined, this.queryable);
    if (!projection) return Infinity;
    const d = scratch.set(projection.point.x, projection.point.y, projection.point.z).distanceTo(position);
    return d <= maxDistance ? d : Infinity;
  }

  raycast(origin: Vector3, direction: Vector3, maxDistance: number): number {
    const ray = new this.physics.rapier.Ray(origin, direction);
    const hit = this.physics.world.castRay(ray, maxDistance, true, undefined, this.physics.groups.cameraQuery, undefined, undefined, this.queryable);
    // The ground and sea surface too, as v1's grid did for the camera.
    let best = hit ? hit.timeOfImpact : maxDistance;
    if (direction.y < -1e-6) {
      const surface = Math.max(this.heights.heightAt(origin.x, origin.z), 0);
      const t = (surface - origin.y) / direction.y;
      if (t >= 0 && t < best) best = t;
    }
    return best;
  }

  isClear(position: Vector3, radius: number): boolean {
    return this.nearestSurface(position, radius) >= radius;
  }

  /** Highest surface under (x, z) at or below `belowY`: a roof, or the ground or sea. */
  floorAt(x: number, z: number, belowY = Infinity, ignoreBuilding = -1): number {
    const ground = Math.max(this.heights.heightAt(x, z), 0);
    const top = Math.min(Number.isFinite(belowY) ? belowY + 0.5 : 3000, 3000);
    if (top <= ground) return ground;
    const ray = new this.physics.rapier.Ray({ x, y: top, z }, { x: 0, y: -1, z: 0 });
    const hit = this.physics.world.castRay(ray, top - ground, true, undefined, this.physics.groups.floorQuery, undefined, undefined, (collider) =>
      this.queryable(collider) && this.physics.ownerOf(collider)!.building !== ignoreBuilding,
    );
    return hit ? Math.max(top - hit.timeOfImpact, ground) : ground;
  }
}
