import type { FlightControls } from '../core/flight-model';
import type { Feature } from '../engine/game-context';
import type { GameLoop } from '../engine/game-loop';
import { CameraToken } from './camera-feature';
import { ControlsToken } from './controls-feature';
import { FlightToken } from './flight-feature';
import { GameFlowToken } from './game-flow-feature';
import { SceneToken } from './scene-feature';

// ?test: the render loop does not run on its own. Headless checks drive it deterministically:
//   __aloft.start(); __aloft.setControls({ boost: true }); __aloft.advance(120);
// advance() draws only its last frame, so long runs stay fast under software rendering.

export interface TestApi {
  start(): void;
  restart(): void;
  setControls(controls: Partial<FlightControls> | null): void;
  advance(frames?: number, dt?: number): void;
  render(): void;
  readonly state: string;
  readonly snapshot: Record<string, unknown>;
}

declare global {
  interface Window {
    __aloft?: TestApi;
  }
}

export function createTestApiFeature(loop: () => GameLoop): Feature {
  return {
    name: 'test-api',
    install(ctx) {
      if (!ctx.testMode) return;
      const scene = ctx.services.require(SceneToken);
      const controls = ctx.services.require(ControlsToken);
      const flight = ctx.services.require(FlightToken);
      const flow = ctx.services.require(GameFlowToken);
      const rig = ctx.services.require(CameraToken);
      window.__aloft = {
        start: () => flow.start(),
        restart: () => flow.restart(),
        setControls(next) {
          controls.override = next ? { steerX: 0, steerY: 0, boost: false, brake: false, ...next } : null;
        },
        advance(frames = 1, dt = 1 / 60) {
          for (let i = 0; i < frames; i++) {
            scene.renderEnabled = i === frames - 1;
            loop().frame(dt);
          }
          scene.renderEnabled = true;
        },
        render() {
          scene.renderer.render(scene.scene, scene.camera);
        },
        get state() {
          return flow.state;
        },
        get snapshot() {
          const m = flight.model;
          return {
            state: flow.state,
            position: m.position.toArray(),
            speed: m.speed,
            mode: m.mode,
            yaw: m.yaw,
            pitch: m.pitch,
            simTime: ctx.loop.simTime,
            steps: ctx.loop.stepCount,
            view: rig.mode,
          };
        },
      };
    },
  };
}
