import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, test } from 'vitest';
import { collisionGroups, interactionGroups, Membership } from '../../src/sim/collision-groups';

// Pins Rapier 0.20's conventions the game depends on, so an upgrade that changes them fails here
// instead of as a subtle gameplay bug.

beforeAll(async () => {
  await RAPIER.init();
});

function newWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  return world;
}

const GROUPS = collisionGroups({ debrisHitsDebris: true });

describe('Rapier 0.20 contract', () => {
  test('a dropped box lands on fixed ground and goes to sleep', () => {
    const world = newWorld();
    world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50).setTranslation(0, -0.5, 0));
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), body);
    for (let i = 0; i < 600; i++) world.step();
    expect(body.translation().y).toBeCloseTo(0.5, 1);
    expect(body.isSleeping()).toBe(true);
    world.free();
  });

  test('castShape: toi is a fraction of the motion; index 1 = the collider hit (world space), index 2 = the cast shape (its local frame)', () => {
    const world = newWorld();
    // A wall rotated 90° about Y, so a local-space normal would be visibly wrong.
    const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 5, 0).setRotation({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }));
    world.createCollider(RAPIER.ColliderDesc.cuboid(4, 4, 1), wallBody); // rotated: 1 m half-depth now along X
    world.step();
    const ball = new RAPIER.Ball(1);
    const hit = world.castShape({ x: -10, y: 5, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, { x: 20, y: 0, z: 0 }, ball, 0, 1, true);
    expect(hit).not.toBeNull();
    // Ball centre stops 1 m before the face at x = -1: travels 8 m of 20.
    expect(hit!.time_of_impact).toBeCloseTo(8 / 20, 3);
    // normal1: the wall's outward surface normal at the hit, in world space (world −X even though
    // the wall is rotated), i.e. the direction to push the hero out. witness1: the contact point
    // on the wall, in world space.
    expect(hit!.normal1.x).toBeCloseTo(-1, 3);
    expect(Math.abs(hit!.normal1.y) + Math.abs(hit!.normal1.z)).toBeLessThan(1e-3);
    expect(hit!.witness1.x).toBeCloseTo(-1, 2);
    expect(hit!.witness1.y).toBeCloseTo(5, 2);
    // normal2/witness2 describe the cast ball in its own (identity) frame: the opposite normal.
    expect(hit!.normal2.x).toBeCloseTo(1, 3);
    world.free();
  });

  test('contact-force events fire above the threshold and can be localised with contactPair', () => {
    const world = newWorld();
    const events = new RAPIER.EventQueue(true);
    const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50).setTranslation(0, -0.5, 0));
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(3, 6, -2));
    const box = world.createCollider(
      RAPIER.ColliderDesc.cuboid(1, 1, 1).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(100),
      body,
    );
    let strongest = 0;
    let point: RAPIER.Vector | null = null;
    for (let i = 0; i < 180 && !point; i++) {
      world.step(events);
      events.drainContactForceEvents((event) => {
        strongest = Math.max(strongest, event.totalForceMagnitude());
        const c1 = world.getCollider(event.collider1());
        const c2 = world.getCollider(event.collider2());
        world.contactPair(c1, c2, (manifold) => {
          if (manifold.numSolverContacts() > 0) point = manifold.solverContactPoint(0);
        });
      });
    }
    expect(strongest).toBeGreaterThan(100);
    expect(point).not.toBeNull();
    // A world-space point on the box's bottom face, around (3, 0, -2).
    expect(point!.x).toBeGreaterThan(1.5);
    expect(point!.x).toBeLessThan(4.5);
    expect(Math.abs(point!.y)).toBeLessThan(0.3);
    expect(ground.handle).not.toBe(box.handle);
    world.free();
    events.free();
  });

  test('dominance: a higher dominance group is not pushed by a lower one', () => {
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    const heavy = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, 0).setLinvel(0, 0, 0).setDominanceGroup(1));
    world.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1).setDensity(1), heavy);
    const light = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(-4, 0, 0).setLinvel(30, 0, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1).setDensity(1000), light); // heavier, but lower dominance
    for (let i = 0; i < 60; i++) world.step();
    expect(Math.hypot(heavy.linvel().x, heavy.linvel().y, heavy.linvel().z)).toBeLessThan(1e-4);
    world.free();
  });

  test('freezing to fixed holds a body; unfreezing lets it fall again', () => {
    const world = newWorld();
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 10, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), body);
    body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
    for (let i = 0; i < 60; i++) world.step();
    expect(body.translation().y).toBeCloseTo(10, 6);
    body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    for (let i = 0; i < 60; i++) world.step();
    expect(body.translation().y).toBeLessThan(9);
    world.free();
  });

  test('a snapshot restores positions and keeps handles valid', () => {
    const world = newWorld();
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 10, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), body);
    const handle = body.handle;
    const snapshot = world.takeSnapshot();
    for (let i = 0; i < 60; i++) world.step();
    world.free();
    const restored = RAPIER.World.restoreSnapshot(snapshot);
    const again = restored.getRigidBody(handle);
    expect(again).toBeTruthy();
    expect(again.translation().y).toBeCloseTo(10, 6);
    restored.free();
  });

  test('queries see a newly created collider only after the next step (documents the staleness rule)', () => {
    const world = newWorld();
    world.step();
    world.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1).setTranslation(0, 0, 5));
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const before = world.castRay(ray, 100, true);
    world.step();
    const after = world.castRay(ray, 100, true);
    expect(after?.timeOfImpact).toBeCloseTo(4, 3);
    // Whatever `before` is, the game never relies on it: new colliders are filtered by the alive table.
    expect(before === null || before.timeOfImpact > 0).toBe(true);
    world.free();
  });

  test('groups are two-sided: queries only see colliders whose filter includes QUERY', () => {
    const world = newWorld();
    world.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1).setTranslation(0, 0, 5).setCollisionGroups(GROUPS.debris));
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(1, 1, 1).setTranslation(0, 0, 10).setCollisionGroups(interactionGroups(Membership.CITY, Membership.ACTOR)),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1).setTranslation(0, 0, 15).setCollisionGroups(GROUPS.city));
    world.step();
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    // The hero ignores debris and sees the city collider whose filter includes QUERY (at z = 15).
    const hero = world.castRay(ray, 100, true, undefined, GROUPS.heroQuery);
    expect(hero?.timeOfImpact).toBeCloseTo(14, 3);
    // The movable query does see debris.
    const movable = world.castRay(ray, 100, true, undefined, GROUPS.movableQuery);
    expect(movable?.timeOfImpact).toBeCloseTo(4, 3);
    world.free();
  });
});
