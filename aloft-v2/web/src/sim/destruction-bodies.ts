import type RAPIER from '@dimforge/rapier3d-compat';
import type { Segment, WorldPoint } from '../core/building-structure';
import type { CityBlueprint, PieceRef } from '../core/city-blueprint';
import type { Region } from '../core/structure-regions';
import type { Rapier } from './physics-world';

// Geometry for destruction bodies: where a region or ornament sits in the world as generated,
// and the Rapier collider that stands for it inside a body whose local frame is that world frame
// shifted by `origin` (every fragment body starts unrotated at its origin, and pieces that break
// off later start with their parent's pose, so they share its origin).

export interface Placement {
  /** Centre of the box (world, as generated). */
  centre: WorldPoint;
  yaw: number;
  /** Half extents; round pieces use x for the radius. */
  half: WorldPoint;
  shape: 'box' | 'cylinder' | 'cone';
}

/** Local (x, z from the segment's min corner, y from its base) → world, as generated. */
export function segmentToWorld(segment: Segment, x: number, y: number, z: number): WorldPoint {
  const lx = x - segment.w / 2;
  const lz = z - segment.d / 2;
  const cos = Math.cos(segment.yaw);
  const sin = Math.sin(segment.yaw);
  return { x: segment.x + lx * cos + lz * sin, y: segment.y0 + y, z: segment.z - lx * sin + lz * cos };
}

export function regionPlacement(segment: Segment, region: Region): Placement {
  const centre = segmentToWorld(segment, (region.x0 + region.x1) / 2, (region.y0 + region.y1) / 2, (region.z0 + region.z1) / 2);
  const half = { x: (region.x1 - region.x0) / 2, y: (region.y1 - region.y0) / 2, z: (region.z1 - region.z0) / 2 };
  return { centre, yaw: segment.yaw, half, shape: segment.shape === 'round' ? 'cylinder' : 'box' };
}

export function ornamentPlacement(blueprint: CityBlueprint, piece: PieceRef): Placement | null {
  switch (piece.kind) {
    case 'box': {
      const b = blueprint.boxes[piece.index]!;
      return { centre: { x: b.x, y: b.y0 + b.h / 2, z: b.z }, yaw: b.yaw, half: { x: b.w / 2, y: b.h / 2, z: b.d / 2 }, shape: 'box' };
    }
    case 'round': {
      const r = blueprint.rounds[piece.index]!;
      return { centre: { x: r.x, y: r.y0 + r.h / 2, z: r.z }, yaw: 0, half: { x: r.radius, y: r.h / 2, z: r.radius }, shape: 'cylinder' };
    }
    case 'spire': {
      const s = blueprint.spires[piece.index]!;
      return { centre: { x: s.x, y: s.y + s.height / 2, z: s.z }, yaw: 0, half: { x: s.radius, y: s.height / 2, z: s.radius }, shape: 'cone' };
    }
    default:
      return null; // beacons ride along without a collider
  }
}

export function placementVolume(p: Placement): number {
  if (p.shape === 'box') return 8 * p.half.x * p.half.y * p.half.z;
  const cylinder = Math.PI * p.half.x * p.half.x * 2 * p.half.y;
  return p.shape === 'cone' ? cylinder / 3 : cylinder;
}

/** Rapier sees a compressed mass so heavy sections and light debris stay solvable together. */
export function solverMass(mass: number, reference: number): number {
  return mass <= 0 ? 0 : reference * Math.sqrt(mass / reference);
}

/**
 * A collider for `placement` inside a body whose frame is the world shifted by `origin`, shrunk by
 * `clearance` on every side, with the density that gives it `mass` (kg, already compressed).
 */
export function placementCollider(rapier: Rapier, placement: Placement, origin: WorldPoint, clearance: number, mass: number): RAPIER.ColliderDesc {
  const shrink = (v: number): number => Math.max(0.05, v - clearance);
  const hx = shrink(placement.half.x);
  const hy = shrink(placement.half.y);
  const hz = shrink(placement.half.z);
  const desc = placement.shape === 'box'
    ? rapier.ColliderDesc.cuboid(hx, hy, hz)
    : placement.shape === 'cylinder'
      ? rapier.ColliderDesc.cylinder(hy, hx)
      : rapier.ColliderDesc.cone(hy, hx);
  const volume = placementVolume({ ...placement, half: { x: hx, y: hy, z: hz } });
  return desc
    .setTranslation(placement.centre.x - origin.x, placement.centre.y - origin.y + clearance, placement.centre.z - origin.z)
    .setRotation({ x: 0, y: Math.sin(placement.yaw / 2), z: 0, w: Math.cos(placement.yaw / 2) })
    .setDensity(mass / Math.max(volume, 1e-6));
}
