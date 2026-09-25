import type { Feature } from '../engine/game-context';
import { HeroPicker } from '../present/ui/hero-picker';
import { ControlsToken } from './controls-feature';
import { GameFlowToken } from './game-flow-feature';
import { HudToken } from './hud-feature';
import { SettingsToken } from './settings-feature';

// Hero select on the title screen: the arrow buttons, ←/→ or the D-pad cycle the presets (in
// content order). The choice is saved in settings; the hero feature rebuilds the rig from it.

export const heroSelectFeature: Feature = {
  name: 'hero-select',
  install(ctx) {
    const hud = ctx.services.require(HudToken);
    const settings = ctx.services.require(SettingsToken);
    const flow = ctx.services.require(GameFlowToken);
    const { input } = ctx.services.require(ControlsToken);
    const heroes = ctx.content.heroes;
    const picker = new HeroPicker(hud.titleScreen, heroes.length);

    const indexOf = (id: string): number => Math.max(0, heroes.findIndex((hero) => hero.id === id));
    const show = (): void => {
      const index = indexOf(settings.current.hero);
      const hero = heroes[index]!;
      const { suit, trim, accent } = hero.look.palette;
      picker.show(index, { name: hero.name, tagline: hero.tagline, swatch: [suit, trim, accent] });
    };
    const step = (delta: number): void => {
      if (flow.state !== 'title' || heroes.length < 2) return;
      const index = (indexOf(settings.current.hero) + delta + heroes.length) % heroes.length;
      settings.update({ hero: heroes[index]!.id });
    };

    picker.onStep(step);
    input.on('hero-previous', () => step(-1));
    input.on('hero-next', () => step(1));
    settings.onChange(show);
    show();
  },
};
