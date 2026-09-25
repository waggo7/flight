import { Vector3 } from 'three';
import type { FlightControls } from '../core/flight-model';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';
import { findDominoApproach, findPancakeTower, findSlamSite, findSmashApproach, type Point } from '../sim/scenario-sites';
import { CameraToken } from './camera-feature';
import { CityToken } from './city-feature';
import { ControlsToken } from './controls-feature';
import { DestructionToken } from './destruction-feature';
import { FlightToken } from './flight-feature';
import { GameFlowToken } from './game-flow-feature';
import { HudToken } from './hud-feature';
import { PowersToken } from './powers-feature';

// Demo scenes: one button (title or pause screen, or ?scenario=name) stages a showcase — a boost
// smash that topples a tower, a pancake, a domino, a ground slam, a thrown chunk. Each is a short
// timed script over the real systems (no special cases in the physics); control returns to the
// player when it ends, or at once if they steer.

export type ScenarioName = 'topple' | 'pancake' | 'domino' | 'slam' | 'throw';

export const SCENARIOS: readonly { name: ScenarioName; label: string }[] = [
  { name: 'topple', label: 'Topple' },
  { name: 'pancake', label: 'Pancake' },
  { name: 'domino', label: 'Domino' },
  { name: 'slam', label: 'Slam' },
  { name: 'throw', label: 'Throw' },
];

interface Step {
  at: number;
  run: () => void;
}

export interface DemoScenesService {
  play(name: ScenarioName): boolean;
  readonly playing: ScenarioName | null;
}

export const DemoScenesToken = serviceToken<DemoScenesService>('demo-scenes');

export const demoScenesFeature: Feature = {
  name: 'demo-scenes',
  install(ctx) {
    const city = ctx.services.require(CityToken);
    const flight = ctx.services.require(FlightToken);
    const flow = ctx.services.require(GameFlowToken);
    const controls = ctx.services.require(ControlsToken);
    const rig = ctx.services.require(CameraToken);
    const destruction = ctx.services.require(DestructionToken);
    const powers = ctx.services.require(PowersToken);
    const hud = ctx.services.require(HudToken);

    let steps: Step[] = [];
    let clock = 0;
    let playing: ScenarioName | null = null;
    const drive = (next: Partial<FlightControls> | null): void => {
      controls.override = next ? { steerX: 0, steerY: 0, boost: false, brake: false, ...next } : null;
      // Now, not next frame: after a cut (a respawn to hover) a step on the last shot's controls
      // would still be boosting, and boosting from a hover launches the hero.
      if (controls.override) controls.current = { ...controls.override };
    };
    /** Hover off to the side of `point`, looking across `yaw` at it (a cut, like a film). */
    const watch = (point: Point, yaw: number, distance = 260, rise = 40): void => {
      const side = yaw + Math.PI / 2;
      flight.respawn(new Vector3(point.x - Math.sin(side) * distance + Math.sin(yaw) * 40, point.y + rise, point.z - Math.cos(side) * distance + Math.cos(yaw) * 40), side);
      rig.snapTo(flight.view);
      drive({ brake: true });
    };
    const flyAt = (from: Point, direction: Point, speed: number): number => {
      const yaw = Math.atan2(direction.x, direction.z);
      flight.place(new Vector3(from.x, from.y, from.z), yaw, 0, speed);
      rig.snapTo(flight.view);
      drive({ boost: true });
      return yaw;
    };

    const scripts: Record<ScenarioName, () => Step[] | null> = {
      topple() {
        const a = findSmashApproach(city.blueprint, city.physics);
        if (!a) return null;
        const yaw = Math.atan2(a.direction.x, a.direction.z);
        return [
          { at: 0, run: () => flyAt(a.from, a.direction, 108) },
          { at: 1.1, run: () => watch(a.face, yaw) },
          { at: 13, run: () => drive(null) },
        ];
      },
      domino() {
        const a = findDominoApproach(city.blueprint, city.physics);
        if (!a) return null;
        const yaw = Math.atan2(a.direction.x, a.direction.z);
        return [
          { at: 0, run: () => flyAt(a.from, a.direction, 108) },
          { at: 1.1, run: () => watch({ x: a.face.x + a.direction.x * 60, y: a.face.y, z: a.face.z + a.direction.z * 60 }, yaw, 320, 60) },
          { at: 16, run: () => drive(null) },
        ];
      },
      pancake() {
        const tower = findPancakeTower(city.blueprint);
        if (!tower) return null;
        const centre = { x: tower.x, y: tower.y0 + tower.h * 0.38, z: tower.z };
        return [
          { at: 0, run: () => watch(centre, tower.yaw, 300, 20) },
          {
            at: 1.2,
            run: () => {
              destruction.damageBuilding(tower.building, {
                kind: 'blast', shape: { type: 'sphere', centre, radius: Math.min(tower.w, tower.d) * 0.62 },
                energy: 4e9, speed: 0, impulse: 0, generation: 0,
              }, centre);
            },
          },
          { at: 14, run: () => drive(null) },
        ];
      },
      slam() {
        const site = findSlamSite(city.blueprint, city.physics);
        if (!site) return null;
        return [
          { at: 0, run: () => { flight.place(new Vector3(site.x, site.y + 160, site.z), 0.4, 0, 20); rig.snapTo(flight.view); drive({}); } },
          { at: 0.6, run: () => powers.pressSlam() },
          { at: 3.2, run: () => watch(site, 0.4, 230, 60) },
          { at: 14, run: () => drive(null) },
        ];
      },
      throw() {
        const a = findSmashApproach(city.blueprint, city.physics);
        const target = findDominoApproach(city.blueprint, city.physics);
        if (!a || !target) return null;
        return [
          // Make rubble first, then pick the heaviest liftable piece and hurl it at a tower.
          { at: 0, run: () => flyAt(a.from, a.direction, 108) },
          { at: 1, run: () => drive({ brake: true }) },
          {
            at: 9,
            run: () => {
              const pieces = destruction.fragmentsNear(a.face, 260).filter((p) => p.level > 0 && !p.debris && p.massReal <= ctx.content.powers.grab.maxMass);
              pieces.sort((x, y) => y.massReal - x.massReal);
              const piece = pieces[0];
              if (!piece) return;
              const toward = new Vector3(target.face.x - piece.centre.x, 0, target.face.z - piece.centre.z).normalize();
              flight.respawn(new Vector3(piece.centre.x - toward.x * 6, piece.centre.y + 2, piece.centre.z - toward.z * 6), Math.atan2(toward.x, toward.z));
              rig.snapTo(flight.view);
              powers.pressGrab();
            },
          },
          {
            at: 10.2,
            run: () => {
              const from = flight.model.position;
              powers.aim.set(target.face.x - from.x, target.face.y - from.y, target.face.z - from.z).normalize();
              powers.pressGrab();
            },
          },
          { at: 18, run: () => drive(null) },
        ];
      },
    };

    const service: DemoScenesService = {
      get playing() {
        return playing;
      },
      play(name) {
        if (flow.state === 'title') flow.start();
        flow.restart();
        const script = scripts[name]();
        if (!script) {
          hud.toast('That scene needs a different city');
          return false;
        }
        steps = script;
        clock = 0;
        playing = name;
        hud.toast(SCENARIOS.find((s) => s.name === name)!.label, 2.5);
        return true;
      },
    };
    ctx.services.provide(DemoScenesToken, service);

    const stop = (): void => {
      steps = [];
      playing = null;
      drive(null);
    };
    ctx.events.on('game:state', ({ state }) => {
      if (state !== 'flying' && playing) stop();
    });
    ctx.systems.addFrame({
      name: 'demo-scenes',
      phase: FramePhase.BeforeSim,
      frame(realDt) {
        if (!playing) return;
        // The player steering takes over.
        const input = controls.input.state;
        if (Math.hypot(input.steerX, input.steerY) > 0.4 || input.boost) {
          stop();
          return;
        }
        clock += realDt * ctx.loop.timeScale;
        while (steps.length > 0 && steps[0]!.at <= clock) steps.shift()!.run();
        if (steps.length === 0) stop();
      },
    });

    mountSceneMenu(service);
    const requested = new URLSearchParams(location.search).get('scenario') as ScenarioName | null;
    if (requested && SCENARIOS.some((s) => s.name === requested) && !ctx.testMode) {
      // After the first frame, so every system has settled.
      requestAnimationFrame(() => service.play(requested));
    }
  },
};

/** "Demo scenes" buttons on the title and pause screens. */
function mountSceneMenu(service: DemoScenesService): void {
  const style = document.createElement('style');
  style.textContent = `
    .scene-menu { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 14px; pointer-events: auto; }
    .scene-menu p { width: 100%; margin: 0 0 2px; text-align: center; font: 600 10px/1 var(--font-ui, system-ui); letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink-faint, rgba(255,246,234,0.5)); }
    .scene-menu button { padding: 7px 13px; font-size: 12px; }`;
  document.head.append(style);
  for (const selector of ['.title-action', '.pause-actions']) {
    const host = document.querySelector(selector);
    if (!host) continue;
    const menu = document.createElement('div');
    menu.className = 'scene-menu';
    menu.innerHTML = '<p>Demo scenes</p>';
    for (const scene of SCENARIOS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quiet-button';
      button.textContent = scene.label;
      button.addEventListener('click', () => service.play(scene.name));
      menu.append(button);
    }
    host.after(menu);
  }
}
