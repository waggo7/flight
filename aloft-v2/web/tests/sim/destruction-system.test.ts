import { beforeAll, describe, expect, test } from 'vitest';
import { FacadeStyle } from '../../src/core/city-blueprint';
import { loadRapier, type Rapier } from '../../src/sim/physics-world';
import { syntheticCity } from '../fixtures/synthetic-city';
import { destructionScene } from './destruction-scene';

let rapier: Rapier;
beforeAll(async () => {
  rapier = await loadRapier();
});

const tower30 = () => syntheticCity({ boxes: [{ w: 30, d: 30, h: 120, style: FacadeStyle.glass }] });
const FORWARD = { x: 0, y: 0, z: 1 };

/** Mass-weighted centre and extremes of every loose piece (sections, bands, chunks). */
function pieces(scene: ReturnType<typeof destructionScene>) {
  let mass = 0;
  let z = 0;
  let minY = Infinity;
  let finite = true;
  scene.physics.world.forEachRigidBody((body) => {
    if (!body.isDynamic() && !(body.isFixed() && body.handle !== 0 && body.numColliders() > 0 && scene.physics.ownerOf(body.collider(0))?.kind !== 'building')) return;
    const owner = scene.physics.ownerOf(body.collider(0));
    if (!owner || owner.kind === 'building' || owner.kind === 'ground' || owner.kind === 'debris') return;
    const com = body.worldCom();
    if (![com.x, com.y, com.z].every(Number.isFinite)) finite = false;
    const m = body.mass();
    mass += m;
    z += com.z * m;
    minY = Math.min(minY, com.y);
  });
  return { centreZ: mass > 0 ? z / mass : 0, minY, finite, mass };
}

describe('destruction in Rapier', () => {
  test('hero hits report how much of the punch the building soaked up (the recoil follows it)', () => {
    const glass = destructionScene(rapier, tower30());
    const hits: { brokeThrough: boolean; soaked: number; glass: boolean }[] = [];
    glass.events.on('destruction:hero-hit', (hit) => hits.push(hit));
    glass.heroHit({ x: 0.7, y: 52, z: -80 }, FORWARD, 108);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ brokeThrough: true, glass: true });
    expect(hits[0]!.soaked).toBeGreaterThan(0.05);
    expect(hits[0]!.soaked).toBeLessThan(1);

    // Bouncing head-on off a wide stone block: all of it.
    const stone = destructionScene(rapier, syntheticCity({ boxes: [{ w: 46, d: 46, h: 120, style: FacadeStyle.stone }] }));
    stone.events.on('destruction:hero-hit', (hit) => hits.push(hit));
    stone.heroHit({ x: 0.7, y: 52, z: -80 }, FORWARD, 40);
    expect(hits[1]).toMatchObject({ brokeThrough: false, soaked: 1, glass: false });
  });

  test('30 m glass tower at 55 m/s: bursts through and stands', () => {
    const scene = destructionScene(rapier, tower30());
    const outcome = scene.heroHit({ x: 0.7, y: 52, z: -80 }, FORWARD, 55);
    expect(outcome?.brokeThrough).toBe(true);
    scene.step(60 * 3);
    expect(scene.system.countBodies((f) => !f.debris)).toBe(0);
    expect(scene.log.some((e) => e.type === 'destruction:strain')).toBe(true);
  });

  for (const speed of [70, 108]) {
    test(`30 m glass tower at ${speed} m/s: topples forward and lands within 10 s`, () => {
      const scene = destructionScene(rapier, tower30());
      const outcome = scene.heroHit({ x: 0.7, y: 52, z: -80 }, FORWARD, speed);
      expect(outcome).toMatchObject({ brokeThrough: true, kind: 'topple' });
      let firstGround = Infinity;
      for (let s = 0; s < 60 * 12; s++) {
        scene.step();
        if (!Number.isFinite(firstGround)) {
          const hit = scene.log.find((e) => e.type === 'destruction:impact' && (e.payload as { ground: boolean }).ground);
          if (hit) firstGround = hit.time;
        }
      }
      expect(firstGround).toBeGreaterThan(2.5);
      expect(firstGround).toBeLessThan(10);
      const after = pieces(scene);
      expect(after.finite).toBe(true);
      expect(after.centreZ).toBeGreaterThan(25); // it went over the far side, along the flight path
      expect(after.minY).toBeGreaterThan(-1); // nothing sank through the ground (top at y = 4)
    });
  }

  test('a stump hit again never brings back what already fell (v1 regression)', () => {
    const scene = destructionScene(rapier, tower30());
    scene.heroHit({ x: 0.7, y: 52, z: -80 }, FORWARD, 108);
    scene.step(60 * 12);
    const structure = scene.system.structureOf(0)!;
    // Volume, not node count: a new hit splits whole storeys into bays.
    const standing = (): number => structure.nodes.filter((n) => n.state === 0).reduce((v, n) => v + (n.x1 - n.x0) * (n.y1 - n.y0) * (n.z1 - n.z0), 0);
    const standingBefore = standing();
    scene.heroHit({ x: 0.7, y: 20, z: -80 }, FORWARD, 60);
    scene.step(10);
    expect(standing()).toBeLessThanOrEqual(standingBefore + 1e-6);
    const top = Math.max(...structure.nodes.filter((n) => n.state === 0).map((n) => n.y1));
    expect(top).toBeLessThan(50);
  });

  test('restart forgets every piece and the world is pristine again', () => {
    const scene = destructionScene(rapier, tower30());
    const pristineColliders = scene.physics.world.colliders.len();
    scene.heroHit({ x: 0.7, y: 52, z: -80 }, FORWARD, 108);
    scene.step(120);
    expect(scene.system.fragmentCount).toBeGreaterThan(0);
    scene.physics.restorePristine();
    scene.system.reset();
    expect(scene.system.fragmentCount).toBe(0);
    expect(scene.system.takeChanges().reset).toBe(true);
    expect(scene.physics.world.colliders.len()).toBe(pristineColliders);
    // The building is whole again and takes damage like new.
    expect(scene.heroHit({ x: 0.7, y: 52, z: -80 }, FORWARD, 70)).toMatchObject({ brokeThrough: true, kind: 'topple' });
  });

  test('two runs of the same hit end in the same place (determinism within a process)', () => {
    const run = (): string => {
      const scene = destructionScene(rapier, tower30());
      scene.heroHit({ x: 0.7, y: 52, z: -80 }, FORWARD, 108);
      scene.step(300);
      const parts: string[] = [];
      scene.physics.world.forEachRigidBody((b) => parts.push(`${b.handle}:${b.translation().x.toFixed(3)},${b.translation().y.toFixed(3)},${b.translation().z.toFixed(3)}`));
      return parts.join('|');
    };
    expect(run()).toBe(run());
  });
});
