import type { Feature } from '../engine/game-context';
import { FramePhase } from '../engine/system-phases';
import { ControlsToken } from './controls-feature';
import { FlightToken } from './flight-feature';
import { HudToken } from './hud-feature';
import { SceneToken } from './scene-feature';
import { SparksToken } from './sparks-feature';

// Feeds the HUD every frame (speed, altitude, reticle, next-spark marker), shows the spark count
// and toasts, and coaches new players with one hint at a time until they've done each thing.

const HINTS_KEY = 'aloft-v2-hints-seen';
const HINT_ORDER: readonly (readonly [HintKey, number])[] = [['steer', 2.5], ['boost', 6], ['sparks', 12], ['hover', 28]];
type HintKey = 'steer' | 'boost' | 'sparks' | 'hover';

function readHints(testMode: boolean): Set<string> {
  if (testMode) return new Set(HINT_ORDER.map(([key]) => key));
  try {
    const raw = localStorage.getItem(HINTS_KEY);
    const keys: unknown = raw ? (JSON.parse(raw) as { keys?: unknown }).keys : [];
    return new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

export const flightHudFeature: Feature = {
  name: 'flight-hud',
  install(ctx) {
    const hud = ctx.services.require(HudToken);
    const flight = ctx.services.require(FlightToken);
    const controls = ctx.services.require(ControlsToken);
    const sparks = ctx.services.require(SparksToken);
    const { camera } = ctx.services.require(SceneToken);
    const input = controls.input;
    hud.setSparks(0, sparks.total);

    const seen = readHints(ctx.testMode);
    const coach = { flightTime: 0, steerTime: 0, boostTime: 0, collected: 0, hovered: false };
    const markHint = (key: HintKey): void => {
      if (seen.has(key)) return;
      seen.add(key);
      try {
        localStorage.setItem(HINTS_KEY, JSON.stringify({ keys: [...seen] }));
      } catch {
        // Storage unavailable: the hint just shows again next visit.
      }
      hud.clearHint(key);
    };
    const hintText = (key: HintKey): string => {
      const touch = input.device === 'touch';
      const pad = input.device === 'gamepad';
      switch (key) {
        case 'steer':
          return touch ? 'Drag on the left to steer' : pad ? 'Left stick to steer' : 'Move the mouse to steer — or use WASD';
        case 'boost':
          return touch ? 'Hold the right side to boost' : pad ? 'Hold A or the right trigger to boost' : 'Hold click or Space to boost';
        case 'sparks':
          return 'Fly through the glowing sparks';
        case 'hover':
          return touch ? 'Hold Hover to slow down and float' : pad ? 'Hold B or the left trigger to hover' : 'Hold right-click or Shift to slow down and hover';
      }
    };

    ctx.events.on('flight:event', (event) => {
      if (event.type === 'hover') coach.hovered = true;
      else if (event.type === 'edge') hud.toast('Turning back toward the city');
    });
    ctx.events.on('sparks:event', ({ event, collected, total, trails }) => {
      if (event.type === 'respawn') {
        hud.setSparks(0, total);
        hud.toast('The sparks have returned');
        return;
      }
      coach.collected++;
      hud.setSparks(collected, total, true);
      if (event.allDone) hud.toast('Every spark found', 4.5);
      else if (event.trailDone) hud.toast(`Trail complete · ${event.trailsDone} of ${trails}`);
    });
    ctx.events.on('game:restart', () => hud.setSparks(0, sparks.total));

    ctx.systems.addFrame({
      name: 'flight-hud',
      phase: FramePhase.Present,
      frame(realDt) {
        hud.setDevice(input.device);
        if (flight.active) {
          const simDt = realDt * ctx.loop.timeScale;
          const c = controls.current;
          coach.flightTime += simDt;
          if (Math.hypot(c.steerX, c.steerY) > 0.35) coach.steerTime += simDt;
          if (c.boost) coach.boostTime += simDt;
          if (coach.steerTime > 0.8) markHint('steer');
          if (coach.boostTime > 1) markHint('boost');
          if (coach.collected > 0 || coach.flightTime > 40) markHint('sparks');
          if (coach.hovered) markHint('hover');
          const next = HINT_ORDER.find(([key, after]) => !seen.has(key) && coach.flightTime > after);
          if (next) hud.showHint(next[0], hintText(next[0]));
          else hud.clearHint();
        }
        hud.update(realDt, {
          speed: flight.view.speed,
          altitude: flight.view.groundClearance,
          input,
          device: input.device,
          flying: flight.active,
          camera,
          nextSpark: sparks.nearestUncollected(flight.view.position),
        });
      },
    });
  },
};
