import { describe, expect, test } from 'vitest';
import { generateCityBlueprint } from '../../src/core/city-blueprint';
import { FlightModel } from '../../src/core/flight-model';
import { IslandHeights } from '../../src/core/island-terrain-height';
import { Vector3 } from '../../src/core/math';
import { loadContent } from '../../src/engine/content-library';
import { CityCollisionGrid } from '../../src/sim/city-collision-grid';

const heights = new IslandHeights();
const blueprint = generateCityBlueprint((x, z) => heights.heightAt(x, z));
const grid = new CityCollisionGrid(blueprint, heights);
const spire = blueprint.landmarks.spire;
const FLIGHT = loadContent().flight;

describe('city collision grid (M1 stand-in for Rapier)', () => {
  test('has every blueprint collider', () => {
    expect(grid.colliders).toHaveLength(blueprint.colliders.length);
  });

  test('a sphere inside the spire landmark is pushed out and reports it', () => {
    const p = new Vector3(spire.x + 22.5, 60, spire.z);
    const normal = new Vector3();
    const hit = grid.resolveSphere(p, p.clone(), 1.2, normal);
    expect(hit?.building).toBe(blueprint.buildings.find((b) => b.x === spire.x && b.z === spire.z)?.id);
    expect(p.x).toBeGreaterThan(spire.x + 23 + 1.2 - 1e-6);
    expect(normal.x).toBeCloseTo(1, 5);
  });

  test('a ray down onto a roof agrees with floorAt, and a ray starting inside a building stops at once', () => {
    const top = grid.floorAt(spire.x, spire.z, 5000);
    expect(top).toBeGreaterThan(400);
    expect(grid.raycast(new Vector3(spire.x, 700, spire.z), new Vector3(0, -1, 0), 1000)).toBeCloseTo(700 - top, 6);
    expect(grid.raycast(new Vector3(spire.x, 30, spire.z), new Vector3(1, 0, 0), 400)).toBe(0);
  });

  test('open sky is clear and far from surfaces', () => {
    const sky = new Vector3(0, 900, 0);
    expect(grid.isClear(sky, 10)).toBe(true);
    expect(grid.nearestSurface(sky, 16)).toBe(Infinity);
    expect(grid.groundHeight(0, 0)).toBeCloseTo(4, 5);
  });

  test('boosting into the spire glances off without passing through', () => {
    const model = new FlightModel(grid, FLIGHT);
    model.reset(new Vector3(spire.x, 80, spire.z - 200), 0);
    model.launch();
    for (let i = 0; i < 360; i++) model.update(1 / 60, { steerX: 0, steerY: 0, boost: true, brake: false });
    const p = model.position;
    const inside = Math.abs(p.x - spire.x) < 23 && Math.abs(p.z - spire.z) < 23 && p.y < 72;
    expect(inside).toBe(false);
    expect(model.takeEvents().some((e) => e.type === 'impact')).toBe(true);
  });
});
