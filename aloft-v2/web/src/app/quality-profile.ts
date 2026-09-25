import type { QualityProfile } from '../engine/game-context';

// Device quality presets (from v1). Phones get fewer pixels, smaller shadows and fewer clouds;
// effect budgets follow the build plan's table.

export interface QualitySettings {
  profile: QualityProfile;
  maxPixelRatio: number;
  pixelBudget: number;
  shadowSize: number;
  cloudDetail: number;
  cloudCount: number;
  /** Effect budgets (build plan): dust puffs, glass shards, concrete chips. */
  dustPuffs: number;
  glassShards: number;
  concreteChips: number;
}

export const QUALITY: Readonly<Record<QualityProfile, QualitySettings>> = {
  desktop: { profile: 'desktop', maxPixelRatio: 2, pixelBudget: 3.2e6, shadowSize: 2048, cloudDetail: 2, cloudCount: 150, dustPuffs: 600, glassShards: 1500, concreteChips: 1500 },
  phone: { profile: 'phone', maxPixelRatio: 1.5, pixelBudget: 1.4e6, shadowSize: 1024, cloudDetail: 1, cloudCount: 110, dustPuffs: 250, glassShards: 500, concreteChips: 600 },
};

export function detectProfile(): QualityProfile {
  return matchMedia('(pointer: coarse)').matches ? 'phone' : 'desktop';
}
