import type { BoxPiece, CityBlueprint } from '../core/city-blueprint';
import type { PhysicsWorld } from './physics-world';

// Finds good places in the (seeded, so always the same) city for the demo scenes: a tall tower
// the hero can reach unobstructed, a tower that will fall onto a neighbour, a street corner
// ringed by towers for a slam.

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface Approach {
  building: number;
  tower: BoxPiece;
  /** Where the hero starts, and the unit direction it flies (horizontal). */
  from: Point;
  direction: Point;
  /** The facade point it will hit. */
  face: Point;
}

const talls = (blueprint: CityBlueprint, minHeight: number, minWidth: number): BoxPiece[] =>
  blueprint.boxes.filter((b) => b.role === 'tower' && b.collide && b.h > minHeight && Math.min(b.w, b.d) > minWidth).sort((a, b) => b.h - a.h);

/** Metres either side of the flight line that must be clear (the hero is a sphere, not a ray). */
const CORRIDOR = 2.5;

/**
 * Fly at `tower` along its local +z (or −z) from `distance` m out, hitting it at `heightShare` of
 * its height. The whole corridor the hero sweeps must be clear: the centre ray and four rays
 * offset by CORRIDOR all have to reach this tower first.
 */
function approachFor(physics: PhysicsWorld, tower: BoxPiece, distance: number, heightShare: number, reverse = false): Approach | null {
  const sign = reverse ? -1 : 1;
  const direction = { x: Math.sin(tower.yaw) * sign, y: 0, z: Math.cos(tower.yaw) * sign };
  const side = { x: direction.z, y: 0, z: -direction.x };
  const y = tower.y0 + tower.h * heightShare;
  const face = { x: tower.x - (direction.x * tower.d) / 2, y, z: tower.z - (direction.z * tower.d) / 2 };
  const from = { x: face.x - direction.x * distance, y, z: face.z - direction.z * distance };
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const start = { x: from.x + side.x * dx * CORRIDOR, y: from.y + dy * CORRIDOR, z: from.z + side.z * dx * CORRIDOR };
    const hit = physics.world.castRay(new physics.rapier.Ray(start, direction), distance + 5, true, undefined, physics.groups.heroQuery);
    if (!hit || hit.timeOfImpact < 1 || physics.ownerOf(hit.collider)?.building !== tower.building) return null;
  }
  return { building: tower.building, tower, from, direction, face };
}

/** The first start distance (farthest first) with a clear corridor. */
function clearApproach(physics: PhysicsWorld, tower: BoxPiece, distance: number, heightShare: number, reverse = false): Approach | null {
  for (const d of [distance, distance * 0.8, distance * 0.6]) {
    const approach = approachFor(physics, tower, d, heightShare, reverse);
    if (approach) return approach;
  }
  return null;
}

export function findSmashApproach(blueprint: CityBlueprint, physics: PhysicsWorld, distance = 70): Approach | null {
  for (const tower of talls(blueprint, 110, 20)) {
    const approach = clearApproach(physics, tower, distance, 0.42);
    if (approach) return approach;
  }
  return null;
}

/** A tower that, knocked over along the flight path, lands on another tower within reach. */
export function findDominoApproach(blueprint: CityBlueprint, physics: PhysicsWorld, distance = 70): (Approach & { next: number }) | null {
  for (const tower of talls(blueprint, 120, 20)) {
    for (const reverse of [false, true]) {
      const approach = clearApproach(physics, tower, distance, 0.42, reverse);
      if (!approach) continue;
      // What stands in the way of the fall, beyond the far face, at a third of the tower's height.
      const d = approach.direction;
      const start = { x: tower.x + (d.x * tower.d) / 2 + d.x, y: tower.y0 + tower.h * 0.35, z: tower.z + (d.z * tower.d) / 2 + d.z };
      const hit = physics.world.castRay(new physics.rapier.Ray(start, d), tower.h * 0.7, true, undefined, physics.groups.floorQuery);
      const owner = hit ? physics.ownerOf(hit.collider) : undefined;
      if (!owner || owner.kind !== 'building' || owner.building === tower.building) continue;
      const next = blueprint.boxes.find((b) => b.building === owner.building && b.role === 'tower');
      if (!next || next.h < 60) continue;
      return { ...approach, next: owner.building };
    }
  }
  return null;
}

/** A spot in the streets with at least `count` towers' footprints within `radius` m. */
export function findSlamSite(blueprint: CityBlueprint, physics: PhysicsWorld, radius = 42, count = 4): Point | null {
  const towers = talls(blueprint, 60, 12);
  let best: { point: Point; score: number } | null = null;
  for (const a of towers.slice(0, 120)) {
    // Try the street corners around each tall tower.
    for (const [ox, oz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const x = a.x + ox * (a.w / 2 + 8);
      const z = a.z + oz * (a.d / 2 + 8);
      const ground = physics.world.castRay(new physics.rapier.Ray({ x, y: 600, z }, { x: 0, y: -1, z: 0 }), 600, true, undefined, physics.groups.floorQuery);
      if (!ground || 600 - ground.timeOfImpact > 12) continue; // must be street level, not a roof
      let near = 0;
      for (const b of towers) if (Math.hypot(b.x - x, b.z - z) - Math.max(b.w, b.d) / 2 < radius) near++;
      if (near >= count && (!best || near > best.score)) best = { point: { x, y: 600 - ground.timeOfImpact, z }, score: near };
    }
  }
  return best?.point ?? null;
}

export function findPancakeTower(blueprint: CityBlueprint): BoxPiece | null {
  return talls(blueprint, 140, 22).find((t) => blueprint.buildings[t.building]!.pieces.filter((p) => p.kind === 'box').length <= 3) ?? null;
}
