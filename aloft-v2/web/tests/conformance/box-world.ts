import type { FlightWorld, SmashOutcome } from '../../src/core/flight-model';
import type { Vector3 } from '../../src/core/math';

// The test world from v1's flight tests: open sea (seabed at -40) and at most one box tower.
// godot/tests/conformance_box_world.gd implements exactly the same rules.

export type Vec3Tuple = [number, number, number];
export interface BoxSpec {
  min: Vec3Tuple;
  max: Vec3Tuple;
}
export type SmashBehaviour = 'none' | 'burst' | 'dent';

export interface BoxWorld extends FlightWorld<'tower'> {
  tower: BoxSpec | null;
  smashImpacts: number[];
}

export function createBoxWorld(tower: BoxSpec | null, smash: SmashBehaviour = 'none'): BoxWorld {
  const world: BoxWorld = {
    tower,
    smashImpacts: [],
    groundHeight: () => -40,
    nearestSurface: () => Infinity,
    resolveSphere(p: Vector3, _previous: Vector3, r: number, normal: Vector3) {
      const box = world.tower;
      if (!box) return null;
      const qx = Math.min(Math.max(p.x, box.min[0]), box.max[0]);
      const qy = Math.min(Math.max(p.y, box.min[1]), box.max[1]);
      const qz = Math.min(Math.max(p.z, box.min[2]), box.max[2]);
      const dx = p.x - qx;
      const dy = p.y - qy;
      const dz = p.z - qz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist >= r || dist === 0) return null;
      normal.set(dx / dist, dy / dist, dz / dist);
      p.addScaledVector(normal, r - dist);
      return 'tower';
    },
  };
  if (smash !== 'none') {
    world.smash = (_hit, _point, _normal, _velocity, impact): SmashOutcome => {
      world.smashImpacts.push(impact);
      if (smash === 'burst') {
        world.tower = null; // the section above is gone
        return { brokeThrough: true, strength: 1, kind: 'topple' };
      }
      return { brokeThrough: false, strength: 0.3, kind: 'dent' };
    };
  }
  return world;
}
