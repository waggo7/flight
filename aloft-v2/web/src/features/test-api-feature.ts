import { Box3, Scene, Vector3, WebGLRenderTarget } from 'three';
import type { HeroPoseName } from '../core/hero-pose-graph';
import type { FlightControls } from '../core/flight-model';
import type { Feature } from '../engine/game-context';
import type { GameLoop } from '../engine/game-loop';
import { runAudioBench, type AudioBenchResult } from '../present/audio/audio-bench';
import { splitBoxIntoChunks } from '../present/render/city/chunk-instances';
import { CameraToken } from './camera-feature';
import { CityToken } from './city-feature';
import { ControlsToken } from './controls-feature';
import { DestructionToken } from './destruction-feature';
import { EffectsToken } from './effects-feature';
import { FlightToken } from './flight-feature';
import { GameFlowToken } from './game-flow-feature';
import { HeroToken } from './hero-feature';
import { SceneToken } from './scene-feature';
import { SettingsToken } from './settings-feature';

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
  /** Run `frames` frames; only the last is drawn (none when `draw` is false). */
  advance(frames?: number, dt?: number, draw?: boolean): void;
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
  /** Offline renders of the collapse recipes, with measurements and WAVs (npm run audio:render). */
  audioBench(): Promise<AudioBenchResult>;
  /** Bury the camera in dust (the engulf check). */
  engulfInDust(): void;
  readonly destruction: { fragments: number; bodies: number };
  /** Swap every tower piece within `radius` m (ground plane) of a point for its chunks; returns how many. */
  chunkify(x: number, z: number, radius: number): number;
  readonly state: string;
  readonly snapshot: Record<string, unknown>;
  /** Choose a hero by id (as the hero select does: saved in settings, rig rebuilt). */
  setHero(id: string): void;
  readonly hero: string;
  /** Hold one pose-library pose at full weight; null returns to the pose graph. */
  forcePose(name: HeroPoseName | null): void;
  /** Put the hero somewhere, hovering or mid-flight (the flight model stays paused on the title). */
  placeHero(place: TestPose & { hover?: boolean }): void;
  /** Snap the pose springs to their targets and re-drape the cape. */
  settleHero(): void;
  /**
   * Point the camera at the hero and draw: `azimuth` around the hero from its front (radians,
   * positive toward its left), `elevation` up from level, `fill` = share of the view the figure fills,
   * `lift` = metres to move the framing centre up (close-ups of the head or boots).
   */
  frameHero(options?: { azimuth?: number; elevation?: number; fill?: number; lift?: number }): void;
  /** The hero drawn alone: draw calls and triangles from renderer.info, and the rig update time. */
  heroStats(): HeroStats;
}

export interface HeroStats {
  hero: string;
  drawCalls: number;
  triangles: number;
  meshes: number;
  bones: number;
  rigMs: number;
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
      const effects = ctx.services.require(EffectsToken);
      const hero = ctx.services.require(HeroToken);
      const settings = ctx.services.require(SettingsToken);
      const bounds = new Box3();
      const bonePoint = new Vector3();
      const centre = new Vector3();
      const size = new Vector3();
      const direction = new Vector3();
      window.__aloft = {
        start: () => flow.start(),
        restart: () => flow.restart(),
        setControls(next) {
          controls.override = next ? { steerX: 0, steerY: 0, boost: false, brake: false, ...next } : null;
        },
        advance(frames = 1, dt = 1 / 60, draw = true) {
          for (let i = 0; i < frames; i++) {
            scene.renderEnabled = draw && i === frames - 1;
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
        audioBench: () => runAudioBench(),
        engulfInDust() {
          const p = scene.camera.position;
          for (let i = 0; i < 40; i++) effects.dust.puff(p.x + (i % 5 - 2) * 6, p.y + ((i / 5) % 3 - 1) * 5, p.z + (Math.floor(i / 15) - 1) * 6, { size: 22, growth: 1, life: 20, rise: 0, alpha: 0.7, darkness: 0.2 });
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
        setHero(id) {
          settings.update({ hero: id });
        },
        get hero() {
          return hero.definition.id;
        },
        forcePose(name) {
          hero.forcePose(name);
        },
        placeHero({ position, yaw, pitch = 0, speed = 0, hover = false }) {
          if (hover) flight.respawn(new Vector3(...position), yaw);
          else flight.place(new Vector3(...position), yaw, pitch, speed);
          rig.snapTo(flight.view);
          hero.settle();
        },
        settleHero() {
          hero.settle();
        },
        frameHero({ azimuth = 0.7, elevation = 0.12, fill = 0.8, lift = 0 } = {}) {
          const { camera } = scene;
          bounds.makeEmpty();
          for (const bone of hero.rig.boneList) bounds.expandByPoint(bone.getWorldPosition(bonePoint));
          bounds.getCenter(centre);
          centre.y += lift;
          const radius = bounds.getSize(size).length() / 2 + 0.3 * hero.rig.scale;
          camera.fov = 30;
          camera.updateProjectionMatrix();
          const halfV = (camera.fov * Math.PI) / 360;
          const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
          const distance = radius / Math.sin(Math.min(halfV, halfH)) / fill;
          const forward = flight.view.forward;
          const heading = Math.atan2(forward.x, forward.z) + azimuth;
          direction.set(Math.sin(heading) * Math.cos(elevation), Math.sin(elevation), Math.cos(heading) * Math.cos(elevation));
          camera.position.copy(centre).addScaledVector(direction, distance);
          camera.up.set(0, 1, 0);
          camera.lookAt(centre);
          camera.updateMatrixWorld();
          scene.draw();
        },
        heroStats() {
          const { renderer, camera } = scene;
          const alone = new Scene();
          const target = new WebGLRenderTarget(64, 64);
          const objects = [hero.rig.root, ...(hero.capeMesh ? [hero.capeMesh] : [])];
          const parents = objects.map((object) => object.parent);
          for (const object of objects) alone.add(object);
          const previous = renderer.getRenderTarget();
          renderer.setRenderTarget(target);
          renderer.info.reset();
          renderer.render(alone, camera);
          const drawCalls = renderer.info.render.calls;
          const triangles = renderer.info.render.triangles;
          renderer.setRenderTarget(previous);
          objects.forEach((object, i) => parents[i]?.add(object));
          target.dispose();
          return {
            hero: hero.definition.id,
            drawCalls,
            triangles,
            meshes: objects.length - 1 + hero.rig.meshes.length,
            bones: hero.rig.boneList.length,
            rigMs: hero.measureUpdateMs(300),
          };
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
