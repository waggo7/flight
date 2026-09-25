import { beforeAll, describe, expect, test } from 'vitest';
import { generateCityBlueprint } from '../../src/core/city-blueprint';
import { FlightModel } from '../../src/core/flight-model';
import { IslandHeights } from '../../src/core/island-terrain-height';
import { Vector3 } from '../../src/core/math';
import { loadContent } from '../../src/engine/content-library';
import { buildCityPhysics } from '../../src/sim/city-physics';
import { loadRapier, PhysicsWorld, type Rapier } from '../../src/sim/physics-world';
import { RapierCityWorld } from '../../src/sim/rapier-city-world';

const content = loadContent();
const heights = new IslandHeights();
const blueprint = generateCityBlueprint((x, z) => heights.heightAt(x, z));
const spire = blueprint.landmarks.spire;
let rapier: Rapier;

beforeAll(async () => {
  rapier = await loadRapier();
});

function buildWorld(): { physics: PhysicsWorld; world: RapierCityWorld; buildMs: number } {
  const started = performance.now();
  const physics = new PhysicsWorld(rapier, { gravity: 9.81, stepsPerSecond: 60, solverIterations: 4, debrisHitsDebris: true });
  buildCityPhysics(physics, blueprint);
  physics.step(); // queries read the tree built during a step
  physics.capturePristine();
  const world = new RapierCityWorld(physics, heights, content.flight.radius);
  return { physics, world, buildMs: performance.now() - started };
}

describe('Rapier city world', () => {
  test('builds the whole static city quickly', () => {
    const { physics, buildMs } = buildWorld();
    const colliders = physics.world.colliders.len();
    expect(colliders).toBeGreaterThan(4200); // pieces + 62 twist slabs + spires + ground
    expect(buildMs).toBeLessThan(2000);
    console.log(`static city: ${colliders} colliders in ${buildMs.toFixed(0)} ms`);
    physics.world.free();
  });

  test('boosting into the spire glances off, as with v1 collision', () => {
    const { physics, world } = buildWorld();
    const model = new FlightModel(world, content.flight);
    model.reset(new Vector3(spire.x, 80, spire.z - 200), 0);
    model.launch();
    for (let i = 0; i < 360; i++) model.update(1 / 60, { steerX: 0, steerY: 0, boost: true, brake: false });
    const p = model.position;
    expect(Math.abs(p.x - spire.x) < 23 && Math.abs(p.z - spire.z) < 23 && p.y < 72).toBe(false);
    const impacts = model.takeEvents().filter((e) => e.type === 'impact');
    expect(impacts.length).toBeGreaterThan(0);
    physics.world.free();
  });

  test('the hero cannot tunnel through a building at full boost, even over long steps', () => {
    const { physics, world } = buildWorld();
    const model = new FlightModel(world, content.flight);
    model.reset(new Vector3(spire.x, 60, spire.z - 120), 0);
    model.launch();
    model.speed = content.flight.boostSpeed;
    for (let i = 0; i < 40; i++) model.update(1 / 20, { steerX: 0, steerY: 0, boost: true, brake: false }); // 5.4 m per step
    expect(model.position.z).toBeLessThan(spire.z - 23 + 0.01);
    physics.world.free();
  });

  test('queries: roofs, sky, walls and the camera ray agree', () => {
    const { physics, world } = buildWorld();
    const roof = world.floorAt(spire.x, spire.z, 5000);
    expect(roof).toBeGreaterThan(400);
    expect(world.raycast(new Vector3(spire.x, 700, spire.z), new Vector3(0, -1, 0), 1000)).toBeCloseTo(700 - roof, 2);
    expect(world.isClear(new Vector3(0, 900, 0), 10)).toBe(true);
    expect(world.nearestSurface(new Vector3(spire.x + 23 + 5, 30, spire.z), 16)).toBeCloseTo(5, 1);
    expect(world.floorAt(0, 0)).toBeCloseTo(4, 3);
    physics.world.free();
  });

  test('restart restores the pristine city after colliders are removed', () => {
    const { physics } = buildWorld();
    const before = physics.world.colliders.len();
    let removed = 0;
    physics.world.forEachCollider((collider) => {
      if (removed < 50 && physics.ownerOf(collider)?.kind === 'building') {
        physics.removeCollider(collider);
        removed++;
      }
    });
    physics.step();
    expect(physics.world.colliders.len()).toBe(before - 50);
    physics.restorePristine();
    expect(physics.world.colliders.len()).toBe(before);
    let dead = 0;
    for (const owner of physics.owners.values()) if (!owner.alive) dead++;
    expect(dead).toBe(0);
    physics.world.free();
  });

  test('a static-city step and a hero sweep are cheap', () => {
    const { physics, world } = buildWorld();
    let started = performance.now();
    for (let i = 0; i < 120; i++) physics.step();
    const stepMs = (performance.now() - started) / 120;
    const p = new Vector3();
    const previous = new Vector3(spire.x - 100, 60, spire.z - 100);
    const normal = new Vector3();
    started = performance.now();
    for (let i = 0; i < 1000; i++) {
      p.set(previous.x + 1.8, 60, previous.z + 1.8);
      world.resolveSphere(p, previous, 1.2, normal);
    }
    const sweepMs = (performance.now() - started) / 1000;
    console.log(`static step ${stepMs.toFixed(3)} ms, hero sweep ${(sweepMs * 1000).toFixed(1)} µs`);
    expect(stepMs).toBeLessThan(2);
    expect(sweepMs).toBeLessThan(0.2);
    physics.world.free();
  });
});
