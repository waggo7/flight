import { AdditiveBlending, Color, Mesh, MeshBasicMaterial, RingGeometry, Vector3 } from 'three';
import { clamp } from '../core/scalar-math';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { StepPhase, FramePhase } from '../engine/system-phases';
import { crack, groundBoom, modalImpact, rubbleGrains } from '../present/audio/collapse-recipes';
import { PowersHud } from '../present/ui/powers-hud';
import { VisorHud } from '../present/ui/visor-hud';
import { viewVisibility } from '../core/view-state';
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
    const fx = ctx.services.require(EffectsToken);
    const { effects, dust } = fx;
    const rig = ctx.services.require(CameraToken);
    const audio = ctx.services.require(AudioToken);
    const { camera, scene } = ctx.services.require(SceneToken);

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
    const visor = new VisorHud(document.getElementById('app') ?? document.body);
    const grabTarget = new Vector3();
    const marker = new Mesh(
      new RingGeometry(3.2, 4.2, 48).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: new Color(4, 1.6, 0.6), transparent: true, opacity: 0.7, depthWrite: false, blending: AdditiveBlending }),
    );
    marker.visible = false;
    marker.renderOrder = 5;
    scene.add(marker);
    ctx.systems.addFrame({
      name: 'powers-aim',
      phase: FramePhase.Present,
      frame(realDt) {
        camera.getWorldDirection(aim);
        powers.aim.copy(aim);
        hud.update({
          slamCooldown: powers.slam.cooldownShare,
          slamActive: powers.slam.controlsHero,
          holding: powers.held !== null,
          grabBusy: powers.grab.phase === 'windup' || powers.grab.phase === 'release',
        });
        const candidate = flight.active ? powers.grabCandidate() : null;
        visor.update({
          visibility: viewVisibility(rig.firstPersonBlend).arms,
          speed: flight.view.speed,
          altitude: flight.view.groundClearance,
          slamCooldown: powers.slam.cooldownShare,
          holding: powers.held !== null,
          grabTarget: candidate ? grabTarget.set(candidate.centre.x, candidate.centre.y, candidate.centre.z) : null,
          camera,
        });
        // The slam's landing spot, projected on the ground while it winds up and dives.
        const landing = powers.slamMarker();
        marker.visible = landing !== null;
        if (landing) {
          marker.position.set(landing.x, landing.y, landing.z);
          marker.rotation.z += realDt * 2.5;
          (marker.material as MeshBasicMaterial).opacity = 0.55 + 0.25 * Math.sin(ctx.loop.simTime * 18);
        }
      },
    });
    ctx.events.on('game:restart', () => powers.reset());

    const up = new Vector3(0, 1, 0);
    const at = new Vector3();
    ctx.events.on('power:dive', () => {
      rig.kick(6 * fx.motion);
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
      rig.shake((0.5 + 0.4 * share) * fx.motion);
      rig.rumble(0.7 * share * fx.motion);
      rig.kick(8 * share * fx.motion);
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
      rig.kick(3 * fx.motion);
    });
  },
};
