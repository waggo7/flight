import type { Feature } from '../engine/game-context';
import type { GameLoop } from '../engine/game-loop';
import { audioFeature } from '../features/audio-feature';
import { cameraFeature } from '../features/camera-feature';
import { cityFeature } from '../features/city-feature';
import { collapseAudioFeature } from '../features/collapse-audio-feature';
import { controlsFeature } from '../features/controls-feature';
import { destructionFeature } from '../features/destruction-feature';
import { devOverlayFeature } from '../features/dev-overlay-feature';
import { effectsFeature } from '../features/effects-feature';
import { flightFeature } from '../features/flight-feature';
import { flightHudFeature } from '../features/flight-hud-feature';
import { gameFlowFeature } from '../features/game-flow-feature';
import { heroFeature } from '../features/hero-feature';
import { hudFeature } from '../features/hud-feature';
import { powersFeature } from '../features/powers-feature';
import { sceneFeature } from '../features/scene-feature';
import { settingsFeature } from '../features/settings-feature';
import { sparksFeature } from '../features/sparks-feature';
import { createTestApiFeature } from '../features/test-api-feature';
import { timeScaleFeature } from '../features/time-scale-feature';
import { worldLookFeature } from '../features/world-look-feature';

// The composition root: the only list of what the game is made of. A new feature is a new
// file plus one line here. Order matters only where a feature requires another's service, and
// for frame systems in the same phase (they run in install order: flight view → camera → the
// things drawn from the camera).
export function createFeatureList(loop: () => GameLoop): Feature[] {
  return [
    hudFeature,
    settingsFeature,
    sceneFeature,
    timeScaleFeature,
    cityFeature,
    controlsFeature,
    flightFeature,
    cameraFeature,
    worldLookFeature,
    heroFeature,
    effectsFeature,
    sparksFeature,
    audioFeature,
    destructionFeature,
    collapseAudioFeature,
    powersFeature,
    gameFlowFeature,
    flightHudFeature,
    devOverlayFeature,
    createTestApiFeature(loop),
  ];
}
