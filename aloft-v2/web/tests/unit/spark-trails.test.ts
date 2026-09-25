import { Vector3 } from 'three';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { CityBlueprint } from '../../src/core/city-blueprint';
import type { IslandHeights } from '../../src/core/island-terrain-height';
import { createRandom } from '../../src/core/seeded-noise';
import { SparkTrails, type SparkCloud, type SparkWorld } from '../../src/present/render/spark-trails';

// A small stand-in world: a mountain near v1's big island, sea beyond the city, one block of
// towers across the avenue, one big cloud.
const TOWER_TOP = 120;

function stubWorld(cloud: SparkCloud | null = { x: 900, z: -700, top: 640, size: 260 }) {
  const cloudDrift = new Vector3();
  const world: SparkWorld = {
    isClear: (p, radius) => !(p.x > -60 && p.x < -10 && p.z > -640 && p.z < -300 && p.y < TOWER_TOP + radius),
    heightAt: (x, z) => {
      const mountain = 420 * Math.max(0, 1 - Math.hypot(x - 3400, z - 2500) / 900);
      const sea = Math.hypot(x, z) > 1450 ? -40 : 4;
      return Math.max(sea, mountain) + 6 * Math.sin(x * 0.004) * Math.cos(z * 0.003);
    },
    largestCloudNear: () => cloud,
    cloudDrift,
    landmarks: { twist: { x: -144, z: 144 }, spire: { x: 72, z: -72, top: 547 } },
  };
  return { world, cloudDrift };
}

const FAR_AWAY = new Vector3(1e6, 1e6, 1e6);
const CAMERA = { position: new Vector3(0, 80, -200) };

function bases(sparks: SparkTrails): number[][] {
  return sparks.sparks.map((s) => s.base.toArray());
}

describe('spark trails', () => {
  test('the v2 blueprint and terrain plug into SparkWorld as they are', () => {
    expectTypeOf<CityBlueprint['landmarks']>().toExtend<SparkWorld['landmarks']>();
    expectTypeOf<IslandHeights['heightAt']>().toExtend<SparkWorld['heightAt']>();
  });

  test('lay out the same trails on every build, with no NaN', () => {
    const first = new SparkTrails(stubWorld().world);
    const second = new SparkTrails(stubWorld().world);
    expect(first.trails.map((t) => t.name)).toEqual(['avenue', 'spiral', 'crown', 'cloud', 'sea', 'peak', 'dive']);
    expect(first.total).toBe(47);
    expect(second.total).toBe(first.total);
    expect(bases(second)).toEqual(bases(first));
    expect(bases(first).flat().every(Number.isFinite)).toBe(true);

    const seeded = () => new SparkTrails(stubWorld().world, { random: createRandom(7) });
    expect(seeded().sparks.map((s) => s.phase)).toEqual(seeded().sparks.map((s) => s.phase));
  });

  test('every spark floats above the ground, and the city trails are nudged clear of buildings', () => {
    const { world } = stubWorld();
    const sparks = new SparkTrails(world);
    for (const spark of sparks.sparks) {
      expect(spark.base.y).toBeGreaterThan(world.heightAt(spark.base.x, spark.base.z) + 5);
      if (['avenue', 'spiral', 'crown'].includes(spark.trail.name)) {
        expect(world.isClear(spark.base, 7), `${spark.trail.name} #${spark.index}`).toBe(true);
      }
    }
    // The first avenue spark started inside the stub tower and climbed out in 6 m steps.
    expect(sparks.sparks[0].base.y).toBe(56 + 12 * 6);
  });

  test('updates keep positions and instance matrices finite', () => {
    const sparks = new SparkTrails(stubWorld().world, { random: createRandom(3) });
    for (let i = 0; i < 120; i++) expect(sparks.update(1 / 60, i / 60, FAR_AWAY, CAMERA)).toEqual([]);
    expect(sparks.sparks.every((s) => s.position.toArray().every(Number.isFinite))).toBe(true);
    for (const mesh of [sparks.core, sparks.ring, sparks.halo]) {
      expect(mesh.count).toBe(47);
      expect(Array.from(mesh.instanceMatrix.array).every(Number.isFinite)).toBe(true);
    }
  });

  test('flying through the sparks collects them, finishes trails and respawns them all 6 s later', () => {
    const sparks = new SparkTrails(stubWorld().world, { random: createRandom(1) });
    const hero = new Vector3();
    let time = 0;
    const collectAt = (index: number) => {
      hero.copy(sparks.sparks[index].position);
      time += 0.5;
      return sparks.update(0.5, time, hero, CAMERA);
    };

    const [first] = collectAt(0);
    expect(first).toMatchObject({ type: 'collect', trailName: 'avenue', streak: 0, trailDone: false, allDone: false });
    const [second] = collectAt(1);
    expect(second).toMatchObject({ type: 'collect', streak: 1 });
    expect(sparks.nearestUncollected(sparks.sparks[2].position)).toBe(sparks.sparks[2].position);

    let last = second;
    for (let i = 2; i < sparks.total; i++) last = collectAt(i)[0] ?? last;
    expect(sparks.collected).toBe(sparks.total);
    expect(last).toMatchObject({ type: 'collect', trailName: 'dive', trailDone: true, trailsDone: 7, allDone: true });
    expect(sparks.nearestUncollected(hero)).toBeNull();

    expect(sparks.update(1 / 60, time + 5.9, FAR_AWAY, CAMERA)).toEqual([]);
    expect(sparks.update(1 / 60, time + 6.1, FAR_AWAY, CAMERA)).toEqual([{ type: 'respawn' }]);
    expect(sparks.collected).toBe(0);
  });

  test('the cloud trail drifts with the clouds; the rest stay put', () => {
    const { world, cloudDrift } = stubWorld();
    const sparks = new SparkTrails(world, { random: createRandom(2) });
    sparks.update(0, 10, FAR_AWAY, CAMERA);
    const before = sparks.sparks.map((s) => s.position.clone());
    cloudDrift.set(120, 0, -45);
    sparks.update(0, 10, FAR_AWAY, CAMERA);
    sparks.sparks.forEach((spark, i) => {
      const moved = spark.position.clone().sub(before[i]).toArray();
      const expected = spark.trail.drifts ? [120, 0, -45] : [0, 0, 0];
      moved.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis], 9));
    });
  });

  test('without a cloud nearby the cloud trail is left out', () => {
    const sparks = new SparkTrails(stubWorld(null).world);
    expect(sparks.trails.map((t) => t.name)).not.toContain('cloud');
    expect(sparks.total).toBe(41);
  });
});
