import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';
import { AudioEngine } from '../present/audio/audio-engine';
import { FlightAudio } from '../present/audio/flight-audio';
import { ControlsToken } from './controls-feature';
import { FlightToken } from './flight-feature';
import { SceneToken } from './scene-feature';
import { SettingsToken } from './settings-feature';
import { TimeScaleToken } from './time-scale-feature';
import { WorldLookToken } from './world-look-feature';

// All sound. Browsers only allow audio after a user gesture, so on the first pointer or key press
// one AudioContext is made, shared by the spatial engine (collapses, powers — see
// collapse-audio-feature) and v1's flight sound (wind, pad, whoosh, boom, impacts), which plays
// through the engine's sfx bus so the limiter and ducking cover it too.

export interface AudioService {
  /** Null until the first user gesture. */
  readonly engine: AudioEngine | null;
  readonly flight: FlightAudio | null;
}

export const AudioToken = serviceToken<AudioService>('audio');

type AudioContextConstructor = typeof AudioContext;

export const audioFeature: Feature = {
  name: 'audio',
  install(ctx) {
    const flight = ctx.services.require(FlightToken);
    const controls = ctx.services.require(ControlsToken);
    const settings = ctx.services.require(SettingsToken);
    const { clouds } = ctx.services.require(WorldLookToken);
    const { camera } = ctx.services.require(SceneToken);
    const time = ctx.services.require(TimeScaleToken);
    const service: { engine: AudioEngine | null; flight: FlightAudio | null } = { engine: null, flight: null };
    ctx.services.provide(AudioToken, service);
    const random = (): number => ctx.random.stream('audio').next();

    const setMuted = (muted: boolean): void => {
      service.flight?.setMuted(muted);
      if (service.engine) service.engine.master.gain.setTargetAtTime(muted ? 0 : 0.9, service.engine.now, 0.05);
    };
    const unlock = (): void => {
      if (!service.engine) {
        const Context = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext) as AudioContextConstructor | undefined;
        if (!Context) return;
        const audioContext = new Context({ latencyHint: 'interactive' });
        service.engine = new AudioEngine(audioContext, { random, maxVoices: ctx.profile === 'phone' ? 16 : 32 });
        service.flight = new FlightAudio({ context: audioContext, destination: service.engine.buses.sfx, random });
      }
      void service.flight!.start().then(() => setMuted(!settings.current.sound));
    };
    for (const type of ['pointerdown', 'keydown', 'touchend'] as const) window.addEventListener(type, unlock, { capture: true });
    settings.onChange((next) => setMuted(!next.sound));
    controls.input.on('toggle-sound', () => settings.update({ sound: !settings.current.sound }));

    ctx.events.on('flight:event', (event) => {
      const audio = service.flight;
      if (!audio) return;
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

    let wasBoosting = false;
    const right = { x: 1, y: 0, z: 0 };
    ctx.systems.addFrame({
      name: 'audio',
      phase: FramePhase.Audio,
      frame(realDt) {
        const boosting = flight.active && controls.current.boost;
        if (boosting && !wasBoosting && flight.model.mode === 'flying') service.flight?.whoosh(0.6);
        wasBoosting = boosting;
        const view = flight.view;
        service.flight?.update(realDt, { speed: view.speed, rush: view.surfaceRush, cloud: clouds.immersion(view.position), active: flight.active });
        const engine = service.engine;
        if (!engine) return;
        // The listener is the camera; its right vector pans the world.
        const e = camera.matrixWorld.elements;
        right.x = e[0]!;
        right.y = e[1]!;
        right.z = e[2]!;
        engine.setListener(camera.position, right, Math.max(0, view.groundClearance));
        engine.setSlowMotion(time.paused ? 0 : 1 - Math.min(1, time.scale / 0.9));
      },
    });
  },
};
