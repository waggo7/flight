import { FacadeStyle, type BoxPiece, type CityBlueprint, type PieceRef, type PieceRole, type RoundPiece } from '../../src/core/city-blueprint';

// Hand-built one-building cities for destruction tests: exact sizes, no generator noise.

export interface BoxSpec {
  w: number;
  d: number;
  h: number;
  y0?: number;
  x?: number;
  z?: number;
  yaw?: number;
  style?: FacadeStyle;
  role?: PieceRole;
}

export interface RoundSpec {
  radius: number;
  h: number;
  y0?: number;
  x?: number;
  z?: number;
  style?: FacadeStyle;
  role?: PieceRole;
}

const look = { color: '#cccccc', glass: 0, seed: 0.5, lit: 0.3, building: 0, collide: true } as const;

export function syntheticCity({ boxes = [], rounds = [] }: { boxes?: BoxSpec[]; rounds?: RoundSpec[] }): CityBlueprint {
  const boxPieces: BoxPiece[] = boxes.map((b, index) => ({
    ...look, kind: 'box', index, x: b.x ?? 0, z: b.z ?? 0, w: b.w, d: b.d, y0: b.y0 ?? 4, h: b.h, yaw: b.yaw ?? 0,
    style: b.style ?? FacadeStyle.glass, role: b.role ?? 'tower',
  }));
  const roundPieces: RoundPiece[] = rounds.map((r, index) => ({
    ...look, kind: 'round', index, x: r.x ?? 0, z: r.z ?? 0, radius: r.radius, y0: r.y0 ?? 4, h: r.h,
    style: r.style ?? FacadeStyle.stone, role: r.role ?? 'tower',
  }));
  const pieces: PieceRef[] = [...boxPieces.map((b) => ({ kind: 'box' as const, index: b.index })), ...roundPieces.map((r) => ({ kind: 'round' as const, index: r.index }))];
  return {
    boxes: boxPieces, rounds: roundPieces, spires: [], beacons: [],
    buildings: [{ id: 0, x: 0, z: 0, pieces, colliders: [] }],
    colliders: [], tallest: [],
    landmarks: { spire: { i: 0, j: 0, x: 0, z: 0, top: 0 }, twist: { i: 0, j: 0, x: 0, z: 0, top: 0 }, round: { i: 0, j: 0, x: 0, z: 0, top: 0 } },
  };
}
