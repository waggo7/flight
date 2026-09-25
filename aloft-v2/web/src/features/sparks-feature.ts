import { Vector3 } from 'three';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';
import { SparkTrails, type SparkEvent } from '../present/render/spark-trails';
import { CityToken } from './city-feature';
import { FlightToken } from './flight-feature';
import { SceneToken } from './scene-feature';
import { WorldLookToken } from './world-look-feature';

// v1's collectible spark trails (through the avenues, round the twisting tower, over the spire,
// through the biggest cloud). Pickups go out as `sparks:event`; the HUD, audio and effects react.

declare module '../engine/event-bus' {
  interface GameEventMap {
    'sparks:event': { event: SparkEvent; collected: number; total: number; trails: number };
  }
}

export const SparksToken = serviceToken<SparkTrails>('sparks');

const FAR_AWAY = new Vector3(1e6, 1e6, 1e6);

export const sparksFeature: Feature = {
  name: 'sparks',
  install(ctx) {
    const { scene, camera } = ctx.services.require(SceneToken);
    const { heights, blueprint, world } = ctx.services.require(CityToken);
    const { clouds } = ctx.services.require(WorldLookToken);
    const flight = ctx.services.require(FlightToken);
    const sparks = new SparkTrails(
      {
        isClear: (position, radius) => world.isClear(position, radius),
        heightAt: (x, z) => heights.heightAt(x, z),
        largestCloudNear: (x, z, maxDistance) => clouds.largestCloudNear(x, z, maxDistance),
        cloudDrift: clouds.drift,
        landmarks: blueprint.landmarks,
      },
      { random: () => ctx.random.stream('sparks').next() },
    );
    scene.add(sparks.group);
    ctx.services.provide(SparksToken, sparks);
    ctx.events.on('game:restart', () => sparks.reset());

    ctx.systems.addFrame({
      name: 'sparks',
      phase: FramePhase.Present,
      frame(realDt) {
        const simDt = realDt * ctx.loop.timeScale;
        if (!flight.active) {
          sparks.update(0, ctx.loop.simTime, FAR_AWAY, camera);
          return;
        }
        for (const event of sparks.update(simDt, ctx.loop.simTime, flight.view.position, camera)) {
          ctx.events.emit('sparks:event', { event, collected: sparks.collected, total: sparks.total, trails: sparks.trails.length });
        }
      },
    });
  },
};
