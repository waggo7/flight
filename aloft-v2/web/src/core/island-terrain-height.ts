import { clamp, lerp, smoothstep } from './scalar-math';
import { createNoise2D, fractalNoise } from './seeded-noise';

// The archipelago's shape: a flat city island at the centre, wild mountainous islands around
// it. The analytic shape is sampled once into a height grid; flight, physics, trees and the
// ocean's shallow-water map all read that grid so they agree with the mesh you see.
// Ported from v1 (src/island-terrain.js); the mesh builder lives in present/.

export const CITY_ISLAND = { x: 0, z: 0, radius: 1380, ground: 4 } as const;
export const CITY_BLOCK = { spacing: 72, street: 16 } as const;
export const CITY_PARK = { minX: -612, maxX: -396, minZ: 252, maxZ: 468 } as const;

export interface WildIsland {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly peak: number;
  readonly rugged: number;
}

export const WILD_ISLANDS: readonly WildIsland[] = [
  { x: 3350, z: 2550, radius: 1250, peak: 430, rugged: 1.0 },
  { x: -3150, z: 2950, radius: 950, peak: 300, rugged: 0.9 },
  { x: -2950, z: -1350, radius: 700, peak: 165, rugged: 0.75 },
  { x: 2350, z: -2300, radius: 540, peak: 115, rugged: 0.6 },
  { x: 350, z: 3950, radius: 620, peak: 200, rugged: 0.85 },
  { x: -1150, z: -3300, radius: 400, peak: 70, rugged: 0.5 },
  { x: 4300, z: -850, radius: 450, peak: 95, rugged: 0.6 },
];

export const SEABED = -44;
export const TERRAIN_SIZE = 13000;
export const TERRAIN_SEGMENTS = 360;

const shapeNoise = createNoise2D(7);
const ridgeNoise = createNoise2D(19);
/** Also used by tree placement and terrain colouring. */
export const terrainDetailNoise = createNoise2D(31);

function cityIslandHeight(x: number, z: number): number {
  const dx = x - CITY_ISLAND.x;
  const dz = z - CITY_ISLAND.z;
  const distance = Math.hypot(dx, dz);
  if (distance > CITY_ISLAND.radius * 1.4) return SEABED;
  const angle = Math.atan2(dz, dx);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const coast = CITY_ISLAND.radius * (1 + 0.07 * shapeNoise(ca * 1.6 + 11.3, sa * 1.6 - 3.1) + 0.03 * shapeNoise(ca * 4.1, sa * 4.1));
  const t = (distance - coast) / 170;
  if (t < -0.3) return CITY_ISLAND.ground;
  return lerp(CITY_ISLAND.ground, SEABED, smoothstep(-0.3, 1, t));
}

function wildIslandHeight(island: WildIsland, x: number, z: number): number {
  const dx = x - island.x;
  const dz = z - island.z;
  const d = Math.hypot(dx, dz) / island.radius;
  if (d > 1.5) return SEABED;
  const warp = fractalNoise(shapeNoise, x * 0.0008 + island.x * 0.01, z * 0.0008, 3) * 0.38;
  const r = d + warp;
  const dome = Math.max(0, 1 - r);
  const shape = Math.pow(dome, 1.3);
  const ridges = 1 - Math.abs(fractalNoise(ridgeNoise, x * 0.0024, z * 0.0024, 4));
  let h = island.peak * shape * (0.7 + 0.5 * ridges * island.rugged);
  h += 8 + 6 * terrainDetailNoise(x * 0.01, z * 0.01) * shape;
  h -= (8 - SEABED) * smoothstep(0.82, 1.35, r);
  return h;
}

export function analyticHeight(x: number, z: number): number {
  let h = Math.max(SEABED + 3 * terrainDetailNoise(x * 0.002, z * 0.002), cityIslandHeight(x, z));
  for (const island of WILD_ISLANDS) {
    const dx = x - island.x;
    const dz = z - island.z;
    if (dx * dx + dz * dz > island.radius * island.radius * 2.25) continue;
    h = Math.max(h, wildIslandHeight(island, x, z));
  }
  return h;
}

/** The sampled height grid. `heightAt` matches the rendered mesh's triangulation exactly. */
export class IslandHeights {
  readonly size = TERRAIN_SIZE;
  readonly segments = TERRAIN_SEGMENTS;
  readonly cellSize = TERRAIN_SIZE / TERRAIN_SEGMENTS;
  readonly heights: Float32Array;

  constructor() {
    const verts = TERRAIN_SEGMENTS + 1;
    this.heights = new Float32Array(verts * verts);
    for (let j = 0; j < verts; j++) {
      const z = -TERRAIN_SIZE / 2 + j * this.cellSize;
      for (let i = 0; i < verts; i++) {
        const x = -TERRAIN_SIZE / 2 + i * this.cellSize;
        this.heights[j * verts + i] = analyticHeight(x, z);
      }
    }
  }

  heightAt(x: number, z: number): number {
    const verts = TERRAIN_SEGMENTS + 1;
    const fx = clamp((x + TERRAIN_SIZE / 2) / this.cellSize, 0, TERRAIN_SEGMENTS - 1e-3);
    const fz = clamp((z + TERRAIN_SIZE / 2) / this.cellSize, 0, TERRAIN_SEGMENTS - 1e-3);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const h = this.heights;
    const a = h[j * verts + i]!;
    const b = h[j * verts + i + 1]!;
    const c = h[(j + 1) * verts + i]!;
    const d = h[(j + 1) * verts + i + 1]!;
    // Match the mesh triangulation: each quad splits along its (i, j+1)–(i+1, j) diagonal.
    if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
    return d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }
}
