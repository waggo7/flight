import { describe, expect, test } from 'vitest';
import { generateCityBlueprint } from '../../src/core/city-blueprint';
import { IslandHeights } from '../../src/core/island-terrain-height';
import { boxStoreyLayout } from '../../src/core/storey-layout';
import { splitBoxIntoChunks } from '../../src/present/render/city/chunk-instances';
import { EXTERIOR } from '../../src/present/render/city/facade-material';

const heights = new IslandHeights();
const blueprint = generateCityBlueprint((x, z) => heights.heightAt(x, z));
const tallGlass = blueprint.boxes.filter((b) => b.style === 0 && b.h > 60).sort((a, b) => b.h - a.h)[3]!;
const twistSlab = blueprint.boxes.find((b) => b.yaw > 0.5)!;

describe('splitting a piece into chunks', () => {
  for (const [name, piece] of [['a tall glass tier', tallGlass], ['a rotated twist slab', twistSlab]] as const) {
    test(`${name}: chunks tile the piece exactly`, () => {
      const layout = boxStoreyLayout(piece);
      const chunks = splitBoxIntoChunks(piece);
      expect(chunks).toHaveLength(layout.storeys * layout.baysX * layout.baysZ);
      const volume = chunks.reduce((sum, c) => sum + c.width * c.height * c.depth, 0);
      expect(volume).toBeCloseTo(piece.w * piece.h * piece.d, 6);
      // Offsets stay inside the tier and every chunk keeps the piece's facade identity.
      for (const c of chunks) {
        expect(c.offsetX).toBeGreaterThanOrEqual(-1e-9);
        expect(c.offsetX + c.width).toBeLessThanOrEqual(piece.w + 1e-9);
        expect(c.offsetY + c.height).toBeLessThanOrEqual(piece.h + 1e-9);
        expect(c.seed).toBe(piece.seed);
        expect(c.tierWidth).toBe(piece.w);
      }
      // Chunk centres rotate with the piece and stay within its footprint radius.
      const reach = Math.hypot(piece.w, piece.d) / 2;
      for (const c of chunks) expect(Math.hypot(c.x - piece.x, c.z - piece.z)).toBeLessThanOrEqual(reach + 1e-6);
    });
  }

  test('only faces on the outside of the piece are marked exterior', () => {
    const layout = boxStoreyLayout(tallGlass);
    const chunks = splitBoxIntoChunks(tallGlass);
    const count = (bit: number): number => chunks.filter((c) => (c.exteriorMask & bit) !== 0).length;
    expect(count(EXTERIOR.px)).toBe(layout.storeys * layout.baysZ);
    expect(count(EXTERIOR.py)).toBe(layout.baysX * layout.baysZ);
    expect(count(EXTERIOR.ny)).toBe(0);
  });

  test('a storey range makes only those storeys', () => {
    const layout = boxStoreyLayout(tallGlass);
    const chunks = splitBoxIntoChunks(tallGlass, { storeyFrom: 2, storeyTo: 4 });
    expect(chunks).toHaveLength(2 * layout.baysX * layout.baysZ);
    expect(Math.min(...chunks.map((c) => c.offsetY))).toBeCloseTo(2 * layout.storeyHeight, 9);
  });
});
