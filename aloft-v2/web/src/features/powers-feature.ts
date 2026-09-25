import { Vector3 } from 'three';
import { clamp } from '../core/scalar-math';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { StepPhase, FramePhase } from '../engine/system-phases';
import { crack, groundBoom, modalImpact, rubbleGrains } from '../present/audio/collapse-recipes';
import { PowersHud } from '../present/ui/powers-hud';
import { PowerSystem } from '../sim/power-system';
import { AudioToken } from './audio-feature';
import { CameraToken } from './camera-feature';
import { CityToken } from './city-feature';
import { ControlsToken } from './controls-feature';
import { DestructionToken } from './destruction-feature';
import { EffectsToken } from './effects-feature';
import { FlightToken } from './flight-feature';
import { SceneToken } from './scene-feature';

// Ground slam (Q · gamepad Y · touch Slam) and grab and throw (E · gamepad X · touch Grab): the
// power system runs in the Powers phase, owns the hero's motion during a slam, and throws where
// the camera looks. Its events become the shockwave ring, the street dust ring, the ground boom
// and the camera's punch.

export const PowersToken = serviceToken<PowerSystem>('powers');

export const powersFeature: Feature = {
  name: 'powers',
  install(ctx) {
    const city = ctx.services.require(CityToken);
    const flight = ctx.services.require(FlightToken);
    const controls = ctx.services.require(ControlsToken);
    const destruction = ctx.services.require(DestructionToken);
    const { effects, dust, motion } = ctx.services.require(EffectsToken);
    const rig = ctx.services.require(CameraToken);
    const audio = ctx.services.require(AudioToken);
    const { camera } = ctx.services.require(SceneToken);

    const powers = new PowerSystem(city.physics, city.world, destruction, city.blueprint, flight.model, ctx.content.flight, ctx.content.powers, ctx.events);
    ctx.services.provide(PowersToken, powers);
    city.world.smash = (hit, point, _normal, velocity, impact) => powers.smash(hit, point, velocity, impact);
    flight.override = (dt) => powers.moveHero(dt);

    controls.input.on('slam', () => {
      if (flight.active) powers.pressSlam();
    });
    controls.input.on('grab', () => {
      if (flight.active) powers.pressGrab();
    });
    ctx.systems.addStep({ name: 'powers', phase: StepPhase.Powers, step: (dt) => powers.step(dt) });
    const hud = new PowersHud(document.getElementById('app') ?? document.body, (power) => {
      if (!flight.active) return;
      if (power === 'slam') powers.pressSlam();
      else powers.pressGrab();
    });
    const aim = new Vector3();
    ctx.systems.addFrame({
      name: 'powers-aim',
      phase: FramePhase.Present,
      frame() {
        camera.getWorldDirection(aim);
        powers.aim.copy(aim);
        hud.update({
          slamCooldown: powers.slam.cooldownShare,
          slamActive: powers.slam.controlsHero,
          holding: powers.held !== null,
          grabBusy: powers.grab.phase === 'windup' || powers.grab.phase === 'release',
        });
      },
    });
    ctx.events.on('game:restart', () => powers.reset());

    const up = new Vector3(0, 1, 0);
    const at = new Vector3();
    ctx.events.on('power:dive', () => {
      rig.kick(6 * motion);
      audio.flight?.whoosh(1);
    });
    ctx.events.on('power:slam', ({ position, radius }) => {
      at.set(position.x, position.y, position.z);
      effects.onBoom(at, up);
      const share = clamp(radius / 60, 0.3, 1);
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        dust.puff(position.x + Math.cos(a) * 4, position.y, position.z + Math.sin(a) * 4, {
          size: 8 + 8 * share, growth: 3, life: 6, rise: 0.4, vx: Math.cos(a) * (10 + 14 * share), vz: Math.sin(a) * (10 + 14 * share), alpha: 0.55, darkness: 0.15,
        });
      }
      rig.shake((0.5 + 0.4 * share) * motion);
      rig.rumble(0.7 * share * motion);
      rig.kick(8 * share * motion);
      const engine = audio.engine;
      if (engine) {
        groundBoom(engine, position, 120 + 180 * share);
        crack(engine, position, 1);
        rubbleGrains(engine, position, 300, 1.8, 0.8);
      }
    });
    ctx.events.on('power:grab', ({ position, mass }) => {
      if (audio.engine) modalImpact(audio.engine, position, 'concrete', clamp(Math.cbrt(mass / 1600), 1, 8), 0.6);
    });
    ctx.events.on('power:throw', () => {
      audio.flight?.whoosh(0.8);
      rig.kick(3 * motion);
    });
  },
};
