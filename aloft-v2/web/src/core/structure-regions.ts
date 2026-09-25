import { NodeState, type BuildingStructure, type Segment, type StructureNode } from './building-structure';
import { bayColumnStarts } from './storey-layout';

// Turns a structure's nodes into as few boxes as possible, for colliders and for drawing:
// contiguous whole storeys merge into one band, split storeys stay one box per bay. Every region
// knows which of its faces were on the building's outside (the facade shader draws the rest as
// broken concrete). Also splits regions further when a falling section breaks up.

/** Exterior-face bits, shared with the facade shader: 1 +x, 2 −x, 4 +y, 8 −y, 16 +z, 32 −z. */
export const FaceBit = { px: 1, nx: 2, py: 4, ny: 8, pz: 16, nz: 32 } as const;

export interface Region {
  segment: number;
  /** Box in the segment's local frame: x, z from its min corner, y from its base (metres). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  exteriorMask: number;
  /** The structure nodes this region stands for (empty for pieces split off after detaching). */
  nodes: number[];
  mass: number;
}

const EPS = 1e-4;

export function exteriorMask(segment: Segment, x0: number, x1: number, y1: number, z0: number, z1: number): number {
  let mask = 0;
  if (x1 >= segment.w - EPS) mask |= FaceBit.px;
  if (x0 <= EPS) mask |= FaceBit.nx;
  if (y1 >= segment.h - EPS) mask |= FaceBit.py;
  if (z1 >= segment.d - EPS) mask |= FaceBit.pz;
  if (z0 <= EPS) mask |= FaceBit.nz;
  return mask;
}

function regionOf(structure: BuildingStructure, nodes: StructureNode[]): Region {
  const segment = structure.segments[nodes[0]!.segment]!;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  let mass = 0;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x0);
    x1 = Math.max(x1, n.x1);
    y0 = Math.min(y0, n.y0);
    y1 = Math.max(y1, n.y1);
    z0 = Math.min(z0, n.z0);
    z1 = Math.max(z1, n.z1);
    mass += n.mass;
  }
  return { segment: segment.index, x0, x1, y0, y1, z0, z1, exteriorMask: exteriorMask(segment, x0, x1, y1, z0, z1), nodes: nodes.map((n) => n.id), mass };
}

/** Regions covering the nodes of one segment that pass `keep`, lowest first. */
function segmentRegions(structure: BuildingStructure, segmentIndex: number, keep: (node: StructureNode) => boolean): Region[] {
  const regions: Region[] = [];
  let band: StructureNode[] = [];
  const flush = (): void => {
    if (band.length > 0) regions.push(regionOf(structure, band));
    band = [];
  };
  for (const ids of structure.storeys[segmentIndex]!) {
    const nodes = ids.map((id) => structure.nodes[id]!);
    const whole = nodes.length === 1 && nodes[0]!.bay < 0;
    if (whole && keep(nodes[0]!)) {
      band.push(nodes[0]!);
      continue;
    }
    flush();
    for (const node of nodes) if (keep(node)) regions.push(regionOf(structure, [node]));
  }
  flush();
  return regions;
}

/** What still stands of a segment. */
export function standingRegions(structure: BuildingStructure, segmentIndex: number): Region[] {
  return segmentRegions(structure, segmentIndex, (n) => n.state === NodeState.Intact);
}

/** Regions for an explicit set of nodes (a part that has just come loose), grouped by segment. */
export function regionsOfNodes(structure: BuildingStructure, nodeIds: readonly number[]): Region[] {
  const wanted = new Set(nodeIds);
  const segments = [...new Set(nodeIds.map((id) => structure.nodes[id]!.segment))].sort((a, b) => a - b);
  return segments.flatMap((segment) => segmentRegions(structure, segment, (n) => wanted.has(n.id)));
}

export const regionVolume = (r: Region): number => (r.x1 - r.x0) * (r.y1 - r.y0) * (r.z1 - r.z0);

/** Cut a region at storey lines into bands of at most `storeysPerBand` storeys. */
export function splitIntoBands(structure: BuildingStructure, region: Region, storeysPerBand: number): Region[] {
  const segment = structure.segments[region.segment]!;
  const h = segment.layout.storeyHeight;
  const storeys = Math.max(1, Math.round((region.y1 - region.y0) / h));
  if (storeys <= storeysPerBand) return [region];
  const count = Math.ceil(storeys / storeysPerBand);
  const density = region.mass / Math.max(regionVolume(region), 1e-9);
  const bands: Region[] = [];
  for (let b = 0; b < count; b++) {
    const y0 = region.y0 + Math.round((b * storeys) / count) * h;
    const y1 = b === count - 1 ? region.y1 : region.y0 + Math.round(((b + 1) * storeys) / count) * h;
    const piece = { ...region, y0, y1, nodes: [], exteriorMask: exteriorMask(segment, region.x0, region.x1, y1, region.z0, region.z1) };
    piece.mass = regionVolume(piece) * density;
    bands.push(piece);
  }
  return bands;
}

/** Cut a region into storey × bay chunks along the segment's bay lines (round drums: storeys only). */
export function splitIntoBays(structure: BuildingStructure, region: Region): Region[] {
  const segment = structure.segments[region.segment]!;
  const { layout } = segment;
  const density = region.mass / Math.max(regionVolume(region), 1e-9);
  const cut = (lo: number, hi: number, lines: number[]): [number, number][] => {
    const inside = lines.filter((v) => v > lo + EPS && v < hi - EPS);
    const edges = [lo, ...inside, hi];
    return edges.slice(0, -1).map((v, i) => [v, edges[i + 1]!]);
  };
  const xs = segment.shape === 'round' ? [[region.x0, region.x1] as [number, number]] : cut(region.x0, region.x1, bayColumnStarts(layout.columnsX, layout.baysX).map((c) => (c * segment.w) / layout.columnsX));
  const zs = segment.shape === 'round' ? [[region.z0, region.z1] as [number, number]] : cut(region.z0, region.z1, bayColumnStarts(layout.columnsZ, layout.baysZ).map((c) => (c * segment.d) / layout.columnsZ));
  const storeyLines = Array.from({ length: layout.storeys + 1 }, (_, s) => s * layout.storeyHeight);
  const ys = cut(region.y0, region.y1, storeyLines);
  const pieces: Region[] = [];
  for (const [y0, y1] of ys) {
    for (const [x0, x1] of xs) {
      for (const [z0, z1] of zs) {
        const piece: Region = { segment: region.segment, x0, x1, y0, y1, z0, z1, exteriorMask: exteriorMask(segment, x0, x1, y1, z0, z1), nodes: [], mass: 0 };
        piece.mass = regionVolume(piece) * density;
        pieces.push(piece);
      }
    }
  }
  return pieces;
}
