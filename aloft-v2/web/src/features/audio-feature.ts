import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';
import { FlightAudio } from '../present/audio/flight-audio';
import { ControlsToken } from './controls-feature';
import { FlightToken } from './flight-feature';
import { SettingsToken } from './settings-feature';
import { WorldLookToken } from './world-look-feature';

// v1's synthesised flight sound: wind and pad that follow speed, and one-shots for launch, boom,
// impacts, smashes and splashes. Browsers only allow audio after a user gesture, so the context
// starts (or resumes) on the first pointer or key press. M5 replaces this with the spatial engine.

export const AudioToken = serviceToken<FlightAudio>('audio');

export const audioFeature: Feature = {
  name: 'audio',
  install(ctx) {
    const flight = ctx.services.require(FlightToken);
    const controls = ctx.services.require(ControlsToken);
    const settings = ctx.services.require(SettingsToken);
    const { clouds } = ctx.services.require(WorldLookToken);
    const audio = ctx.services.provide(AudioToken, new FlightAudio({ random: () => ctx.random.stream('audio').next() }));

    const unlock = (): void => {
      void audio.start().then(() => audio.setMuted(!settings.current.sound));
    };
    for (const type of ['pointerdown', 'keydown', 'touchend'] as const) window.addEventListener(type, unlock, { capture: true });
    settings.onChange((next) => audio.setMuted(!next.sound));
    controls.input.on('toggle-sound', () => settings.update({ sound: !settings.current.sound }));

    ctx.events.on('flight:event', (event) => {
      switch (event.type) {
        case 'launch':
          audio.whoosh(1);
          break;
        case 'boom':
          audio.boom();
          break;
        case 'impact':
          if (event.dented) audio.dent(event.strength);
          else audio.thud(event.strength);
          break;
        case 'smash':
          audio.smash(event.strength);
          break;
        case 'splash':
          audio.splash(event.strength);
          break;
        default:
          break;
      }
    });

    ctx.events.on('sparks:event', ({ event }) => {
      if (event.type !== 'collect') return;
      audio.chime(event.streak);
      if (event.allDone) audio.trailComplete(5);
      else if (event.trailDone) audio.trailComplete(3);
    });

    let wasBoosting = false;
    ctx.systems.addFrame({
      name: 'audio',
      phase: FramePhase.Audio,
      frame(realDt) {
        const boosting = flight.active && controls.current.boost;
        if (boosting && !wasBoosting && flight.model.mode === 'flying') audio.whoosh(0.6);
        wasBoosting = boosting;
        const view = flight.view;
        audio.update(realDt, { speed: view.speed, rush: view.surfaceRush, cloud: clouds.immersion(view.position), active: flight.active });
      },
    });
  },
};
