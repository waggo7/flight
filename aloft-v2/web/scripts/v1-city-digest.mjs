// One-off: dump v1's generated city (repo root src/) as a digest fixture, so the v2 blueprint
// can prove it reproduces v1 exactly. Run from aloft-v2/web: node scripts/v1-city-digest.mjs
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IslandTerrain } from '../../../src/island-terrain.js';
import { CitySkyline } from '../../../src/city-skyline.js';

export function canonicalCity(city) {
  return {
    boxes: city.boxes.map((b) => [b.building, b.x, b.z, b.w, b.d, b.y0, b.h, b.yaw, b.style, b.role, b.color, b.glass, b.seed, b.lit]),
    rounds: city.rounds.map((r) => [r.building, r.x, r.z, r.radius, r.y0, r.h, r.style, r.role, r.color, r.glass, r.seed, r.lit]),
    spires: city.spires.map((s) => [s.building, s.x, s.z, s.y, s.height, s.radius]),
    beacons: city.beacons.map((b) => [b.x, b.y, b.z]),
    colliders: city.colliders.map((c) => [c.kind, c.role, c.building, c.minX, c.maxX, c.minY, c.maxY, c.minZ, c.maxZ]),
    buildings: city.buildings.map((b) => [b.id, b.x, b.z, b.pieces.map((p) => `${p.kind}:${p.index}`).join(',')]),
  };
}

const city = new CitySkyline(new IslandTerrain());
const canonical = canonicalCity(city);
const sha256 = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
const summary = Object.fromEntries(Object.entries(canonical).map(([k, v]) => [k, v.length]));
const target = fileURLToPath(new URL('../tests/fixtures/v1-city-digest.json', import.meta.url));
writeFileSync(target, `${JSON.stringify({ source: 'v1 src/city-skyline.js (seed 2024)', counts: summary, sha256 }, null, 2)}\n`);
console.log(summary, sha256);
