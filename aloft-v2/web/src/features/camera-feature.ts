import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';
import { ChaseCamera } from '../present/render/chase-camera';
import { FlightToken } from './flight-feature';
import { SceneToken } from './scene-feature';
import { WorldToken } from './world-token';

// Frames the interpolated hero every frame. Camera time follows sim time, so hit-stop and
// slow motion slow the camera too.

export const CameraToken = serviceToken<ChaseCamera>('camera-rig');

export const cameraFeature: Feature = {
  name: 'camera',
  install(ctx) {
    const { camera } = ctx.services.require(SceneToken);
    const flight = ctx.services.require(FlightToken);
    const world = ctx.services.require(WorldToken);
    const rig = ctx.services.provide(CameraToken, new ChaseCamera(camera, ctx.content.camera));
    rig.snapTo(flight.view);
    ctx.systems.addFrame({
      name: 'camera',
      phase: FramePhase.Present,
      frame(realDt) {
        rig.update(realDt * ctx.loop.timeScale, flight.view, world);
      },
    });
  },
};
