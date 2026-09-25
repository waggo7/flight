import type { Feature } from '../engine/game-context';
import type { GameLoop } from '../engine/game-loop';
import { cameraFeature } from '../features/camera-feature';
import { controlsFeature } from '../features/controls-feature';
import { devOverlayFeature } from '../features/dev-overlay-feature';
import { flightFeature } from '../features/flight-feature';
import { gameFlowFeature } from '../features/game-flow-feature';
import { greyBoxWorldFeature } from '../features/grey-box-world-feature';
import { heroPlaceholderFeature } from '../features/hero-placeholder-feature';
import { sceneFeature } from '../features/scene-feature';
import { createTestApiFeature } from '../features/test-api-feature';

// The composition root: the only list of what the game is made of. A new feature is a new
// folder plus one line here. Order matters only where a feature requires another's service.
export function createFeatureList(loop: () => GameLoop): Feature[] {
  return [
    sceneFeature,
    greyBoxWorldFeature,
    controlsFeature,
    flightFeature,
    cameraFeature,
    heroPlaceholderFeature,
    gameFlowFeature,
    devOverlayFeature,
    createTestApiFeature(loop),
  ];
}
