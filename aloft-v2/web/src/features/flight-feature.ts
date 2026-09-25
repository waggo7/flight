import { FlightModel, type FlightEvent } from '../core/flight-model';
import { Quaternion, Vector3 } from '../core/math';
import { lerp, lerpAngle } from '../core/scalar-math';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase, StepPhase } from '../engine/system-phases';
import type { CameraSubject } from '../present/render/chase-camera';
import { ControlsToken } from './controls-feature';
import { WorldToken } from './world-token';

// Runs the flight model in the Hero phase and keeps an interpolated view of it for rendering.

declare module '../engine/event-bus' {
  interface GameEventMap {
    'flight:event': FlightEvent;
  }
}

/** A copy of everything the camera and hero rig read, so two can be blended. */
export class FlightSnapshot implements CameraSubject {
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  readonly forward = new Vector3(0, 0, 1);
  readonly up = new Vector3(0, 1, 0);
  readonly acceleration = new Vector3();
  yaw = 0;
  pitch = 0;
  bank = 0;
  yawRate = 0;
  speed = 0;
  speedShare = 0;
  hoverBlend = 1;
  boostBlend = 0;
  surfaceRush = 0;

  copyFrom(source: FlightModel | FlightSnapshot): void {
    this.position.copy(source.position);
    this.quaternion.copy(source.quaternion);
    this.forward.copy(source.forward);
    this.up.copy(source.up);
    this.acceleration.copy(source.acceleration);
    this.yaw = source.yaw;
    this.pitch = source.pitch;
    this.bank = source.bank;
    this.yawRate = source.yawRate;
    this.speed = source.speed;
    this.speedShare = source.speedShare;
    this.hoverBlend = source.hoverBlend;
    this.boostBlend = source.boostBlend;
    this.surfaceRush = source.surfaceRush;
  }

  blend(a: FlightSnapshot, b: FlightSnapshot, t: number): void {
    this.position.lerpVectors(a.position, b.position, t);
    this.quaternion.slerpQuaternions(a.quaternion, b.quaternion, t);
    this.forward.lerpVectors(a.forward, b.forward, t).normalize();
    this.up.lerpVectors(a.up, b.up, t).normalize();
    this.acceleration.lerpVectors(a.acceleration, b.acceleration, t);
    this.yaw = lerpAngle(a.yaw, b.yaw, t);
    this.pitch = lerp(a.pitch, b.pitch, t);
    this.bank = lerp(a.bank, b.bank, t);
    this.yawRate = lerp(a.yawRate, b.yawRate, t);
    this.speed = lerp(a.speed, b.speed, t);
    this.speedShare = lerp(a.speedShare, b.speedShare, t);
    this.hoverBlend = lerp(a.hoverBlend, b.hoverBlend, t);
    this.boostBlend = lerp(a.boostBlend, b.boostBlend, t);
    this.surfaceRush = lerp(a.surfaceRush, b.surfaceRush, t);
  }
}

export interface FlightService {
  readonly model: FlightModel;
  /** Interpolated for the current frame. Read in Present/Audio/Render phases. */
  readonly view: FlightSnapshot;
  /** When false the hero holds still (title screen, pause). */
  active: boolean;
  respawn(position?: Vector3, yaw?: number): void;
}

export const FlightToken = serviceToken<FlightService>('flight');

export const SPAWN_POSITION = new Vector3(0, 60, 0);

export const flightFeature: Feature = {
  name: 'flight',
  install(ctx) {
    const world = ctx.services.require(WorldToken);
    const controls = ctx.services.require(ControlsToken);
    const model = new FlightModel(world, ctx.content.flight);
    const previous = new FlightSnapshot();
    const current = new FlightSnapshot();
    const view = new FlightSnapshot();

    const service: FlightService = {
      model,
      view,
      active: false,
      respawn(position = SPAWN_POSITION, yaw = 0) {
        model.reset(position, yaw);
        current.copyFrom(model);
        previous.copyFrom(model);
        view.copyFrom(model);
      },
    };
    service.respawn();
    ctx.services.provide(FlightToken, service);

    ctx.systems.addStep({
      name: 'flight',
      phase: StepPhase.Hero,
      step(dt) {
        previous.copyFrom(current);
        if (service.active) model.update(dt, controls.current);
        current.copyFrom(model);
        for (const event of model.takeEvents()) ctx.events.emit('flight:event', event);
      },
    });
    ctx.systems.addFrame({
      name: 'flight-view',
      phase: FramePhase.Present,
      frame(_realDt, alpha) {
        view.blend(previous, current, alpha);
      },
    });
  },
};
