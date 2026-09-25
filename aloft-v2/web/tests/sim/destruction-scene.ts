import type { WorldPoint } from '../../src/core/building-structure';
import type { CityBlueprint } from '../../src/core/city-blueprint';
import type { SmashOutcome } from '../../src/core/flight-model';
import { loadContent } from '../../src/engine/content-library';
import { EventBus, type GameEventMap } from '../../src/engine/event-bus';
import { createRandomStream } from '../../src/engine/random-streams';
import { buildCityPhysics } from '../../src/sim/city-physics';
import { DestructionSystem } from '../../src/sim/destruction-system';
import { PhysicsWorld, type Rapier } from '../../src/sim/physics-world';
import { RapierCityWorld } from '../../src/sim/rapier-city-world';

// A destruction test bench in Node: a city (synthetic or real) in Rapier with the destruction
// system, a hero hit helper, and a stepper that records events.

export const content = loadContent();
export const DT = 1 / 60;

export interface Recorded {
  time: number;
  type: keyof GameEventMap;
  payload: unknown;
}

export function destructionScene(rapier: Rapier, blueprint: CityBlueprint) {
  const physics = new PhysicsWorld(rapier, { gravity: 9.81, stepsPerSecond: 60, solverIterations: 4, debrisHitsDebris: true });
  buildCityPhysics(physics, blueprint);
  physics.step();
  physics.capturePristine();
  const heights = { heightAt: () => 4 } as unknown as ConstructorParameters<typeof RapierCityWorld>[1];
  const world = new RapierCityWorld(physics, heights, content.flight.radius);
  const events = new EventBus<GameEventMap>();
  const random = createRandomStream(7);
  const system = new DestructionSystem(physics, blueprint, content.destruction, {
    profile: 'desktop', heroRadius: content.flight.radius, events, random: () => random,
    onBurst: (building) => world.allowPassThrough(building, 0.25),
  });
  const log: Recorded[] = [];
  let time = 0;
  for (const type of ['destruction:damage', 'destruction:strain', 'destruction:failure', 'destruction:impact'] as const) {
    events.on(type, (payload) => log.push({ time, type, payload }));
  }

  /** The hero flying along `dir` at `speed` hits the first building collider on its path. */
  const heroHit = (from: WorldPoint, dir: WorldPoint, speed: number): SmashOutcome | null => {
    const ray = new rapier.Ray(from, dir);
    const hit = physics.world.castRay(ray, 500, true, undefined, physics.groups.heroQuery);
    if (!hit) return null;
    const collider = hit.collider;
    const point = { x: from.x + dir.x * hit.timeOfImpact, y: from.y + dir.y * hit.timeOfImpact, z: from.z + dir.z * hit.timeOfImpact };
    const outcome = system.heroHit({ collider, owner: physics.ownerOf(collider)! }, point, { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed }, speed);
    events.flush();
    return outcome;
  };

  const step = (count = 1): void => {
    for (let i = 0; i < count; i++) {
      system.beforeStep();
      world.tick(DT);
      physics.step();
      system.afterStep(DT);
      time += DT;
      events.flush();
    }
  };

  return { physics, world, system, events, log, heroHit, step, get time() { return time; } };
}
