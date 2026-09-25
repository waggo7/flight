import type { FacadeStyle } from './city-blueprint';

// Shape of content/tuning/destruction.json (validated in engine/content-library.ts).

export interface PerStyle {
  glass: number;
  stone: number;
  plain: number;
}

export interface DestructionTuning {
  punchMass: number;
  dentSpeed: number;
  crushEnergy: PerStyle;
  reserve: PerStyle;
  density: PerStyle;
  roundToughness: number;
  tunnelClearance: number;
  pushLever: number;
  maxPushShift: number;
  blowOut: { minHalfAngle: number; maxHalfAngle: number; minSpeed: number; maxSpeed: number; maxDepthShare: number };
  strainRatio: number;
  offCentreShare: number;
  maxCrushPasses: number;
}

const STYLE_KEYS = ['glass', 'stone', 'plain'] as const;
export function perStyle(values: PerStyle, style: FacadeStyle): number {
  return values[STYLE_KEYS[style]];
}
