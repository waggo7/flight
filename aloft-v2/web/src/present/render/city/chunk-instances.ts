import type { BoxPiece } from '../../../core/city-blueprint';
import { bayColumnStarts, boxStoreyLayout } from '../../../core/storey-layout';
import { EXTERIOR } from './facade-material';
import { boxFacadeInstance } from './city-meshes';
import type { FacadeInstance } from './facade-instances';

// Splits an intact box piece into facade chunks (one storey × one bay each) that draw exactly
// like the intact piece: every chunk carries its offset within the tier and which of its faces
// were on the outside. M3 uses the same split when a building takes damage; M1 uses it to prove
// that swapping intact → chunks never pops.

export interface ChunkRange {
  storeyFrom: number;
  storeyTo: number;
}

export function splitBoxIntoChunks(piece: BoxPiece, range?: ChunkRange): FacadeInstance[] {
  const layout = boxStoreyLayout(piece);
  const intact = boxFacadeInstance(piece);
  const colStartsX = bayColumnStarts(layout.columnsX, layout.baysX);
  const colStartsZ = bayColumnStarts(layout.columnsZ, layout.baysZ);
  const colWidthX = piece.w / layout.columnsX;
  const colWidthZ = piece.d / layout.columnsZ;
  const cos = Math.cos(piece.yaw);
  const sin = Math.sin(piece.yaw);
  const from = range?.storeyFrom ?? 0;
  const to = range?.storeyTo ?? layout.storeys;
  const chunks: FacadeInstance[] = [];
  for (let s = from; s < to; s++) {
    for (let bx = 0; bx < layout.baysX; bx++) {
      for (let bz = 0; bz < layout.baysZ; bz++) {
        const x0 = colStartsX[bx]! * colWidthX;
        const x1 = colStartsX[bx + 1]! * colWidthX;
        const z0 = colStartsZ[bz]! * colWidthZ;
        const z1 = colStartsZ[bz + 1]! * colWidthZ;
        const y0 = s * layout.storeyHeight;
        let mask = 0;
        if (bx === layout.baysX - 1) mask |= EXTERIOR.px;
        if (bx === 0) mask |= EXTERIOR.nx;
        if (s === layout.storeys - 1) mask |= EXTERIOR.py;
        if (bz === layout.baysZ - 1) mask |= EXTERIOR.pz;
        if (bz === 0) mask |= EXTERIOR.nz;
        // Chunk base centre in the piece's local frame, then rotated by the piece's yaw.
        const lx = (x0 + x1) / 2 - piece.w / 2;
        const lz = (z0 + z1) / 2 - piece.d / 2;
        chunks.push({
          ...intact,
          x: piece.x + lx * cos + lz * sin,
          y: piece.y0 + y0,
          z: piece.z - lx * sin + lz * cos,
          width: x1 - x0,
          height: layout.storeyHeight,
          depth: z1 - z0,
          offsetX: x0,
          offsetY: y0,
          offsetZ: z0,
          exteriorMask: mask,
        });
      }
    }
  }
  return chunks;
}
