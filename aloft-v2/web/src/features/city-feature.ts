import { generateCityBlueprint, type CityBlueprint } from '../core/city-blueprint';
import { IslandHeights } from '../core/island-terrain-height';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';
import { CityMeshes } from '../present/render/city/city-meshes';
import { CityCollisionGrid } from '../sim/city-collision-grid';
import { SceneToken } from './scene-feature';
import { WorldToken } from './world-token';

// The island's height grid, the city blueprint (v1's skyline, same seed), its meshes, and — until
// Rapier arrives in M2 — the v1-style collision grid that the hero flies against.

export interface CityService {
  readonly heights: IslandHeights;
  readonly blueprint: CityBlueprint;
  readonly meshes: CityMeshes;
  readonly collision: CityCollisionGrid;
}

export const CityToken = serviceToken<CityService>('city');

export const cityFeature: Feature = {
  name: 'city',
  install(ctx) {
    const { scene } = ctx.services.require(SceneToken);
    const heights = new IslandHeights();
    const blueprint = generateCityBlueprint((x, z) => heights.heightAt(x, z));
    const collision = new CityCollisionGrid(blueprint, heights);
    const meshes = new CityMeshes(blueprint);
    scene.add(meshes.group);
    ctx.services.provide(WorldToken, collision);
    ctx.services.provide(CityToken, { heights, blueprint, meshes, collision });
    ctx.events.on('game:restart', () => meshes.restore());
    ctx.systems.addFrame({
      name: 'city-beacons',
      phase: FramePhase.Present,
      frame() {
        meshes.update(ctx.loop.simTime);
      },
    });
  },
};
