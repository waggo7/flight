import { DirectionalLight, HemisphereLight, Vector3 } from 'three';
import { clamp, damp } from '../core/scalar-math';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';
import { atmosphereUniforms, PALETTE, SUN_DIRECTION } from '../present/render/world/atmosphere';
import { CloudField } from '../present/render/world/cloud-field';
import { createIslandTerrain } from '../present/render/world/island-terrain-mesh';
import { createOcean } from '../present/render/world/ocean-surface';
import { createSkyDome, createSkyEnvironment } from '../present/render/world/sky-dome';
import { CityToken } from './city-feature';
import { FlightToken } from './flight-feature';
import { SceneToken } from './scene-feature';

// Everything around the city (v1's look): sky dome and environment light, island terrain and
// trees, the ocean, the cloud field, the low sun whose shadow box follows the hero, and the
// cloud veil when the camera flies through a cloud.

export interface WorldLookService {
  readonly clouds: CloudField;
  readonly sun: DirectionalLight;
}

export const WorldLookToken = serviceToken<WorldLookService>('world-look');

export const worldLookFeature: Feature = {
  name: 'world-look',
  install(ctx) {
    const { scene, renderer, camera, post, quality } = ctx.services.require(SceneToken);
    const { heights } = ctx.services.require(CityToken);
    const flight = ctx.services.require(FlightToken);

    const terrain = createIslandTerrain(heights);
    const ocean = createOcean(terrain.createDepthTexture());
    const clouds = new CloudField({ detail: quality.cloudDetail, count: quality.cloudCount });
    scene.add(createSkyDome(), terrain.mesh, terrain.trees, ocean.mesh, clouds.mesh);
    scene.environment = createSkyEnvironment(renderer);
    scene.environmentIntensity = 0.85;

    const sun = new DirectionalLight(PALETTE.sunLight, 3.1);
    sun.castShadow = true;
    sun.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 3800;
    sun.shadow.bias = -0.00008;
    sun.shadow.normalBias = 0.6;
    sun.shadow.radius = 2.5;
    scene.add(sun, sun.target, new HemisphereLight('#a4b8e8', '#5b473b', 0.3));
    ctx.services.provide(WorldLookToken, { clouds, sun });

    // The shadow box follows the hero, grows with altitude, and snaps to shadow-map texels so
    // edges don't crawl.
    const lightForward = SUN_DIRECTION.clone().negate();
    const lightRight = new Vector3().crossVectors(lightForward, new Vector3(0, 1, 0)).normalize();
    const lightUp = new Vector3().crossVectors(lightRight, lightForward).normalize();
    const focus = new Vector3();
    const followSun = (): void => {
      const view = flight.view;
      const altitude = Math.max(0, view.position.y - 40);
      const extent = Math.round(clamp(180 + altitude * 0.55, 180, 640) / 40) * 40;
      const shadowCamera = sun.shadow.camera;
      if (shadowCamera.right !== extent) {
        shadowCamera.left = -extent;
        shadowCamera.right = extent;
        shadowCamera.top = extent;
        shadowCamera.bottom = -extent;
        shadowCamera.updateProjectionMatrix();
      }
      focus.copy(view.position).addScaledVector(view.forward, 40);
      const texel = (2 * extent) / sun.shadow.mapSize.x;
      const x = Math.round(focus.dot(lightRight) / texel) * texel;
      const y = Math.round(focus.dot(lightUp) / texel) * texel;
      const z = focus.dot(lightForward);
      focus.copy(lightRight).multiplyScalar(x).addScaledVector(lightUp, y).addScaledVector(lightForward, z);
      sun.target.position.copy(focus);
      sun.position.copy(focus).addScaledVector(SUN_DIRECTION, 1800);
      sun.target.updateMatrixWorld();
    };

    let cloudVeil = 0;
    ctx.systems.addFrame({
      name: 'world-look',
      phase: FramePhase.Present,
      frame(realDt) {
        const simDt = realDt * ctx.loop.timeScale;
        atmosphereUniforms.uTime.value = ctx.loop.simTime;
        ocean.follow(camera);
        clouds.update(simDt, flight.view.position, flight.view.velocity);
        followSun();
        cloudVeil = damp(cloudVeil, clouds.immersion(camera.position) * 0.82, 7, realDt);
        post.settings.uCloud.value = cloudVeil;
        post.settings.uTime.value = ctx.loop.simTime;
      },
    });
  },
};
