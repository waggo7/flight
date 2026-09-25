import { describe, expect, test } from 'vitest';
import { FlightModel, sanitizeControls, type FlightControls } from '../../src/core/flight-model';
import { Vector3 } from '../../src/core/math';
import { loadContent } from '../../src/engine/content-library';
import { createBoxWorld } from '../conformance/box-world';

// Ported from v1 (tests/flight-model.test.js), against the new resolveSphere contract.

const FLIGHT = loadContent().flight;
const DT = 1 / 60;
const TOWER = { min: [-20, 0, 60], max: [20, 400, 100] } as { min: [number, number, number]; max: [number, number, number] };

function fly(model: FlightModel, seconds: number, input: Partial<FlightControls> = {}): void {
  const controls = { steerX: 0, steerY: 0, boost: false, brake: false, ...input };
  for (let t = 0; t < seconds; t += DT) model.update(DT, controls);
}

function launched(position = new Vector3(0, 300, 0)): FlightModel {
  const model = new FlightModel(createBoxWorld(null), FLIGHT);
  model.reset(position, 0);
  model.launch();
  return model;
}

describe('flight model', () => {
  test('launch leaves hover and settles at cruise speed', () => {
    const model = launched();
    expect(model.mode).toBe('flying');
    fly(model, 6);
    expect(Math.abs(model.speed - FLIGHT.cruiseSpeed)).toBeLessThan(1);
  });

  test('boost reaches boost speed within four seconds and fires one shockwave', () => {
    const model = launched();
    fly(model, 2);
    model.takeEvents();
    fly(model, 4, { boost: true });
    expect(model.speed).toBeGreaterThan(FLIGHT.boostSpeed * 0.97);
    expect(model.takeEvents().filter((e) => e.type === 'boom')).toHaveLength(1);
  });

  test('releasing boost glides back down to cruise, not to a stop', () => {
    const model = launched();
    fly(model, 4, { boost: true });
    fly(model, 12);
    expect(Math.abs(model.speed - FLIGHT.cruiseSpeed)).toBeLessThan(1.5);
  });

  test('full right stick turns right and banks right, within limits', () => {
    const model = launched();
    fly(model, 2);
    const startYaw = model.yaw;
    fly(model, 1.5, { steerX: 1 });
    expect(model.yaw).toBeLessThan(startYaw - 0.8);
    expect(model.bank).toBeGreaterThan(0.5);
    expect(model.bank).toBeLessThanOrEqual(FLIGHT.bankMax + 1e-6);
    expect(model.right.y).toBeLessThan(0);
  });

  test('pitch follows the stick and levels out on release', () => {
    const model = launched();
    fly(model, 3, { steerY: 1 });
    expect(model.pitch).toBeGreaterThan(FLIGHT.pitchMax * 0.9);
    fly(model, 3);
    expect(Math.abs(model.pitch)).toBeLessThan(0.03);
  });

  test('a steep dive builds speed; a steep climb bleeds it but never stalls', () => {
    const diver = launched(new Vector3(0, 2300, 0));
    fly(diver, 5, { steerY: -1 });
    expect(diver.speed).toBeGreaterThan(FLIGHT.cruiseSpeed + 15);
    const climber = launched();
    fly(climber, 8, { steerY: 1 });
    expect(climber.speed).toBeLessThan(FLIGHT.cruiseSpeed);
    expect(climber.speed).toBeGreaterThanOrEqual(FLIGHT.minFlightSpeed - 1e-6);
  });

  test('holding brake settles into a hover; boost launches again', () => {
    const model = launched();
    fly(model, 3, { boost: true });
    fly(model, 5, { brake: true });
    expect(model.mode).toBe('hover');
    expect(model.speed).toBeLessThan(1);
    fly(model, 0.1, { boost: true });
    expect(model.mode).toBe('flying');
  });

  test('diving into the sea skims the surface instead of going under', () => {
    const model = launched(new Vector3(0, 60, 0));
    fly(model, 6, { steerY: -1, boost: true });
    expect(model.position.y).toBeGreaterThanOrEqual(FLIGHT.radius - 1e-6);
    expect(model.speed).toBeGreaterThan(FLIGHT.cruiseSpeed);
    expect(model.takeEvents().some((e) => e.type === 'splash')).toBe(true);
  });

  test('flying into a tower glances off without passing through', () => {
    const model = new FlightModel(createBoxWorld(TOWER), FLIGHT);
    model.reset(new Vector3(5, 100, 0), 0);
    model.launch();
    fly(model, 4, { boost: true });
    const p = model.position;
    const inside = p.x > -20 && p.x < 20 && p.z > 60 && p.z < 100 && p.y < 400;
    expect(inside).toBe(false);
    expect(model.speed).toBeGreaterThanOrEqual(FLIGHT.minFlightSpeed);
  });

  test('a building that gives way lets the hero burst through, keeping most of their speed', () => {
    const world = createBoxWorld(TOWER, 'burst');
    const model = new FlightModel(world, FLIGHT);
    model.reset(new Vector3(0, 100, -300), 0);
    model.launch();
    fly(model, 3, { boost: true });
    expect(world.smashImpacts).toHaveLength(0);
    model.takeEvents();
    const before = model.speed;
    let smash = null;
    for (let t = 0; t < 2 && !smash; t += DT) {
      model.update(DT, { steerX: 0, steerY: 0, boost: true, brake: false });
      smash = model.takeEvents().find((e) => e.type === 'smash') ?? null;
    }
    expect(smash).not.toBeNull();
    expect(world.smashImpacts).toHaveLength(1);
    expect(Math.abs(model.speed - before * FLIGHT.smashSpeedKept)).toBeLessThan(3);
    fly(model, 1, { boost: true });
    expect(model.position.z).toBeGreaterThan(100);
    expect(Math.abs(model.yaw)).toBeLessThan(0.05);
  });

  test('a building that only dents sends the hero glancing off, marked as a dent', () => {
    const model = new FlightModel(createBoxWorld(TOWER, 'dent'), FLIGHT);
    model.reset(new Vector3(0, 100, 20), 0);
    model.launch();
    let impact = null;
    for (let t = 0; t < 3 && !impact; t += DT) {
      model.update(DT, { steerX: 0, steerY: 0, boost: false, brake: false });
      impact = model.takeEvents().find((e) => e.type === 'impact') ?? null;
    }
    expect(impact?.type === 'impact' && impact.dented).toBe(true);
    expect(model.position.z).toBeLessThan(60);
  });

  test('the world edge turns the hero back toward the city', () => {
    const model = launched(new Vector3(0, 300, FLIGHT.worldRadius - 200));
    fly(model, 60, { boost: true });
    expect(Math.hypot(model.position.x, model.position.z)).toBeLessThan(FLIGHT.worldRadius + 950);
  });

  test('garbage input and frame spikes never produce NaN', () => {
    const model = launched();
    const inputs = [{ steerX: NaN, steerY: Infinity, boost: true }, { steerX: 7, steerY: -9 }, null, { steerX: -1, steerY: 1, brake: true, boost: true }];
    for (let i = 0; i < 400; i++) model.update(i % 50 === 0 ? 0.5 : DT, inputs[i % inputs.length] as Partial<FlightControls> | null);
    for (const value of [...model.position.toArray(), ...model.velocity.toArray(), model.yaw, model.pitch, model.bank, model.speed]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(Math.abs(model.pitch)).toBeLessThanOrEqual(FLIGHT.pitchMax + 1e-6);
  });

  test('controls are clamped and made finite', () => {
    expect(sanitizeControls({ steerX: 4, steerY: -Infinity })).toEqual({ steerX: 1, steerY: 0, boost: false, brake: false });
    expect(sanitizeControls(undefined)).toEqual({ steerX: 0, steerY: 0, boost: false, brake: false });
  });

  test('reset clears events, rush and cooldowns so a restart starts clean', () => {
    const model = launched(new Vector3(0, 60, 0));
    fly(model, 3, { steerY: -1, boost: true });
    model.reset(new Vector3(0, 300, 0), 1);
    expect(model.takeEvents()).toEqual([]);
    expect(model.surfaceRush).toBe(0);
    expect(model.mode).toBe('hover');
  });
});
