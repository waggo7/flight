import { IDLE_CONTROLS, sanitizeControls, type FlightControls } from '../core/flight-model';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';
import { InputControls } from '../present/input/input-controls';
import { SceneToken } from './scene-feature';

// Samples devices once per frame; the fixed steps read `current`. Tests replace the devices
// with `override`.

export interface ControlsService {
  readonly input: InputControls;
  /** What the sim reads this step. */
  current: FlightControls;
  /** Set by the test API; null = use the devices. */
  override: FlightControls | null;
}

export const ControlsToken = serviceToken<ControlsService>('controls');

export const controlsFeature: Feature = {
  name: 'controls',
  install(ctx) {
    const { canvas } = ctx.services.require(SceneToken);
    const input = new InputControls(canvas, ctx.content.input, ctx.content.actions);
    const service = ctx.services.provide(ControlsToken, { input, current: { ...IDLE_CONTROLS }, override: null });
    ctx.systems.addFrame({
      name: 'controls',
      phase: FramePhase.BeforeSim,
      frame(realDt) {
        input.update(realDt);
        service.current = service.override ? sanitizeControls(service.override) : { ...input.state };
      },
    });
  },
};
