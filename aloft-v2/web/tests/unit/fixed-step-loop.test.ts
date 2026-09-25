import { describe, expect, test } from 'vitest';
import { FlightModel } from '../../src/core/flight-model';
import { Vector3 } from '../../src/core/math';
import { loadContent } from '../../src/engine/content-library';
import { FixedStepLoop } from '../../src/engine/fixed-step-loop';
import { createBoxWorld } from '../conformance/box-world';

const FLIGHT = loadContent().flight;
const loopOptions = { stepsPerSecond: 60, maxStepsPerFrame: 4, maxFrameDelta: 0.1 };

function simulateAtFrameRate(hz: number, seconds: number): { steps: number; position: number[]; speed: number } {
  const loop = new FixedStepLoop(loopOptions);
  const model = new FlightModel(createBoxWorld(null), FLIGHT);
  model.reset(new Vector3(0, 300, 0), 0.3);
  model.launch();
  const frames = Math.round(seconds * hz);
  for (let i = 0; i < frames; i++) {
    loop.advance(1 / hz, (dt) => model.update(dt, { steerX: 0.4, steerY: 0.2, boost: true, brake: false }));
  }
  return { steps: loop.stepCount, position: model.position.toArray(), speed: model.speed };
}

describe('fixed-step loop', () => {
  test('30, 60 and 144 Hz displays give the identical simulation after 10 s', () => {
    const at60 = simulateAtFrameRate(60, 10);
    expect(at60.steps).toBe(600);
    for (const hz of [30, 144]) {
      const other = simulateAtFrameRate(hz, 10);
      expect(other.steps).toBe(600);
      expect(other.position).toEqual(at60.position);
      expect(other.speed).toBe(at60.speed);
    }
  });

  test('slow motion at 0.12x steps every 8 or 9 frames with a smoothly rising alpha', () => {
    const loop = new FixedStepLoop(loopOptions);
    loop.timeScale = 0.12;
    const stepFrames: number[] = [];
    let lastAlpha = 0;
    for (let frame = 0; frame < 120; frame++) {
      let stepped = false;
      const alpha = loop.advance(1 / 60, () => (stepped = true));
      if (stepped) stepFrames.push(frame);
      else expect(alpha).toBeGreaterThan(lastAlpha);
      lastAlpha = alpha;
    }
    const gaps = stepFrames.slice(1).map((f, i) => f - stepFrames[i]!);
    expect(gaps.length).toBeGreaterThan(10);
    for (const gap of gaps) expect(gap === 8 || gap === 9).toBe(true);
  });

  test('a long stall runs at most maxStepsPerFrame and drops the rest instead of spiralling', () => {
    const loop = new FixedStepLoop(loopOptions);
    let steps = 0;
    loop.advance(5, () => steps++); // clamped to 0.1 s = 6 steps, capped at 4
    expect(steps).toBe(4);
    steps = 0;
    loop.advance(1 / 60, () => steps++);
    expect(steps).toBe(1);
  });

  test('alpha stays in [0, 1) and pause (timeScale 0) freezes the sim', () => {
    const loop = new FixedStepLoop(loopOptions);
    for (let i = 0; i < 50; i++) {
      const alpha = loop.advance(0.0071, () => undefined);
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThan(1);
    }
    loop.timeScale = 0;
    const before = loop.stepCount;
    for (let i = 0; i < 30; i++) loop.advance(1 / 60, () => undefined);
    expect(loop.stepCount).toBe(before);
  });

  test('garbage frame times are ignored', () => {
    const loop = new FixedStepLoop(loopOptions);
    let steps = 0;
    for (const dt of [NaN, -1, Infinity]) loop.advance(dt, () => steps++);
    expect(steps).toBe(0);
  });
});
