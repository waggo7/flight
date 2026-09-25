import type RAPIER from '@dimforge/rapier3d-compat';
import type { CityBlueprint } from '../core/city-blueprint';
import type { PhysicsWorld } from './physics-world';

// Builds the static city in Rapier from the blueprint: one fixed body per building, one collider
// per piece (boxes keep their yaw, round towers are cylinders, spire needles are cones). The
// twist tower's 62 slabs get their own rotated boxes, replacing v1's stand-in cylinder. The flat
// city island is a thick slab, so fast corners can't tunnel through it.

export const GROUND_SLAB = { radius: 1300, top: 4, thickness: 24 } as const;

export interface CityBodies {
  /** Fixed body per building id. */
  bodies: RAPIER.RigidBody[];
  /** Colliders per building id. */
  colliders: RAPIER.Collider[][];
  ground: RAPIER.Collider;
}

export function buildCityPhysics(physics: PhysicsWorld, blueprint: CityBlueprint): CityBodies {
  const { rapier, world, groups } = physics;
  const bodies: RAPIER.RigidBody[] = [];
  const colliders: RAPIER.Collider[][] = [];
  const cityGroups = groups.city;
  for (const building of blueprint.buildings) {
    bodies[building.id] = world.createRigidBody(rapier.RigidBodyDesc.fixed());
    colliders[building.id] = [];
  }
  const add = (buildingId: number, pieceId: number, desc: RAPIER.ColliderDesc): void => {
    const collider = world.createCollider(desc.setCollisionGroups(cityGroups), bodies[buildingId]);
    physics.own(collider, { kind: 'building', building: buildingId, id: pieceId });
    colliders[buildingId]!.push(collider);
  };

  for (const box of blueprint.boxes) {
    // v1 left the twist tower's slabs without colliders (a cylinder stood in); here each slab is solid.
    // They are the only non-colliding boxes, all with the tower role.
    if (!box.collide && box.role !== 'tower') continue;
    const half = Math.sin(box.yaw / 2);
    add(
      box.building,
      box.index,
      rapier.ColliderDesc.cuboid(box.w / 2, box.h / 2, box.d / 2)
        .setTranslation(box.x, box.y0 + box.h / 2, box.z)
        .setRotation({ x: 0, y: half, z: 0, w: Math.cos(box.yaw / 2) }),
    );
  }
  for (const round of blueprint.rounds) {
    if (!round.collide) continue;
    add(round.building, round.index, rapier.ColliderDesc.cylinder(round.h / 2, round.radius).setTranslation(round.x, round.y0 + round.h / 2, round.z));
  }
  for (const spire of blueprint.spires) {
    add(spire.building, spire.index, rapier.ColliderDesc.cone(spire.height / 2, spire.radius).setTranslation(spire.x, spire.y + spire.height / 2, spire.z));
  }

  const ground = world.createCollider(
    rapier.ColliderDesc.cylinder(GROUND_SLAB.thickness / 2, GROUND_SLAB.radius)
      .setTranslation(0, GROUND_SLAB.top - GROUND_SLAB.thickness / 2, 0)
      .setCollisionGroups(groups.ground),
  );
  physics.own(ground, { kind: 'ground', building: -1, id: 0 });
  return { bodies, colliders, ground };
}
