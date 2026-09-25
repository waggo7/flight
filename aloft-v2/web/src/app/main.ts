import { loadContent } from '../engine/content-library';
import { createGameContext, installFeatures } from '../engine/game-context';
import { GameLoop } from '../engine/game-loop';
import { HudToken } from '../features/hud-feature';
import { SceneToken } from '../features/scene-feature';
import '../present/ui/hud-styles.css';
import { createFeatureList } from './feature-list';
import { detectProfile } from './quality-profile';
import './styles.css';

// Boot: validate content, build the context, install features, warm up the shaders, then run
// frames (or, in ?test mode, wait for the test API to drive them).

async function boot(): Promise<void> {
  const content = loadContent();
  const testMode = new URLSearchParams(location.search).has('test');
  const ctx = createGameContext(content, { profile: detectProfile(), testMode });
  let gameLoop: GameLoop | null = null;
  await installFeatures(ctx, createFeatureList(() => gameLoop!));
  gameLoop = new GameLoop(ctx);

  // Compile every shader before the first visible frame so the title fades in smoothly.
  const { renderer, scene, camera } = ctx.services.require(SceneToken);
  renderer.compile(scene, camera);
  gameLoop.frame(0);
  ctx.services.require(HudToken).ready();
  document.body.dataset.ready = 'true';
  if (testMode) return;

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = (now - last) / 1000;
    last = now;
    gameLoop!.frame(dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot().catch((error: unknown) => {
  console.error(error);
  const message = document.createElement('pre');
  message.className = 'boot-error';
  message.textContent = `Aloft could not start:\n${error instanceof Error ? error.message : String(error)}`;
  document.body.append(message);
});
