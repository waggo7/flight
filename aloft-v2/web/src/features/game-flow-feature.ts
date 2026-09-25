import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';
import { damp } from '../core/scalar-math';
import { CameraToken } from './camera-feature';
import { ControlsToken } from './controls-feature';
import { FlightToken } from './flight-feature';
import { TimeScaleToken } from './time-scale-feature';

// Title → flying ⇄ paused, restart, and the view toggle. M1 ports v1's full HUD on top.

export type GameState = 'title' | 'flying' | 'paused';

declare module '../engine/event-bus' {
  interface GameEventMap {
    'game:state': { state: GameState };
    'game:restart': Record<string, never>;
  }
}

export interface GameFlowService {
  readonly state: GameState;
  start(): void;
  pause(): void;
  resume(): void;
  restart(): void;
  toggleView(): void;
}

export const GameFlowToken = serviceToken<GameFlowService>('game-flow');

export const gameFlowFeature: Feature = {
  name: 'game-flow',
  install(ctx) {
    const flight = ctx.services.require(FlightToken);
    const controls = ctx.services.require(ControlsToken);
    const rig = ctx.services.require(CameraToken);
    const time = ctx.services.require(TimeScaleToken);
    let state: GameState = 'title';

    const setState = (next: GameState): void => {
      state = next;
      flight.active = next === 'flying';
      controls.input.setEnabled(next === 'flying');
      time.setPaused(next === 'paused');
      document.body.dataset.state = next;
      ctx.events.emit('game:state', { state: next });
    };

    const service: GameFlowService = {
      get state() {
        return state;
      },
      start() {
        if (state !== 'title') return;
        setState('flying');
        flight.model.launch();
      },
      pause() {
        if (state === 'flying') setState('paused');
      },
      resume() {
        if (state === 'paused') setState('flying');
      },
      restart() {
        flight.respawn();
        rig.snapTo(flight.view);
        ctx.random.reset();
        ctx.events.emit('game:restart', {});
        setState('flying');
      },
      toggleView() {
        rig.setMode(rig.mode === 'first' ? 'chase' : 'first');
      },
    };
    ctx.services.provide(GameFlowToken, service);
    setState('title');

    const input = controls.input;
    input.on('confirm', () => service.start());
    input.on('pause', () => (state === 'paused' ? service.resume() : service.pause()));
    input.on('restart', () => service.restart());
    input.on('toggle-view', () => service.toggleView());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) service.pause();
    });
    document.getElementById('start')?.addEventListener('click', () => service.start());

    // The title camera swings out to the chase position once flying (v1's easing).
    ctx.systems.addFrame({
      name: 'title-camera',
      phase: FramePhase.Present,
      frame(realDt) {
        const target = state === 'title' ? 1 : 0;
        rig.intro = damp(rig.intro, target, target === 0 ? 1.7 : 3, realDt);
      },
    });
  },
};
