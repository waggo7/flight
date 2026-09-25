import { loadContent } from '../engine/content-library';
import { createGameContext, installFeatures } from '../engine/game-context';
import { GameLoop } from '../engine/game-loop';
import { createFeatureList } from './feature-list';
import './styles.css';

// Boot: validate content, build the context, install features, then run frames.

async function boot(): Promise<void> {
  const content = loadContent();
  const testMode = new URLSearchParams(location.search).has('test');
  const profile = matchMedia('(pointer: coarse)').matches ? 'phone' : 'desktop';
  const ctx = createGameContext(content, { profile, testMode });
  let gameLoop: GameLoop | null = null;
  await installFeatures(ctx, createFeatureList(() => gameLoop!));
  gameLoop = new GameLoop(ctx);
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
