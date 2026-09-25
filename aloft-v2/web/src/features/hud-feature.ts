import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { HudOverlay } from '../present/ui/hud-overlay';
import { mountHudMarkup } from '../present/ui/hud-markup';

// v1's DOM layer (title, pause and settings screens, HUD, hints, toasts, touch buttons). Installed
// first so the loading line shows while the city is raised; game-flow drives the screens and
// flight-hud feeds it every frame.

export const HudToken = serviceToken<HudOverlay>('hud');

export const hudFeature: Feature = {
  name: 'hud',
  install(ctx) {
    const root = document.getElementById('app');
    if (!root) throw new Error('index.html needs <div id="app">');
    mountHudMarkup(root);
    const hud = ctx.services.provide(HudToken, new HudOverlay(root));
    hud.setLoading('Raising the city…');
  },
};
