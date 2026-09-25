import { FacadeStyle } from './city-blueprint';

// How a building piece divides into storeys and bays. One storey is one window row and a bay is
// a whole number of window columns, so the facade shader and the destruction chunks agree: breaks
// always fall on floor lines and mullions, and a chunk carries on the windows exactly where the
// intact building had them.

export interface FacadeGrid {
  /** Target storey height (m); the real one is stretched so a whole number fit the piece. */
  rowPitch: number;
  /** Target window column width (m). */
  cellWidth: number;
  /** Window columns per structural bay. */
  bayColumns: number;
}

export const FACADE_GRIDS: Readonly<Record<FacadeStyle, FacadeGrid>> = {
  [FacadeStyle.glass]: { rowPitch: 3.45, cellWidth: 1.6, bayColumns: 4 },
  [FacadeStyle.stone]: { rowPitch: 3.7, cellWidth: 2.9, bayColumns: 2 },
  [FacadeStyle.plain]: { rowPitch: 3.7, cellWidth: 2.9, bayColumns: 2 },
};

export interface StoreyLayout {
  storeys: number;
  storeyHeight: number;
  /** Window columns across the piece's local x (width) and z (depth); rounds use columnsX around the circumference. */
  columnsX: number;
  columnsZ: number;
  /** Structural bays across x and z (each a whole number of columns). */
  baysX: number;
  baysZ: number;
}

const wholeCount = (length: number, unit: number, minimum = 1): number => Math.max(minimum, Math.round(length / unit));

export function boxStoreyLayout(piece: { w: number; d: number; h: number; style: FacadeStyle }): StoreyLayout {
  const grid = FACADE_GRIDS[piece.style];
  const storeys = wholeCount(piece.h, grid.rowPitch);
  const columnsX = wholeCount(piece.w, grid.cellWidth);
  const columnsZ = wholeCount(piece.d, grid.cellWidth);
  return {
    storeys,
    storeyHeight: piece.h / storeys,
    columnsX,
    columnsZ,
    baysX: wholeCount(columnsX, grid.bayColumns),
    baysZ: wholeCount(columnsZ, grid.bayColumns),
  };
}

/** Round towers: columns run around the circumference (at least 8, as in v1); no bays (they break as whole drums). */
export function roundStoreyLayout(piece: { radius: number; h: number; style: FacadeStyle }): StoreyLayout {
  const grid = FACADE_GRIDS[piece.style];
  const storeys = wholeCount(piece.h, grid.rowPitch);
  const columns = wholeCount(2 * Math.PI * piece.radius, grid.cellWidth, 8);
  return { storeys, storeyHeight: piece.h / storeys, columnsX: columns, columnsZ: columns, baysX: 1, baysZ: 1 };
}

/**
 * Split `count` columns into `bays` bays as evenly as possible; returns each bay's first column
 * (plus a final entry equal to `count`). E.g. 10 columns in 3 bays → [0, 3, 6, 10].
 */
export function bayColumnStarts(count: number, bays: number): number[] {
  const starts: number[] = [];
  for (let b = 0; b <= bays; b++) starts.push(Math.round((b * count) / bays));
  return starts;
}
