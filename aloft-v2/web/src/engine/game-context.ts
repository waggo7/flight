import type { ContentLibrary } from './content-library';
import { EventBus } from './event-bus';
import { FixedStepLoop } from './fixed-step-loop';
import { RandomStreams } from './random-streams';
import { ServiceRegistry } from './service-registry';
import { SystemRegistry } from './system-phases';

// Everything a feature needs to plug in. Browser objects (scene, renderer, audio) are provided
// as services by the present-layer features, so this file stays runnable in Node.

export type QualityProfile = 'desktop' | 'phone';

export interface GameContext {
  readonly content: ContentLibrary;
  readonly events: EventBus;
  readonly systems: SystemRegistry;
  readonly services: ServiceRegistry;
  readonly random: RandomStreams;
  readonly loop: FixedStepLoop;
  readonly profile: QualityProfile;
  readonly testMode: boolean;
}

export interface Feature {
  readonly name: string;
  install(ctx: GameContext): void | Promise<void>;
}

export function createGameContext(content: ContentLibrary, options: { profile: QualityProfile; testMode: boolean }): GameContext {
  const sim = content.simulation;
  return {
    content,
    events: new EventBus(),
    systems: new SystemRegistry(),
    services: new ServiceRegistry(),
    random: new RandomStreams(sim.seed),
    loop: new FixedStepLoop({
      stepsPerSecond: sim.stepsPerSecond,
      maxStepsPerFrame: sim.maxStepsPerFrame[options.profile],
      maxFrameDelta: sim.maxFrameDelta,
    }),
    profile: options.profile,
    testMode: options.testMode,
  };
}

export async function installFeatures(ctx: GameContext, features: readonly Feature[]): Promise<void> {
  for (const feature of features) await feature.install(ctx);
}
