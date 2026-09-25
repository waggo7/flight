import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { generateCityBlueprint, type CityBlueprint } from '../../src/core/city-blueprint';
import { IslandHeights } from '../../src/core/island-terrain-height';

// v2's blueprint must reproduce v1's city exactly (same seed, same draw order). The fixture was
// made by scripts/v1-city-digest.mjs from the frozen v1 source.

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/v1-city-digest.json', import.meta.url)), 'utf8')) as {
  counts: Record<string, number>;
  sha256: string;
};

function canonical(city: CityBlueprint) {
  return {
    boxes: city.boxes.map((b) => [b.building, b.x, b.z, b.w, b.d, b.y0, b.h, b.yaw, b.style, b.role, b.color, b.glass, b.seed, b.lit]),
    rounds: city.rounds.map((r) => [r.building, r.x, r.z, r.radius, r.y0, r.h, r.style, r.role, r.color, r.glass, r.seed, r.lit]),
    spires: city.spires.map((s) => [s.building, s.x, s.z, s.y, s.height, s.radius]),
    beacons: city.beacons.map((b) => [b.x, b.y, b.z]),
    colliders: city.colliders.map((c) => [c.kind, c.role, c.building, c.minX, c.maxX, c.minY, c.maxY, c.minZ, c.maxZ]),
    buildings: city.buildings.map((b) => [b.id, b.x, b.z, b.pieces.map((p) => `${p.kind}:${p.index}`).join(',')]),
  };
}

const heights = new IslandHeights();
const city = generateCityBlueprint((x, z) => heights.heightAt(x, z));

describe('city blueprint', () => {
  test('has v1’s counts', () => {
    const counts = Object.fromEntries(Object.entries(canonical(city)).map(([k, v]) => [k, v.length]));
    expect(counts).toEqual(fixture.counts);
  });

  test('reproduces v1’s city exactly (digest)', () => {
    const digest = createHash('sha256').update(JSON.stringify(canonical(city))).digest('hex');
    expect(digest).toBe(fixture.sha256);
  });

  test('landmarks reach their v1 heights and every collider belongs to its building', () => {
    expect(city.landmarks.spire.top).toBeCloseTo(547, 0);
    expect(city.landmarks.twist.top).toBeCloseTo(433.6, 1);
    expect(city.landmarks.round.top).toBeCloseTo(417, 0);
    city.buildings.forEach((building) => {
      for (const index of building.colliders) expect(city.colliders[index]!.building).toBe(building.id);
    });
  });

  test('is deterministic', () => {
    const again = generateCityBlueprint((x, z) => heights.heightAt(x, z));
    expect(again.boxes.length).toBe(city.boxes.length);
    expect(again.boxes[1234]).toEqual(city.boxes[1234]);
  });
});
