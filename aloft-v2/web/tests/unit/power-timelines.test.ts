import { describe, expect, it } from 'vitest';
import { GrabTimeline, SlamTimeline, type PowerEvent } from '../../src/core/power-timelines';
import { loadContent } from '../../src/engine/content-library';

const { slam: slamTuning, grab: grabTuning } = loadContent().powers;
const DT = 1 / 60;

function run(timeline: SlamTimeline | GrabTimeline, seconds: number): PowerEvent[] {
  const events: PowerEvent[] = [];
  for (let t = 0; t < seconds - 1e-9; t += DT) events.push(...timeline.step(DT));
  return events;
}

describe('slam timeline', () => {
  it('winds up, dives, lands, recovers and cools down', () => {
    const slam = new SlamTimeline(slamTuning);
    expect(slam.press(150)).toBe(true);
    expect(slam.phase).toBe('windup');
    expect(slam.controlsHero).toBe(true);
    expect(run(slam, slamTuning.windup + DT)).toEqual([{ type: 'slam-dive' }]);
    expect(slam.phase).toBe('dive');
    slam.landed();
    expect(run(slam, DT * 2)).toEqual([{ type: 'slam-impact', instant: false }]);
    expect(slam.phase).toBe('recover');
    run(slam, slamTuning.recover + DT);
    expect(slam.phase).toBe('cooldown');
    expect(slam.controlsHero).toBe(false);
    expect(slam.press(150)).toBe(false);
    run(slam, slamTuning.cooldown + DT);
    expect(slam.phase).toBe('ready');
    expect(slam.cooldownShare).toBe(0);
  });

  it('lands at once near the ground', () => {
    const slam = new SlamTimeline(slamTuning);
    slam.press(slamTuning.instantBelow - 1);
    expect(slam.phase).toBe('impact');
    expect(slam.step(DT)).toEqual([{ type: 'slam-impact', instant: true }]);
  });

  it('a dive that never lands still ends', () => {
    const slam = new SlamTimeline(slamTuning);
    slam.press(500);
    run(slam, slamTuning.windup + slamTuning.maxDive + 0.1);
    expect(['impact', 'recover']).toContain(slam.phase);
  });
});

describe('grab timeline', () => {
  it('grabs, winds up the throw and releases once', () => {
    const grab = new GrabTimeline(grabTuning);
    expect(grab.press()).toBe('grab');
    grab.grabbed();
    expect(grab.phase).toBe('holding');
    expect(grab.press()).toBe('throw');
    expect(grab.press()).toBeNull();
    expect(run(grab, grabTuning.throwWindup + DT)).toEqual([{ type: 'grab-throw' }]);
    run(grab, DT);
    expect(grab.phase).toBe('empty');
  });

  it('a failed grab leaves it empty; a lost piece empties it', () => {
    const grab = new GrabTimeline(grabTuning);
    grab.press();
    expect(grab.phase).toBe('empty');
    grab.grabbed();
    grab.lost();
    expect(grab.phase).toBe('empty');
  });
});
