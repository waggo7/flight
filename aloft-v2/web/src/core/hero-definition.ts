import type { FlightTuning } from './flight-tuning';

// A hero is data (content/heroes/<id>.json): how they look, how they fly, which powers they
// carry. The web game and the Godot port read the same files; this module holds the types and
// the pure rules that turn a hero's multipliers into tuning.

export const HERO_EMBLEMS = ['diamond', 'star', 'bolt', 'ring'] as const;
export type HeroEmblem = (typeof HERO_EMBLEMS)[number];
export const HERO_MASKS = ['none', 'domino', 'cowl'] as const;
export type HeroMask = (typeof HERO_MASKS)[number];
export const HERO_HAIR_STYLES = ['swept', 'crop', 'long', 'none'] as const;
export type HeroHairStyle = (typeof HERO_HAIR_STYLES)[number];
export const HERO_POWERS = ['slam', 'grab'] as const;
export type HeroPower = (typeof HERO_POWERS)[number];

/** sRGB hex colours ("#rrggbb"). */
export interface HeroPalette {
  suit: string;
  trim: string;
  accent: string;
  cape: string;
  skin: string;
  hair: string;
}

export interface HeroBuild {
  /** Standing height, metres (1.7–2.1). */
  height: number;
  /** Shoulder width multiplier (1 = the reference hero). */
  shoulders: number;
  /** Muscle bulk multiplier for limb and torso girth. */
  bulk: number;
}

export interface HeroCapeLook {
  /** Shoulder to hem, metres. */
  length: number;
  /** Width at the hem, metres. */
  width: number;
}

export interface HeroLook {
  palette: HeroPalette;
  build: HeroBuild;
  /** null = no cape (the cloth sim is skipped). */
  cape: HeroCapeLook | null;
  emblem: HeroEmblem;
  mask: HeroMask;
  hair: HeroHairStyle;
}

/** Multipliers on the shared flight tuning (content/tuning/flight.json stays untouched). */
export interface HeroFlightMultipliers {
  /** Cruise, boost, launch and minimum speeds, and the dive bonus. */
  speed: number;
  /** Cruise and boost acceleration. */
  acceleration: number;
  /** Yaw rates (slow, fast, hover). */
  turnRate: number;
}

export interface HeroPowers {
  loadout: HeroPower[];
  slamRadiusScale: number;
  throwSpeedScale: number;
  grabMassScale: number;
}

export interface HeroDefinition {
  id: string;
  name: string;
  /** One short line for the hero select. */
  tagline: string;
  look: HeroLook;
  flight: HeroFlightMultipliers;
  powers: HeroPowers;
}

/** A copy of `base` with the hero's multipliers applied; `base` is never modified. */
export function scaleFlightTuning(base: Readonly<FlightTuning>, multipliers: Readonly<HeroFlightMultipliers>): FlightTuning {
  const { speed, acceleration, turnRate } = multipliers;
  return {
    ...base,
    cruiseSpeed: base.cruiseSpeed * speed,
    boostSpeed: base.boostSpeed * speed,
    minFlightSpeed: base.minFlightSpeed * speed,
    launchSpeed: base.launchSpeed * speed,
    diveBonus: base.diveBonus * speed,
    cruiseAccel: base.cruiseAccel * acceleration,
    boostAccel: base.boostAccel * acceleration,
    yawRateSlow: base.yawRateSlow * turnRate,
    yawRateFast: base.yawRateFast * turnRate,
    hoverYawRate: base.hoverYawRate * turnRate,
  };
}

/** The value a power reads for one of the hero's overrides, e.g. the slam radius. */
export function heroPowerScale(hero: Readonly<HeroDefinition>, key: 'slamRadiusScale' | 'throwSpeedScale' | 'grabMassScale'): number {
  return hero.powers[key];
}

export function heroHasPower(hero: Readonly<HeroDefinition>, power: HeroPower): boolean {
  return hero.powers.loadout.includes(power);
}
