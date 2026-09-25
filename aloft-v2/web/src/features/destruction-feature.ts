import { clamp } from '../core/scalar-math';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase, StepPhase } from '../engine/system-phases';
import { DestructionView } from '../present/render/city/destruction-view';
import { DestructionSystem } from '../sim/destruction-system';
import { AudioToken } from './audio-feature';
import { CameraToken } from './camera-feature';
import { CityToken } from './city-feature';
import { EffectsToken } from './effects-feature';
import { HudToken } from './hud-feature';
import { SceneToken } from './scene-feature';
import { SettingsToken } from './settings-feature';
import { TimeScaleToken } from './time-scale-feature';

// Buildings that break: the hero's smash goes to the destruction system (rules decide, Rapier
// moves), its pieces are drawn by the destruction view, and its events turn into dust, sound,
// camera shake, the first collapse's slow motion and the "Timber!" toast.

export const DestructionToken = serviceToken<DestructionSystem>('destruction');

export const destructionFeature: Feature = {
  name: 'destruction',
  install(ctx) {
    const city = ctx.services.require(CityToken);
    const { camera } = ctx.services.require(SceneToken);
    const { dust, motion } = ctx.services.require(EffectsToken);
    const audio = ctx.services.require(AudioToken);
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

    ctx.systems.addStep({ name: 'destruction-before', phase: StepPhase.DestructionApply, step: () => system.beforeStep() });
    ctx.systems.addStep({ name: 'destruction-after', phase: StepPhase.Contacts, step: (dt) => system.afterStep(dt) });
    ctx.systems.addFrame({ name: 'destruction-view', phase: FramePhase.Present, frame: (_realDt, alpha) => view.sync(alpha) });
    // The city feature restores the pristine world first (it installed earlier).
    ctx.events.on('game:restart', () => system.reset());

    const distanceTo = (p: { x: number; y: number; z: number }): number => Math.hypot(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z);

    ctx.events.on('destruction:damage', ({ crushed }) => {
      // Dust jets out of every crushed storey (a few puffs per hit, not one per chunk).
      const step = Math.max(1, Math.floor(crushed.length / 10));
      for (let i = 0; i < crushed.length; i += step) {
        const p = crushed[i]!;
        dust.puff(p.x, p.y, p.z, { size: 9, growth: 2.6, life: 6, rise: 1.4, alpha: 0.5, darkness: 0.25 });
      }
    });
    ctx.events.on('destruction:failure', ({ position, height, first }) => {
      audio.collapse(distanceTo(position), height);
      if (!first) return;
      hud.toast('Timber!');
      time.slowMotion(1.1 * motion, 0.35);
      rig.kick(6 * motion);
    });
    ctx.events.on('destruction:impact', ({ position, energy, ground }) => {
      const distance = distanceTo(position);
      const size = clamp(Math.cbrt(energy / 1e6) * 12, 20, 260);
      if (energy > 5e7) audio.collapseImpact(distance, size);
      rig.shake(clamp(Math.log10(energy / 1e6) * 0.25 - distance / 1200, 0, 0.8) * motion);
      if (ground && energy > 2e7) {
        for (let i = 0; i < 4; i++) dust.puff(position.x + (i - 1.5) * 8, position.y + 2, position.z, { size: 14, growth: 3, life: 8, rise: 1, vx: (i - 1.5) * 3, alpha: 0.55, darkness: 0.2 });
      }
    });
  },
};
