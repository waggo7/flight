import { generateCityBlueprint, type CityBlueprint } from '../core/city-blueprint';
import { IslandHeights } from '../core/island-terrain-height';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase, StepPhase } from '../engine/system-phases';
import { CityMeshes } from '../present/render/city/city-meshes';
import { buildCityPhysics } from '../sim/city-physics';
import { loadRapier, PhysicsWorld } from '../sim/physics-world';
import { RapierCityWorld } from '../sim/rapier-city-world';
import { SceneToken } from './scene-feature';
import { WorldToken } from './world-token';

// The island's height grid, the city blueprint (v1's skyline, same seed), its meshes, and the
// Rapier world the hero and camera query. Rapier's wasm loads while the blueprint is generated.
// Restart restores the pristine physics snapshot and instance buffers.

export interface CityService {
  readonly heights: IslandHeights;
  readonly blueprint: CityBlueprint;
  readonly meshes: CityMeshes;
  readonly physics: PhysicsWorld;
  readonly world: RapierCityWorld;
}

export const CityToken = serviceToken<CityService>('city');

export const cityFeature: Feature = {
  name: 'city',
  async install(ctx) {
    const { scene } = ctx.services.require(SceneToken);
    const rapierLoading = loadRapier();
    const heights = new IslandHeights();
    const blueprint = generateCityBlueprint((x, z) => heights.heightAt(x, z));
    const meshes = new CityMeshes(blueprint);
    scene.add(meshes.group);

    const { physics: tuning, stepsPerSecond } = ctx.content.simulation;
    const physics = new PhysicsWorld(await rapierLoading, {
      gravity: tuning.gravity,
      stepsPerSecond,
      solverIterations: tuning.solverIterations,
      debrisHitsDebris: tuning.debrisHitsDebris[ctx.profile],
    });
    buildCityPhysics(physics, blueprint);
    physics.step(); // queries read the tree built during a step
    physics.capturePristine();
    const world = new RapierCityWorld(physics, heights, ctx.content.flight.radius);

    ctx.services.provide(WorldToken, world);
    ctx.services.provide(CityToken, { heights, blueprint, meshes, physics, world });
    ctx.events.on('game:restart', () => {
      physics.restorePristine();
      meshes.restore();
    });
    ctx.systems.addStep({
      name: 'physics',
      phase: StepPhase.Physics,
      step(dt) {
        world.tick(dt);
        physics.step();
      },
    });
    ctx.systems.addFrame({
      name: 'city-beacons',
      phase: FramePhase.Present,
      frame() {
        meshes.update(ctx.loop.simTime);
      },
    });
  },
};
