import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';
import { FreeLook, type LookInput } from '../core/view-state';
import { ChaseCamera } from '../present/render/chase-camera';
import { ControlsToken } from './controls-feature';
import { FlightToken } from './flight-feature';
import { SceneToken } from './scene-feature';
import { WorldToken } from './world-token';

// Frames the interpolated hero every frame. Camera time follows sim time, so hit-stop and
// slow motion slow the camera too.

const IDLE_LOOK: LookInput = { active: false, x: 0, y: 0 };

export const CameraToken = serviceToken<ChaseCamera>('camera-rig');

export const cameraFeature: Feature = {
  name: 'camera',
  install(ctx) {
    const { camera } = ctx.services.require(SceneToken);
    const flight = ctx.services.require(FlightToken);
    const world = ctx.services.require(WorldToken);
    const controls = ctx.services.require(ControlsToken);
    const rig = ctx.services.provide(CameraToken, new ChaseCamera(camera, ctx.content.camera));
    const freeLook = new FreeLook(ctx.content.camera.freeLook);
    rig.snapTo(flight.view);
    ctx.events.on('game:restart', () => {
      freeLook.reset();
      rig.front = false;
    });
    ctx.systems.addFrame({
      name: 'camera',
      phase: FramePhase.Present,
      frame(realDt) {
        // Free look runs on real time so it stays responsive in slow motion.
        freeLook.step(realDt, flight.active ? controls.input.look : IDLE_LOOK);
        rig.lookYaw = freeLook.yaw;
        rig.lookPitch = freeLook.pitch;
        rig.update(realDt * ctx.loop.timeScale, flight.view, world);
      },
    });
  },
};
