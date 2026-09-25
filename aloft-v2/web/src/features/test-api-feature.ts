import { Vector3 } from 'three';
import type { FlightControls } from '../core/flight-model';
import type { Feature } from '../engine/game-context';
import type { GameLoop } from '../engine/game-loop';
import { splitBoxIntoChunks } from '../present/render/city/chunk-instances';
import { CameraToken } from './camera-feature';
import { CityToken } from './city-feature';
import { ControlsToken } from './controls-feature';
import { DestructionToken } from './destruction-feature';
import { FlightToken } from './flight-feature';
import { GameFlowToken } from './game-flow-feature';
import { SceneToken } from './scene-feature';

// ?test: the render loop does not run on its own. Headless checks drive it deterministically:
//   __aloft.start(); __aloft.setControls({ boost: true }); __aloft.advance(120);
// advance() draws only its last frame, so long runs stay fast under software rendering.

export interface TestPose {
  position: [number, number, number];
  yaw: number;
  pitch?: number;
  speed?: number;
}

export interface TestApi {
  start(): void;
  restart(): void;
  setControls(controls: Partial<FlightControls> | null): void;
  advance(frames?: number, dt?: number): void;
  /** Place the hero mid-flight and snap the camera behind it. */
  pose(pose: TestPose): void;
  render(): void;
  /**
   * Line the hero up to smash a tall tower: the first (tallest first) whose face the hero can
   * reach unobstructed from `distance` m away, hit at 45% of its height. Returns the building id.
   */
  aimAtTower(speed: number, distance?: number): { building: number; yaw: number; point: [number, number, number] } | null;
  /** Hover `distance` m to the side of `point` (looking across `yaw`), facing it. */
  watch(point: [number, number, number], yaw: number, distance?: number): void;
  readonly destruction: { fragments: number; bodies: number };
  /** Swap every tower piece within `radius` m (ground plane) of a point for its chunks; returns how many. */
  chunkify(x: number, z: number, radius: number): number;
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
      const city = ctx.services.require(CityToken);
      const destruction = ctx.services.require(DestructionToken);
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
        pose({ position, yaw, pitch = 0, speed = 40 }) {
          flight.place(new Vector3(...position), yaw, pitch, speed);
          rig.snapTo(flight.view);
        },
        render() {
          scene.draw();
        },
        aimAtTower(speed, distance = 60) {
          const { physics, blueprint } = city;
          const towers = blueprint.boxes.filter((b) => b.role === 'tower' && b.collide && b.h > 90 && Math.min(b.w, b.d) > 18).sort((a, b) => b.h - a.h);
          for (const tower of towers) {
            // Approach along the tower's local +z (its front face is at local −z).
            const dir = { x: Math.sin(tower.yaw), y: 0, z: Math.cos(tower.yaw) };
            const y = tower.y0 + tower.h * 0.45;
            const face = { x: tower.x - dir.x * tower.d / 2, y, z: tower.z - dir.z * tower.d / 2 };
            const from = { x: face.x - dir.x * distance, y, z: face.z - dir.z * distance };
            const hit = physics.world.castRay(new physics.rapier.Ray(from, dir), distance + 5, true, undefined, physics.groups.heroQuery);
            if (!hit || physics.ownerOf(hit.collider)?.building !== tower.building) continue;
            const yaw = Math.atan2(dir.x, dir.z);
            flight.place(new Vector3(from.x, from.y, from.z), yaw, 0, speed);
            rig.snapTo(flight.view);
            return { building: tower.building, yaw, point: [face.x, face.y, face.z] };
          }
          return null;
        },
        watch(point, yaw, distance = 280) {
          const side = yaw + Math.PI / 2;
          const from = new Vector3(point[0] - Math.sin(side) * distance + Math.sin(yaw) * 40, point[1] + 30, point[2] - Math.cos(side) * distance + Math.cos(yaw) * 40);
          flight.respawn(from, side);
          rig.snapTo(flight.view);
        },
        get destruction() {
          return { fragments: destruction.fragmentCount, bodies: city.physics.world.bodies.len() };
        },
        chunkify(x, z, radius) {
          let count = 0;
          city.blueprint.boxes.forEach((piece, index) => {
            if (piece.role !== 'tower' || Math.hypot(piece.x - x, piece.z - z) > radius) return;
            if (city.meshes.replaceWithChunks(index, splitBoxIntoChunks(piece))) count++;
          });
          return count;
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
            colliders: city.physics.world.colliders.len(),
          };
        },
      };
    },
  };
}
