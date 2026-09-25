import { beforeAll, describe, expect, test } from 'vitest';
import { generateCityBlueprint, type CityBlueprint } from '../../src/core/city-blueprint';
import { IslandHeights } from '../../src/core/island-terrain-height';
import { loadRapier, type Rapier } from '../../src/sim/physics-world';
import { content, destructionScene } from './destruction-scene';

// The real city: smash the tallest towers the hero can reach, let them fall into the streets, and
// check the invariants and the budgets while they do.

let rapier: Rapier;
let blueprint: CityBlueprint;
beforeAll(async () => {
  rapier = await loadRapier();
  const heights = new IslandHeights();
  blueprint = generateCityBlueprint((x, z) => heights.heightAt(x, z));
});

function reachableTowers(scene: ReturnType<typeof destructionScene>, count: number) {
  const towers = blueprint.boxes.filter((b) => b.role === 'tower' && b.collide && b.h > 90 && Math.min(b.w, b.d) > 18).sort((a, b) => b.h - a.h);
  const found: { from: { x: number; y: number; z: number }; dir: { x: number; y: number; z: number }; building: number }[] = [];
  for (const tower of towers) {
    const dir = { x: Math.sin(tower.yaw), y: 0, z: Math.cos(tower.yaw) };
    const y = tower.y0 + tower.h * 0.45;
    const from = { x: tower.x - dir.x * (tower.d / 2 + 60), y, z: tower.z - dir.z * (tower.d / 2 + 60) };
    const hit = scene.physics.world.castRay(new rapier.Ray(from, dir), 65, true, undefined, scene.physics.groups.heroQuery);
    if (!hit || scene.physics.ownerOf(hit.collider)?.building !== tower.building) continue;
    if (found.some((f) => Math.hypot(f.from.x - from.x, f.from.z - from.z) < 400)) continue; // spread them out
    found.push({ from, dir, building: tower.building });
    if (found.length >= count) break;
  }
  return found;
}

describe('collapses in the real city', () => {
  test('three simultaneous boost smashes: invariants, budgets and step time', () => {
    const scene = destructionScene(rapier, blueprint);
    const targets = reachableTowers(scene, 3);
    expect(targets.length).toBe(3);
    for (const t of targets) expect(scene.heroHit(t.from, t.dir, 108)?.brokeThrough).toBe(true);

    const motion = content.destruction.motion;
    const stepMs: number[] = [];
    let maxBodies = 0;
    for (let s = 0; s < 60 * 12; s++) {
      const started = performance.now();
      scene.step();
      stepMs.push(performance.now() - started);
      maxBodies = Math.max(maxBodies, scene.system.fragmentCount);
    }
    stepMs.sort((a, b) => a - b);
    const p95 = stepMs[Math.floor(stepMs.length * 0.95)]!;
    const failures = scene.log.filter((e) => e.type === 'destruction:failure').length;
    const knockOns = scene.log.filter((e) => e.type === 'destruction:damage' && (e.payload as { generation: number }).generation > 0).length;
    console.log(`city collapse: ${failures} failures, ${knockOns} knock-on hits, max ${maxBodies} loose bodies, step p50 ${stepMs[stepMs.length >> 1]!.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);

    expect(failures).toBeGreaterThanOrEqual(3);
    expect(maxBodies).toBeLessThanOrEqual(motion.chunkBodies.desktop + motion.debrisBodies.desktop + 30);
    let finite = true;
    let below = 0;
    scene.physics.world.forEachRigidBody((body) => {
      if (!body.isDynamic()) return;
      const com = body.worldCom();
      if (![com.x, com.y, com.z].every(Number.isFinite)) finite = false;
      if (com.y < -3) below++;
    });
    expect(finite).toBe(true);
    expect(below).toBe(0);
    // Node on a shared CI runner: a loose ceiling here; the browser budget is checked in-game (F3).
    expect(p95).toBeLessThan(25);
  });
});
