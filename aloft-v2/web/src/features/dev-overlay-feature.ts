import type { Feature } from '../engine/game-context';
import { FramePhase } from '../engine/system-phases';
import { ControlsToken } from './controls-feature';
import { FlightToken } from './flight-feature';

// F3 / backquote: frame rate, sim steps, speed and altitude. Physics and destruction counters
// join from M2.

export const devOverlayFeature: Feature = {
  name: 'dev-overlay',
  install(ctx) {
    const flight = ctx.services.require(FlightToken);
    const controls = ctx.services.require(ControlsToken);
    const panel = document.createElement('pre');
    panel.className = 'dev-overlay';
    panel.hidden = true;
    document.body.append(panel);
    controls.input.on('toggle-dev', () => (panel.hidden = !panel.hidden));

    let frames = 0;
    let elapsed = 0;
    let fps = 0;
    let lastSteps = ctx.loop.stepCount;
    let stepsPerSecond = 0;
    ctx.systems.addFrame({
      name: 'dev-overlay',
      phase: FramePhase.Render,
      frame(realDt) {
        frames++;
        elapsed += realDt;
        if (elapsed >= 0.5) {
          fps = frames / elapsed;
          stepsPerSecond = (ctx.loop.stepCount - lastSteps) / elapsed;
          lastSteps = ctx.loop.stepCount;
          frames = 0;
          elapsed = 0;
          if (!panel.hidden) {
            const m = flight.model;
            panel.textContent = [
              `fps ${fps.toFixed(0)}   sim ${stepsPerSecond.toFixed(0)} steps/s   scale ${ctx.loop.timeScale.toFixed(2)}`,
              `speed ${m.speed.toFixed(1)} m/s   alt ${m.position.y.toFixed(0)} m   ${m.mode}`,
              `profile ${ctx.profile}`,
            ].join('\n');
          }
        }
      },
    });
  },
};
