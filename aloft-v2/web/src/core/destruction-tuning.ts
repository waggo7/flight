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
  motion: DestructionMotion;
}

export interface PerProfile {
  desktop: number;
  phone: number;
}

export interface DestructionMotion {
  solverMassReference: number;
  spawnClearance: number;
  maxPushSpeed: number;
  hingeTilt: number;
  toppleSpin: number;
  edgeCrushInterval: number;
  edgeReserveShare: number;
  breakupFraction: number;
  bandStoreys: number;
  chunkRadius: number;
  pancakeAccretion: number;
  pancakeMaxStoreys: PerProfile;
  generationDecay: number;
  maxGeneration: number;
  buildingCooldown: number;
  impactEnergy: number;
  freezeAfter: number;
  debrisLife: PerProfile;
  debrisBodies: PerProfile;
  chunkBodies: PerProfile;
  debrisPerCrushed: number;
  friction: number;
}

const STYLE_KEYS = ['glass', 'stone', 'plain'] as const;
export function perStyle(values: PerStyle, style: FacadeStyle): number {
  return values[STYLE_KEYS[style]];
}
