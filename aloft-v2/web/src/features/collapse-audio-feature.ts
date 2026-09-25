import type { WorldPoint } from '../core/building-structure';
import { clamp } from '../core/scalar-math';
import type { Feature } from '../engine/game-context';
import { crack, dustWhoosh, glassCascade, glassSmash, groan, groundBoom, metalShear, modalImpact, rubbleGrains, rumbleBed } from '../present/audio/collapse-recipes';
import { AudioToken } from './audio-feature';

// The collapse soundscape: what the destruction system reports, turned into recipes in the spatial
// engine. Buildings groan before they go, crack and shed glass when hit (the hero's own hit bursts
// the curtain wall and tears the frame), shear their steel as they fail, roar while they fall, and
// boom when they land; contacts are clustered (8 m, 50 ms) so a rain of rubble stays a texture.

const GLASS = 0;

export const collapseAudioFeature: Feature = {
  name: 'collapse-audio',
  install(ctx) {
    const audio = ctx.services.require(AudioToken);
    const recent = new Map<string, number>();
    const clustered = (p: WorldPoint, now: number): boolean => {
      const key = `${Math.round(p.x / 8)},${Math.round(p.y / 8)},${Math.round(p.z / 8)}`;
      const last = recent.get(key) ?? -Infinity;
      if (now - last < 0.05) return true;
      recent.set(key, now);
      if (recent.size > 512) recent.clear();
      return false;
    };

    ctx.events.on('destruction:damage', ({ crushed, style, point, outcome }) => {
      const engine = audio.engine;
      if (!engine || crushed.length === 0) return;
      const strength = clamp(0.4 + crushed.length / 20, 0.4, 1);
      crack(engine, point, strength);
      for (let i = 0; i < Math.min(3, crushed.length); i++) modalImpact(engine, crushed[i]!, 'concrete', 2 + engine.random() * 3, strength);
      if (style === GLASS) glassCascade(engine, point, crushed.length * 4, Math.max(point.y - 4, 5));
      if (outcome === 'burst') rubbleGrains(engine, point, 220, 1.2, 0.7);
    });
    ctx.events.on('destruction:hero-hit', ({ point, soaked, glass }) => {
      const engine = audio.engine;
      if (!engine) return;
      const strength = clamp(0.5 + soaked * 0.5, 0.5, 1);
      if (glass) glassSmash(engine, point, strength, Math.max(point.y - 4, 5));
      metalShear(engine, point, strength, 0.7 + soaked);
    });
    ctx.events.on('destruction:strain', ({ position, loadRatio }) => {
      if (audio.engine) groan(audio.engine, position, 2.2 + loadRatio * 1.5, clamp(loadRatio, 0.5, 1));
    });
    ctx.events.on('destruction:failure', ({ position, height }) => {
      const engine = audio.engine;
      if (!engine) return;
      groan(engine, position, 4, 1);
      rumbleBed(engine, position, clamp(height / 12, 3, 9), 1);
      crack(engine, position, 1);
      // The frame gives way: a long, low shear.
      metalShear(engine, position, 1, 2.2);
    });
    ctx.events.on('destruction:impact', ({ position, energy, mass, ground }) => {
      const engine = audio.engine;
      if (!engine || energy < 5e6 || clustered(position, engine.now)) return;
      const loud = clamp(Math.log10(energy / 1e6) / 3, 0.2, 1);
      modalImpact(engine, position, 'concrete', clamp(Math.cbrt(mass / 400), 1, 20), loud);
      // Steel in the rubble: some heavy contacts scrape and ring.
      if (energy > 5e7 && engine.random() < 0.35) metalShear(engine, position, loud * 0.7, 1.2);
      if (energy > 3e8) rumbleBed(engine, position, 1.5, loud);
      if (ground && energy > 5e7) {
        groundBoom(engine, position, clamp(Math.cbrt(energy / 1e6) * 10, 20, 300));
        rubbleGrains(engine, position, 260, 2.2, loud);
        if (engine.distanceTo(position) < 220) dustWhoosh(engine, position, loud);
      }
    });
  },
};
