import { Mesh, Quaternion, Vector3 } from 'three';
import type { Vector3Like } from 'three';
import { IDLE_CONTROLS } from '../core/flight-model';
import { scaleFlightTuning, type HeroDefinition } from '../core/hero-definition';
import { HeroPoseGraph, IDLE_ACTIONS, type HeroActionState, type HeroPoseEvent, type HeroPoseInput, type HeroPoseName } from '../core/hero-pose-graph';
import { clamp } from '../core/scalar-math';
import { findHero } from '../engine/content-library';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';
import { CapeCloth } from '../present/render/hero/cape-cloth';
import { buildHeroRig, type HeroRig } from '../present/render/hero/hero-rig';
import { CameraToken } from './camera-feature';
import { ControlsToken } from './controls-feature';
import { FlightToken } from './flight-feature';
import { SceneToken } from './scene-feature';
import { SettingsToken } from './settings-feature';

// The chosen hero (content/heroes/<id>.json): the data-driven rig, posed every frame by the pose
// graph from the interpolated flight state, the power phases and flight events, with the cloth
// cape for heroes that have one. Switching hero rebuilds the rig and cape and scales a copy of
// the flight tuning by the hero's multipliers. Hidden once the first-person view is mostly in.

declare module '../engine/event-bus' {
  interface GameEventMap {
    /** A different hero was chosen (the rig is already rebuilt). */
    'hero:changed': { hero: HeroDefinition };
  }
}

/** A world-space point for the head to turn toward. */
export interface HeroLookRequest {
  point: Vector3Like;
  /** 0..1. */
  weight: number;
}

export interface HeroService {
  readonly definition: HeroDefinition;
  readonly rig: HeroRig;
  /** null for heroes without a cape. */
  readonly cape: CapeCloth | null;
  readonly capeMesh: Mesh | null;
  readonly graph: HeroPoseGraph;
  /** Power phases the pose graph shows (M7's state machines set these). */
  actions: HeroActionState;
  /** Where the head looks: a grab target, a failing tower, the free-look point. null = into the turn. */
  lookTarget: HeroLookRequest | null;
  /** 0..1 slam charge; the emblem glows with the larger of this and boost. */
  charge: number;
  /** Switch hero by id (unknown ids fall back to the first hero). */
  setHero(id: string): void;
  /** Hold one pose at full weight (tests, stills); null returns to the graph. */
  forcePose(name: HeroPoseName | null): void;
  /** Jump the pose springs to their targets and re-drape the cape. */
  settle(): void;
  /** Kick the cape (m/s, world space): slam impacts, bursting through buildings. */
  kickCape(impulse: Vector3Like): void;
  /** Start a pose pulse (burst / glance); flight events already trigger these. */
  trigger(event: HeroPoseEvent): void;
  /** Milliseconds the last rig update took (pose graph + bones). */
  readonly lastUpdateMs: number;
  /** Average milliseconds of `runs` rig updates (pose graph + bones + matrices), for perf checks. */
  measureUpdateMs(runs: number): number;
}

export const HeroToken = serviceToken<HeroService>('hero');

const DOWN = new Vector3(0, -1, 0);

export const heroFeature: Feature = {
  name: 'hero',
  install(ctx) {
    const { scene } = ctx.services.require(SceneToken);
    const flight = ctx.services.require(FlightToken);
    const controls = ctx.services.require(ControlsToken);
    const cameraRig = ctx.services.require(CameraToken);
    const settings = ctx.services.require(SettingsToken);

    const graph = new HeroPoseGraph(ctx.content.poses);
    let definition = findHero(ctx.content, settings.current.hero);
    let rig!: HeroRig;
    let cape: CapeCloth | null = null;
    let capeMesh: Mesh | null = null;
    let lastUpdateMs = 0;

    const input: HeroPoseInput = {
      hoverBlend: 1, boostBlend: 0, speedShare: 0, pitch: 0, bank: 0, yawRate: 0, steerX: 0, brake: 0, actions: { ...IDLE_ACTIONS }, look: null,
    };
    const look = { x: 0, y: 0, z: 1, weight: 0 };
    const inverse = new Quaternion();
    const toTarget = new Vector3();
    const back = new Vector3();

    const readInput = (): HeroPoseInput => {
      const view = flight.view;
      const steering = flight.active ? controls.current : IDLE_CONTROLS;
      input.hoverBlend = view.hoverBlend;
      input.boostBlend = view.boostBlend;
      input.speedShare = view.speedShare;
      input.pitch = view.pitch;
      input.bank = view.bank;
      input.yawRate = view.yawRate;
      input.steerX = steering.steerX;
      input.brake = steering.brake ? 1 : 0;
      input.actions = service.actions;
      const target = service.lookTarget;
      if (target) {
        const direction = toTarget.set(target.point.x - view.position.x, target.point.y - view.position.y, target.point.z - view.position.z);
        direction.applyQuaternion(inverse.copy(view.quaternion).invert());
        look.x = direction.x;
        look.y = direction.y;
        look.z = direction.z;
        look.weight = clamp(target.weight, 0, 1);
        input.look = look;
      } else {
        input.look = null;
      }
      return input;
    };

    const placeRig = (): void => {
      rig.root.position.copy(flight.view.position);
      rig.root.quaternion.copy(flight.view.quaternion);
      rig.applyPose(graph.rotations, graph.offset);
      rig.root.updateMatrixWorld(true);
    };

    const drapeCape = (): void => {
      if (!cape || !capeMesh) return;
      cape.drape(rig.refreshCapeFrame(), DOWN, back.copy(flight.view.forward).negate());
      capeMesh.position.copy(rig.root.position);
    };

    const build = (next: HeroDefinition): void => {
      if (capeMesh) capeMesh.removeFromParent();
      cape?.geometry.dispose();
      if (rig) {
        rig.dispose();
        rig.materials.dispose();
      }
      definition = next;
      rig = buildHeroRig(next.look);
      scene.add(rig.root);
      cape = null;
      capeMesh = null;
      if (next.look.cape) {
        cape = new CapeCloth({ topWidth: rig.capeTopWidth, bottomWidth: next.look.cape.width, length: next.look.cape.length });
        capeMesh = new Mesh(cape.geometry, rig.materials.cape);
        capeMesh.frustumCulled = false;
        capeMesh.castShadow = true;
        capeMesh.receiveShadow = true;
        scene.add(capeMesh);
      }
      flight.model.tuning = scaleFlightTuning(ctx.content.flight, next.flight);
      service.settle();
    };

    const service: HeroService = {
      get definition() {
        return definition;
      },
      get rig() {
        return rig;
      },
      get cape() {
        return cape;
      },
      get capeMesh() {
        return capeMesh;
      },
      graph,
      actions: { ...IDLE_ACTIONS },
      lookTarget: null,
      charge: 0,
      setHero(id) {
        const next = findHero(ctx.content, id);
        if (next === definition && rig.root.parent) return;
        build(next);
        ctx.events.emit('hero:changed', { hero: next });
      },
      forcePose(name) {
        graph.force(name);
      },
      settle() {
        graph.snap(readInput());
        placeRig();
        drapeCape();
      },
      kickCape(impulse) {
        cape?.kick(impulse);
      },
      trigger(event) {
        graph.trigger(event);
      },
      get lastUpdateMs() {
        return lastUpdateMs;
      },
      measureUpdateMs(runs) {
        const started = performance.now();
        for (let i = 0; i < runs; i++) {
          graph.update(1 / 60, readInput());
          placeRig();
          rig.skeleton.update();
        }
        return (performance.now() - started) / Math.max(1, runs);
      },
    };
    ctx.services.provide(HeroToken, service);
    build(definition);

    settings.onChange((current) => {
      if (current.hero !== definition.id) service.setHero(current.hero);
    });
    ctx.events.on('game:restart', () => {
      service.actions = { ...IDLE_ACTIONS };
      service.settle();
    });
    const kick = new Vector3();
    ctx.events.on('flight:event', (event) => {
      if (event.type === 'smash' && event.kind !== 'dent') {
        graph.trigger('burst');
        service.kickCape(kick.copy(flight.view.forward).multiplyScalar(-10).addScaledVector(event.normal, 3));
      } else if (event.type === 'impact' || event.type === 'smash') {
        graph.trigger('glance');
        service.kickCape(kick.copy(event.normal).multiplyScalar(4 + 4 * Math.min(1, event.strength)));
      }
    });

    ctx.systems.addFrame({
      name: 'hero',
      phase: FramePhase.Present,
      frame(realDt) {
        const simDt = realDt * ctx.loop.timeScale;
        const started = performance.now();
        graph.update(simDt, readInput());
        placeRig();
        lastUpdateMs = performance.now() - started;
        rig.materials.setGlow(Math.max(flight.view.boostBlend * 0.7, service.charge));
        if (cape && capeMesh) {
          cape.setAnchors(rig.refreshCapeFrame());
          cape.step(simDt, flight.view.velocity, flight.view.acceleration, rig.capsule);
          capeMesh.position.copy(rig.root.position);
        }
        const visible = cameraRig.firstPersonBlend <= 0.6;
        rig.root.visible = visible;
        if (capeMesh) capeMesh.visible = visible;
      },
    });
  },
};
