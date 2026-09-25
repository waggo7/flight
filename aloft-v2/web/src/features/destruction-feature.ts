import { clamp } from '../core/scalar-math';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase, StepPhase } from '../engine/system-phases';
import { DestructionView } from '../present/render/city/destruction-view';
import { CollapseEffects } from '../present/render/effects/collapse-effects';
import { DestructionSystem } from '../sim/destruction-system';
import { CameraToken } from './camera-feature';
import { CityToken } from './city-feature';
import { EffectsToken } from './effects-feature';
import { HudToken } from './hud-feature';
import { SceneToken } from './scene-feature';
import { SettingsToken } from './settings-feature';
import { TimeScaleToken } from './time-scale-feature';

// Buildings that break: the hero's smash goes to the destruction system (rules decide, Rapier
// moves), its pieces are drawn by the destruction view, and its events turn into dust, camera
// shake, the first collapse's slow motion and the "Timber!" toast (sound: collapse-audio-feature).

export const DestructionToken = serviceToken<DestructionSystem>('destruction');

export const destructionFeature: Feature = {
  name: 'destruction',
  install(ctx) {
    const city = ctx.services.require(CityToken);
    const scene = ctx.services.require(SceneToken);
    const { camera } = scene;
    const fx = ctx.services.require(EffectsToken);
    const { dust } = fx;
    const rig = ctx.services.require(CameraToken);
    const time = ctx.services.require(TimeScaleToken);
    const hud = ctx.services.require(HudToken);
    const settings = ctx.services.require(SettingsToken);

    const system = new DestructionSystem(city.physics, city.blueprint, ctx.content.destruction, {
      profile: ctx.profile,
      heroRadius: ctx.content.flight.radius,
      events: ctx.events,
      random: () => ctx.random.stream('destruction'),
      onBurst: (building) => city.world.allowPassThrough(building, 0.25),
    });
    ctx.services.provide(DestructionToken, system);
    city.world.smash = (hit, point, _normal, velocity, impact) => system.heroHit(hit, point, velocity, impact);
    system.enabled = settings.current.destruction;
    settings.onChange((next) => (system.enabled = next.destruction));
    const view = new DestructionView(system, city.meshes, city.blueprint);
    const collapse = new CollapseEffects(dust, () => ctx.random.stream('collapse-effects').next(), { glass: scene.quality.glassShards, chips: scene.quality.concreteChips });
    scene.scene.add(collapse.glass.points, collapse.chips.points);

    ctx.systems.addStep({ name: 'destruction-before', phase: StepPhase.DestructionApply, step: () => system.beforeStep() });
    ctx.systems.addStep({ name: 'destruction-after', phase: StepPhase.Contacts, step: (dt) => system.afterStep(dt) });
    ctx.systems.addFrame({
      name: 'destruction-view',
      phase: FramePhase.Present,
      frame: (realDt, alpha) => {
        view.sync(alpha, camera.position);
        collapse.update(realDt * ctx.loop.timeScale, scene.projectionScale);
      },
    });
    // The city feature restores the pristine world first (it installed earlier).
    ctx.events.on('game:restart', () => {
      system.reset();
      collapse.clear();
    });

    const distanceTo = (p: { x: number; y: number; z: number }): number => Math.hypot(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z);

    ctx.events.on('destruction:damage', ({ crushed, style, direction }) => collapse.crushed(crushed, style, direction));
    ctx.events.on('destruction:failure', ({ first }) => {
      if (!first) return;
      hud.toast('Timber!');
      time.slowMotion(1.1 * fx.motion, 0.35);
      rig.kick(6 * fx.motion);
    });
    ctx.events.on('destruction:impact', ({ position, energy, ground }) => {
      const distance = distanceTo(position);
      // Two bands: a sharp knock for close hits, a heavy low rumble that carries further.
      const loud = Math.log10(Math.max(energy, 1e6) / 1e6);
      rig.shake(clamp(loud * 0.2 - distance / 900, 0, 0.7) * fx.motion);
      rig.rumble(clamp(loud * 0.18 - distance / 2500, 0, 0.8) * fx.motion);
      if (ground && energy > 2e7) collapse.groundImpact(position, energy);
    });
  },
};
