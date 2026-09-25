import { describe, expect, it } from 'vitest';
import { DEFAULT_COMFORT, FreeLook, viewRollShare, viewVisibility } from '../../src/core/view-state';
import { loadContent } from '../../src/engine/content-library';

const tuning = loadContent().camera.freeLook;
const DT = 1 / 60;

describe('free look', () => {
  it('turns the head up to its limits and no further', () => {
    const look = new FreeLook(tuning);
    for (let i = 0; i < 120; i++) look.step(DT, { active: true, x: 3, y: -3 });
    expect(look.yaw).toBeCloseTo(tuning.maxYaw, 3);
    expect(look.pitch).toBeCloseTo(-tuning.maxPitch, 3);
  });

  it('springs back to centre within the return time, without overshooting', () => {
    const look = new FreeLook(tuning);
    for (let i = 0; i < 120; i++) look.step(DT, { active: true, x: 1, y: 0.5 });
    const start = look.yaw;
    let minimum = Infinity;
    const steps = Math.round(tuning.returnTime / DT);
    for (let i = 0; i < steps; i++) {
      look.step(DT, { active: false, x: 0, y: 0 });
      minimum = Math.min(minimum, look.yaw);
    }
    expect(Math.abs(look.yaw)).toBeLessThan(Math.abs(start) * 0.05);
    for (let i = 0; i < 120; i++) {
      look.step(DT, { active: false, x: 0, y: 0 });
      minimum = Math.min(minimum, look.yaw);
    }
    expect(minimum).toBeGreaterThan(-Math.abs(start) * 0.02);
    expect(Math.abs(look.yaw)).toBeLessThan(1e-4);
  });

  it('is stable and finite at any frame time', () => {
    const look = new FreeLook(tuning);
    for (const dt of [1 / 240, 1 / 30, 0.1, 0.5]) {
      for (let i = 0; i < 50; i++) look.step(dt, { active: i % 7 < 3, x: Math.sin(i), y: Math.cos(i) });
      expect(Number.isFinite(look.yaw) && Number.isFinite(look.pitch)).toBe(true);
      expect(Math.abs(look.yaw)).toBeLessThanOrEqual(tuning.maxYaw + 1e-9);
    }
  });
});

describe('view blending', () => {
  it('hides the body past 0.6 and fades the arms in from 0.7', () => {
    expect(viewVisibility(0)).toEqual({ body: true, arms: 0 });
    expect(viewVisibility(0.6).body).toBe(true);
    expect(viewVisibility(0.61).body).toBe(false);
    expect(viewVisibility(0.7).arms).toBe(0);
    expect(viewVisibility(1).arms).toBe(1);
  });

  it('applies the comfort roll share and horizon lock in first person only', () => {
    expect(viewRollShare(0.28, 0, DEFAULT_COMFORT)).toBe(0.28);
    expect(viewRollShare(0.28, 1, DEFAULT_COMFORT)).toBe(0.5);
    expect(viewRollShare(0.28, 1, { ...DEFAULT_COMFORT, horizonLock: true })).toBe(0);
  });
});
