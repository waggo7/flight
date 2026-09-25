import { damp } from '../core/scalar-math';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';
import { CameraToken } from './camera-feature';
import { ControlsToken } from './controls-feature';
import { FlightToken } from './flight-feature';
import { HudToken } from './hud-feature';
import { SettingsToken, type PlayerSettings } from './settings-feature';
import { TimeScaleToken } from './time-scale-feature';

// Title → flying ⇄ paused, and Restart (a short fade, then the world rebuilt and the hero back
// at the start). Owns which screen shows, and applies the player settings to input, camera
// and HUD (audio applies its own).

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
  /** Rebuild the world at once (no fade). */
  restart(): void;
}

export const GameFlowToken = serviceToken<GameFlowService>('game-flow');

const RESTART_FADE_MS = 320;

export const gameFlowFeature: Feature = {
  name: 'game-flow',
  install(ctx) {
    const flight = ctx.services.require(FlightToken);
    const controls = ctx.services.require(ControlsToken);
    const rig = ctx.services.require(CameraToken);
    const time = ctx.services.require(TimeScaleToken);
    const hud = ctx.services.require(HudToken);
    const settings = ctx.services.require(SettingsToken);
    const input = controls.input;
    let state: GameState = 'title';
    let restarting = false;

    const setState = (next: GameState): void => {
      state = next;
      flight.active = next === 'flying';
      input.setEnabled(next === 'flying');
      time.setPaused(next === 'paused');
      if (next === 'flying') hud.showFlight();
      else if (next === 'paused') hud.showPause();
      ctx.events.emit('game:state', { state: next });
    };
    const blur = (): void => (document.activeElement as HTMLElement | null)?.blur?.();

    const service: GameFlowService = {
      get state() {
        return state;
      },
      start() {
        if (state !== 'title') return;
        setState('flying');
        flight.model.launch();
        blur();
      },
      pause() {
        if (state === 'flying') setState('paused');
      },
      resume() {
        if (state !== 'paused') return;
        setState('flying');
        blur();
      },
      restart() {
        flight.respawn();
        rig.snapTo(flight.view);
        ctx.random.reset();
        ctx.events.emit('game:restart', {});
        setState('flying');
      },
    };
    ctx.services.provide(GameFlowToken, service);

    const restartWithFade = (): void => {
      if (state === 'title' || restarting) return;
      restarting = true;
      input.setEnabled(false);
      const finish = (): void => {
        service.restart();
        restarting = false;
        hud.setFade(false);
        const launchKey = input.device === 'touch' ? 'Hold the right side' : input.device === 'gamepad' ? 'Hold A' : 'Hold click or Space';
        hud.toast(`Fresh start · ${launchKey} to launch`, 4);
        blur();
      };
      if (ctx.testMode) {
        finish();
        return;
      }
      hud.setFade(true);
      setTimeout(finish, RESTART_FADE_MS);
    };

    const applySettings = (current: Readonly<PlayerSettings>): void => {
      input.sensitivity = current.sensitivity;
      input.invertY = current.invertY;
      rig.setMode(current.firstPerson ? 'first' : 'chase');
      hud.applySettings(current);
    };
    applySettings(settings.current);
    settings.onChange(applySettings);

    hud.on('start', () => service.start());
    hud.on('resume', () => service.resume());
    hud.on('pause', () => service.pause());
    hud.on('restart', restartWithFade);
    hud.on('settings', (next) => settings.update(next));
    hud.on('touchButton', (name, pressed) => input.setTouchButton(name, pressed));
    input.on('confirm', () => (state === 'title' ? service.start() : service.resume()));
    input.on('pause', () => (state === 'flying' ? service.pause() : service.resume()));
    input.on('restart', restartWithFade);
    input.on('toggle-view', () => settings.update({ firstPerson: !settings.current.firstPerson }));
    input.on('toggle-keys', () => settings.update({ showKeys: !settings.current.showKeys }));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) service.pause();
    });

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
