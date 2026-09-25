import { damp } from '../core/scalar-math';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';

// Owns loop.timeScale so pause, hit-stop and slow motion never fight: paused wins, then the
// strongest active slow-down, then a quick recovery to real time (v1's damp at 9/s).

export interface TimeScaleService {
  setPaused(paused: boolean): void;
  /** A split-second near-freeze that sells a big hit (v1: 0.13 s at 0.12×). */
  hitStop(seconds: number, scale: number): void;
  /** Longer cinematic slow motion (the first big collapse). */
  slowMotion(seconds: number, scale: number): void;
  readonly paused: boolean;
  /** Sim time runs at this share of real time right now. */
  readonly scale: number;
}

export const TimeScaleToken = serviceToken<TimeScaleService>('time-scale');

export const timeScaleFeature: Feature = {
  name: 'time-scale',
  install(ctx) {
    let paused = false;
    let hitStopLeft = 0;
    let hitStopScale = 1;
    let slowLeft = 0;
    let slowScale = 1;
    let scale = 1;
    const service: TimeScaleService = {
      setPaused(next) {
        paused = next;
        ctx.loop.timeScale = next ? 0 : scale;
      },
      hitStop(seconds, value) {
        hitStopLeft = Math.max(hitStopLeft, seconds);
        hitStopScale = Math.min(hitStopScale, value);
      },
      slowMotion(seconds, value) {
        slowLeft = Math.max(slowLeft, seconds);
        slowScale = Math.min(slowScale, value);
      },
      get paused() {
        return paused;
      },
      get scale() {
        return paused ? 0 : scale;
      },
    };
    ctx.services.provide(TimeScaleToken, service);
    ctx.events.on('game:restart', () => {
      hitStopLeft = slowLeft = 0;
      hitStopScale = slowScale = scale = 1;
    });
    ctx.systems.addFrame({
      name: 'time-scale',
      phase: FramePhase.BeforeSim,
      frame(realDt) {
        if (paused) {
          ctx.loop.timeScale = 0;
          return;
        }
        hitStopLeft = Math.max(0, hitStopLeft - realDt);
        slowLeft = Math.max(0, slowLeft - realDt);
        if (hitStopLeft <= 0) hitStopScale = 1;
        if (slowLeft <= 0) slowScale = 1;
        const target = Math.min(hitStopScale, slowScale);
        scale = target < scale ? target : damp(scale, target, 9, realDt);
        ctx.loop.timeScale = scale;
      },
    });
  },
};
