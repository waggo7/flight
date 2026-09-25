import { Vector3 } from 'three';
import { damp, smoothstep } from '../core/scalar-math';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';
import { DustPlumes } from '../present/render/effects/dust-plumes';
import { SpeedEffects } from '../present/render/effects/speed-effects';
import { CameraToken } from './camera-feature';
import { FlightToken } from './flight-feature';
import { SceneToken } from './scene-feature';
import { TimeScaleToken } from './time-scale-feature';

// How flight feels (v1): air streaks, the launch and sonic-boom shockwaves, impact bursts, sea
// spray, dust plumes, camera kicks and shakes, the hit-stop on a smash, and the post pass's
// speed blur, flash and dust veil.

export interface EffectsService {
  readonly dust: DustPlumes;
  readonly effects: SpeedEffects;
  /** A brief white flash (0..1), already scaled for reduced motion by the caller. */
  flash(amount: number): void;
  /** 1, or less when the player asked for reduced motion. */
  readonly motion: number;
}

export const EffectsToken = serviceToken<EffectsService>('effects');

const DUST_WIND = new Vector3(2.2, 0, 0.7);

export const effectsFeature: Feature = {
  name: 'effects',
  install(ctx) {
    const sceneService = ctx.services.require(SceneToken);
    const { scene, camera, post, reducedMotion } = sceneService;
    const flight = ctx.services.require(FlightToken);
    const rig = ctx.services.require(CameraToken);
    const time = ctx.services.require(TimeScaleToken);
    const dust = new DustPlumes(340, () => ctx.random.stream('dust').next());
    scene.add(dust.mesh);
    const effects = new SpeedEffects(scene, dust);
    const motion = reducedMotion ? 0.35 : 1;
    let flash = 0;
    let dustVeil = 0;
    ctx.services.provide(EffectsToken, {
      dust, effects, motion,
      flash(amount) {
        flash = Math.max(flash, amount);
      },
    });

    const { hitStop } = ctx.content.simulation;
    ctx.events.on('flight:event', (event) => {
      const model = flight.model;
      switch (event.type) {
        case 'launch':
          effects.onLaunch(model.position, model.forward);
          rig.kick(5 * motion);
          rig.shake(0.25 * motion);
          break;
        case 'boom':
          effects.onBoom(model.position, model.forward);
          rig.kick(9 * motion);
          rig.shake(0.55 * motion);
          flash = Math.max(flash, 0.28 * motion);
          break;
        case 'impact':
          effects.onImpact(event.point, event.normal, event.strength);
          rig.shake((0.25 + event.strength * 0.5) * motion);
          break;
        case 'smash':
          // A split-second freeze sells the weight of bursting through.
          time.hitStop(hitStop.seconds * (event.kind === 'topple' ? 1 : 0.5) * motion, hitStop.timeScale);
          rig.shake((0.55 + event.strength * 0.4) * motion);
          rig.kick(7 * motion);
          flash = Math.max(flash, 0.1 * motion);
          break;
        case 'splash':
          effects.onSplash(event.point, event.strength);
          rig.shake(0.2 * motion);
          break;
        default:
          break;
      }
    });
    ctx.events.on('sparks:event', ({ event }) => {
      if (event.type === 'collect') effects.burstSparks(event.position);
    });
    ctx.events.on('game:restart', () => {
      dust.clear();
      effects.clear();
      flash = 0;
    });

    ctx.systems.addFrame({
      name: 'effects',
      phase: FramePhase.Present,
      frame(realDt) {
        const simDt = realDt * ctx.loop.timeScale;
        const view = flight.view;
        effects.update(simDt, ctx.loop.simTime, { camera, flight: view, projectionScale: sceneService.projectionScale });
        dust.update(simDt, DUST_WIND);
        dustVeil = damp(dustVeil, dust.active ? dust.densityAt(camera.position) * 0.7 : 0, 5, realDt);
        flash = damp(flash, 0, 5, realDt);
        const blurMotion = reducedMotion ? 0.3 : 1;
        post.settings.uSpeedBlur.value = (smoothstep(60, 140, view.speed) * view.boostBlend * 0.55 + view.surfaceRush * 0.18) * blurMotion;
        post.settings.uDust.value = dustVeil;
        post.settings.uFlash.value = flash;
      },
    });
  },
};
