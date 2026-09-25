import { CITY_BLOCK, CITY_ISLAND, CITY_PARK } from './island-terrain-height';
import { lerp } from './scalar-math';
import { createNoise2D, createRandom, type RandomSource } from './seeded-noise';

// The procedural skyline as plain data: glass towers downtown falling away to stone mid-rises,
// three landmark towers with open plazas around them. Ported from v1's generator
// (src/city-skyline.js) with the random draws in exactly the same order, so the same seed
// gives v1's city (checked by tests/unit/city-blueprint.test.ts). Rendering, collision and
// destruction all read this; nothing here touches three.js.

export const FacadeStyle = { glass: 0, stone: 1, plain: 2 } as const;
export type FacadeStyle = (typeof FacadeStyle)[keyof typeof FacadeStyle];

/** How a piece reacts to a hit: towers topple, podiums and bases only scar, roof kit shatters. */
export type PieceRole = 'tower' | 'podium' | 'base' | 'crown' | 'roof';

export const GLASS_TINTS = ['#1f2a36', '#18302f', '#3a2718', '#2f3136'] as const;
const GLASS_FRAMES = ['#dcd6cc', '#aab1b9', '#8e7b67', '#ebe5d9', '#5e6670', '#c7c1b6'];
const STONE_WALLS = ['#cfc0a8', '#baa58c', '#dad0c3', '#a08169', '#90969c', '#c79c7d', '#e3d7c6'];
const STURDY_ROLES: ReadonlySet<PieceRole> = new Set(['podium', 'base']);

interface FacadeLook {
  color: string;
  style: FacadeStyle;
  /** Index into GLASS_TINTS. */
  glass: number;
  /** Per-piece hash seed in [0, 1). */
  seed: number;
  /** Share of windows lit. */
  lit: number;
  role: PieceRole;
  building: number;
  collide: boolean;
}

export interface BoxPiece extends FacadeLook {
  kind: 'box';
  index: number;
  /** Centre of the footprint. */
  x: number;
  z: number;
  /** Footprint width (local x) and depth (local z). */
  w: number;
  d: number;
  /** Base height and height. */
  y0: number;
  h: number;
  yaw: number;
}

export interface RoundPiece extends FacadeLook {
  kind: 'round';
  index: number;
  x: number;
  z: number;
  radius: number;
  y0: number;
  h: number;
}

export interface SpirePiece {
  kind: 'spire';
  index: number;
  building: number;
  x: number;
  z: number;
  /** Base height. */
  y: number;
  height: number;
  radius: number;
}

export interface BeaconPiece {
  kind: 'beacon';
  index: number;
  building: number;
  x: number;
  y: number;
  z: number;
}

export type PieceRef = { kind: 'box' | 'round' | 'spire' | 'beacon'; index: number };

export interface ColliderSpec {
  kind: 'box' | 'cyl';
  role: PieceRole;
  building: number;
  /** The piece it belongs to; the twist tower's stand-in collider has none. */
  piece: PieceRef | null;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  /** Cylinders only. */
  x: number;
  z: number;
  radius: number;
  sturdy: boolean;
}

export interface BuildingSpec {
  id: number;
  x: number;
  z: number;
  pieces: PieceRef[];
  /** Indices into CityBlueprint.colliders. */
  colliders: number[];
}

export interface LandmarkSpec {
  i: number;
  j: number;
  x: number;
  z: number;
  top: number;
}

export interface CityBlueprint {
  boxes: BoxPiece[];
  rounds: RoundPiece[];
  spires: SpirePiece[];
  beacons: BeaconPiece[];
  buildings: BuildingSpec[];
  colliders: ColliderSpec[];
  tallest: { x: number; z: number; top: number }[];
  landmarks: { spire: LandmarkSpec; twist: LandmarkSpec; round: LandmarkSpec };
}

export const CITY_SEED = 2024;
const TEXTURE_NOISE_SEED = 99;
const S = CITY_BLOCK.spacing;
const LOT = S - CITY_BLOCK.street; // buildable width of one block
const DOWNTOWN = { x: 30, z: 40 };
const DEG_TO_RAD = Math.PI / 180;
const LANDMARK_CELLS = { spire: { i: 1, j: -1 }, twist: { i: -2, j: 2 }, round: { i: 2, j: 4 } } as const;
type LandmarkName = keyof typeof LANDMARK_CELLS;

interface Look {
  wall: readonly string[];
  glass?: number;
  frameIndex?: number;
}

interface PieceOptions {
  yaw?: number;
  collide?: boolean;
  role?: PieceRole;
}

class BlueprintBuilder {
  readonly random: RandomSource = createRandom(CITY_SEED);
  readonly noise = createNoise2D(TEXTURE_NOISE_SEED);
  readonly out: CityBlueprint;
  private building: BuildingSpec | null = null;

  constructor(private readonly heightAt: (x: number, z: number) => number) {
    const landmark = (name: LandmarkName): LandmarkSpec => {
      const cell = LANDMARK_CELLS[name];
      return { i: cell.i, j: cell.j, x: cell.i * S, z: cell.j * S, top: 0 };
    };
    this.out = {
      boxes: [], rounds: [], spires: [], beacons: [], buildings: [], colliders: [], tallest: [],
      landmarks: { spire: landmark('spire'), twist: landmark('twist'), round: landmark('round') },
    };
  }

  generate(): CityBlueprint {
    const range = Math.ceil(CITY_ISLAND.radius / S);
    const landmarks = Object.entries(LANDMARK_CELLS) as [LandmarkName, { i: number; j: number }][];
    for (let i = -range; i <= range; i++) {
      for (let j = -range; j <= range; j++) {
        const cx = i * S;
        const cz = j * S;
        if (!this.blockIsBuildable(cx, cz)) continue;
        const landmark = landmarks.find(([, l]) => l.i === i && l.j === j);
        if (landmark) {
          this.buildLandmark(landmark[0], cx, cz);
          continue;
        }
        const nearLandmark = landmarks.some(([, l]) => Math.max(Math.abs(l.i - i), Math.abs(l.j - j)) <= 1);
        this.buildBlock(cx, cz, nearLandmark);
      }
    }
    return this.out;
  }

  private beginBuilding(x: number, z: number): BuildingSpec {
    this.building = { id: this.out.buildings.length, x, z, pieces: [], colliders: [] };
    this.out.buildings.push(this.building);
    return this.building;
  }

  private current(): BuildingSpec {
    if (!this.building) throw new Error('piece added before any building');
    return this.building;
  }

  private blockIsBuildable(cx: number, cz: number): boolean {
    const half = LOT / 2 + 2;
    for (const [dx, dz] of [[-half, -half], [half, -half], [-half, half], [half, half], [0, 0]] as const) {
      const h = this.heightAt(cx + dx, cz + dz);
      if (h < CITY_ISLAND.ground - 0.6 || h > CITY_ISLAND.ground + 0.6) return false;
    }
    const overlapsPark = cx + half > CITY_PARK.minX && cx - half < CITY_PARK.maxX && cz + half > CITY_PARK.minZ && cz - half < CITY_PARK.maxZ;
    return !overlapsPark;
  }

  private buildBlock(cx: number, cz: number, nearLandmark: boolean): void {
    const random = this.random;
    const distance = Math.hypot(cx - DOWNTOWN.x, cz - DOWNTOWN.z);
    const core = Math.exp(-Math.pow(distance / 560, 2));
    const midtown = Math.exp(-Math.pow(distance / 1050, 2));
    const texture = this.noise(cx * 0.0045, cz * 0.0045) * 0.5 + 0.5;
    let maxHeight = 12 + 290 * Math.pow(core, 1.15) + 55 * midtown + 45 * texture * midtown;
    if (nearLandmark) maxHeight = Math.min(maxHeight, 42);
    if (random() < (nearLandmark ? 0.35 : 0.045)) return; // an open plaza

    const ground = CITY_ISLAND.ground;
    if (maxHeight > 150 && random() < 0.82) {
      // Downtown: a podium with a single tower.
      const podium = 9 + random() * 12;
      this.beginBuilding(cx, cz);
      this.addBox(cx, cz, LOT - 4, LOT - 4, ground, podium, FacadeStyle.stone, { wall: STONE_WALLS }, { role: 'podium' });
      const footprint = 24 + random() * 16;
      const height = maxHeight * (0.72 + random() * 0.45);
      const ox = (random() - 0.5) * (LOT - footprint - 6);
      const oz = (random() - 0.5) * (LOT - footprint - 6);
      this.beginBuilding(cx + ox, cz + oz);
      if (random() < 0.12) this.addRoundTower(cx + ox, cz + oz, footprint * 0.5, ground + podium, height);
      else this.addTower(cx + ox, cz + oz, footprint, footprint * (0.8 + random() * 0.4), ground + podium, height);
      return;
    }

    // Everywhere else: split the block into lots of varied height.
    const splits = random() < 0.55 ? [2, 2] : random() < 0.5 ? [2, 1] : [1, 2];
    const lotW = LOT / splits[0]!;
    const lotD = LOT / splits[1]!;
    for (let a = 0; a < splits[0]!; a++) {
      for (let b = 0; b < splits[1]!; b++) {
        if (random() < 0.06) continue;
        const x = cx - LOT / 2 + lotW * (a + 0.5);
        const z = cz - LOT / 2 + lotD * (b + 0.5);
        const height = Math.max(9, maxHeight * Math.pow(0.3 + random() * 0.7, 1.25));
        const w = lotW - 3 - random() * 4;
        const d = lotD - 3 - random() * 4;
        this.beginBuilding(x, z);
        if (height > 70 && random() < 0.65) this.addTower(x, z, w, d, ground, height);
        else {
          this.addBox(x, z, w, d, ground, height, FacadeStyle.stone, { wall: STONE_WALLS });
          this.addRooftop(x, z, w, d, ground + height);
        }
      }
    }
  }

  private addTower(x: number, z: number, w: number, d: number, y0: number, height: number): void {
    const random = this.random;
    const tiers = height > 180 ? 1 + Math.floor(random() * 3) : height > 90 && random() < 0.45 ? 2 : 1;
    const shares = tiers === 1 ? [1] : tiers === 2 ? [0.68, 0.32] : [0.5, 0.31, 0.19];
    const look: Look = { wall: GLASS_FRAMES, glass: Math.floor(random() * 4), frameIndex: Math.floor(random() * GLASS_FRAMES.length) };
    let cw = w;
    let cd = d;
    let y = y0;
    for (let t = 0; t < tiers; t++) {
      const h = height * shares[t]!;
      this.addBox(x, z, cw, cd, y, h, FacadeStyle.glass, look);
      y += h;
      cw *= 0.7 + random() * 0.12;
      cd *= 0.7 + random() * 0.12;
    }
    if (height > 110 && random() < 0.7) {
      const crown = 3 + random() * 6;
      this.addBox(x, z, cw * 0.82, cd * 0.82, y, crown, FacadeStyle.plain, { wall: ['#77736e'] }, { role: 'crown' });
      y += crown;
    }
    if (height > 190 && random() < 0.55) {
      const spire = 18 + random() * 40;
      this.addSpire(x, z, y, spire, 0.8 + random() * 0.5);
      y += spire;
    }
    if (height > 160) this.addBeacon(x, y + 0.8, z);
    this.out.tallest.push({ x, z, top: y });
  }

  private addRoundTower(x: number, z: number, radius: number, y0: number, height: number): void {
    const glass = Math.floor(this.random() * 4);
    this.addCylinder(x, z, radius, y0, height, FacadeStyle.glass, { wall: GLASS_FRAMES, glass });
    this.addCylinder(x, z, radius * 0.78, y0 + height, 5, FacadeStyle.plain, { wall: ['#7a7671'] }, { role: 'crown' });
    this.addBeacon(x, y0 + height + 6, z);
    this.out.tallest.push({ x, z, top: y0 + height + 5 });
  }

  private addRooftop(x: number, z: number, w: number, d: number, top: number): void {
    const random = this.random;
    if (random() < 0.55) {
      const uw = 3 + random() * Math.min(8, w * 0.35);
      const ud = 3 + random() * Math.min(8, d * 0.35);
      const ox = (random() - 0.5) * (w - uw - 2);
      const oz = (random() - 0.5) * (d - ud - 2);
      this.addBox(x + ox, z + oz, uw, ud, top, 2 + random() * 3, FacadeStyle.plain, { wall: ['#6f6c69', '#807a73'] }, { role: 'roof' });
    }
    if (top < 60 && random() < 0.22) {
      const ox = (random() - 0.5) * (w - 6);
      const oz = (random() - 0.5) * (d - 6);
      this.addCylinder(x + ox, z + oz, 1.8, top + 2.5, 4, FacadeStyle.plain, { wall: ['#6b5140'] }, { role: 'roof', collide: false });
    }
  }

  private buildLandmark(name: LandmarkName, cx: number, cz: number): void {
    const ground = CITY_ISLAND.ground;
    const landmarks = this.out.landmarks;
    if (name === 'spire') {
      // A slender stepped tower with a needle — the tallest thing in the city.
      this.beginBuilding(cx, cz);
      let y: number = ground;
      const tiers = 9;
      for (let t = 0; t < tiers; t++) {
        const size = lerp(46, 19, t / (tiers - 1));
        const h = lerp(68, 34, t / (tiers - 1));
        this.addBox(cx, cz, size, size, y, h, FacadeStyle.glass, { wall: ['#e7e1d6'], glass: 3 });
        y += h;
      }
      this.addBox(cx, cz, 12, 12, y, 10, FacadeStyle.plain, { wall: ['#8d8983'] }, { role: 'crown' });
      y += 10;
      this.addSpire(cx, cz, y, 74, 1.6);
      this.addBeacon(cx, y + 75, cz);
      this.out.tallest.push({ x: cx, z: cz, top: y + 74 });
      landmarks.spire.top = y + 74;
    } else if (name === 'twist') {
      // Stacked slabs, each turned a little further: a tower that twists as you circle it.
      const slabs = 62;
      const slabHeight = 6.8;
      const podium = 8;
      this.beginBuilding(cx, cz);
      this.addBox(cx, cz, LOT - 6, LOT - 6, ground, podium, FacadeStyle.stone, { wall: ['#d6cbbb'] }, { role: 'base' });
      this.beginBuilding(cx, cz);
      for (let s = 0; s < slabs; s++) {
        const yaw = s * 1.55 * DEG_TO_RAD; // three's MathUtils.degToRad, same rounding as v1
        this.addBox(cx, cz, 31, 31, ground + podium + s * slabHeight, slabHeight, FacadeStyle.glass, { wall: ['#b9c0c7'], glass: 1 }, { yaw, collide: false });
      }
      const top = ground + podium + slabs * slabHeight;
      this.addCollider({ kind: 'cyl', x: cx, z: cz, radius: 19.5, minY: ground + podium, maxY: top, role: 'tower', piece: null });
      this.addBeacon(cx, top + 1, cz);
      this.out.tallest.push({ x: cx, z: cz, top });
      landmarks.twist.top = top;
    } else {
      const radius = 24;
      const height = 330;
      this.beginBuilding(cx, cz);
      this.addCylinder(cx, cz, radius + 6, ground, 18, FacadeStyle.stone, { wall: ['#d9cfc0'] }, { role: 'base' });
      this.beginBuilding(cx, cz);
      this.addCylinder(cx, cz, radius, ground + 18, height, FacadeStyle.glass, { wall: ['#c9b89c'], glass: 2 });
      this.addCylinder(cx, cz, radius + 2, ground + 18 + height, 5, FacadeStyle.plain, { wall: ['#8b7a62'] }, { role: 'crown' });
      this.addCylinder(cx, cz, radius * 0.7, ground + 23 + height, 22, FacadeStyle.glass, { wall: ['#c9b89c'], glass: 2 }, { role: 'crown' });
      const top = ground + 45 + height;
      this.addSpire(cx, cz, top, 38, 1.2);
      this.addBeacon(cx, top + 39, cz);
      this.out.tallest.push({ x: cx, z: cz, top: top + 38 });
      landmarks.round.top = top + 38;
    }
  }

  private pickColor(list: readonly string[]): string {
    return list[Math.floor(this.random() * list.length)]!;
  }

  private addBox(x: number, z: number, w: number, d: number, y0: number, h: number, style: FacadeStyle, look: Look, options: PieceOptions = {}): void {
    const { yaw = 0, collide = true, role = 'tower' } = options;
    const random = this.random;
    const building = this.current();
    // Draw order matters for v1 parity: colour, glass, seed, lit.
    const color = look.frameIndex !== undefined ? look.wall[look.frameIndex]! : this.pickColor(look.wall);
    const glass = look.glass ?? Math.floor(random() * 4);
    const seed = random();
    const lit = style === FacadeStyle.stone ? 0.035 + random() * 0.05 : 0.015 + random() * 0.03;
    const index = this.out.boxes.length;
    this.out.boxes.push({ kind: 'box', index, x, z, w, d, y0, h, yaw, style, role, color, glass, seed, lit, building: building.id, collide });
    building.pieces.push({ kind: 'box', index });
    if (collide) {
      this.addCollider({
        kind: 'box', role, piece: { kind: 'box', index },
        minX: x - w / 2, maxX: x + w / 2, minY: y0, maxY: y0 + h, minZ: z - d / 2, maxZ: z + d / 2,
      });
    }
  }

  private addCylinder(x: number, z: number, radius: number, y0: number, h: number, style: FacadeStyle, look: Look, options: PieceOptions = {}): void {
    const { collide = true, role = 'tower' } = options;
    const random = this.random;
    const building = this.current();
    const color = this.pickColor(look.wall);
    const glass = look.glass ?? Math.floor(random() * 4);
    const seed = random();
    const lit = 0.02 + random() * 0.03;
    const index = this.out.rounds.length;
    this.out.rounds.push({ kind: 'round', index, x, z, radius, y0, h, style, role, color, glass, seed, lit, building: building.id, collide });
    building.pieces.push({ kind: 'round', index });
    if (collide) this.addCollider({ kind: 'cyl', role, piece: { kind: 'round', index }, x, z, radius, minY: y0, maxY: y0 + h });
  }

  private addSpire(x: number, z: number, y: number, height: number, radius: number): void {
    const building = this.current();
    const index = this.out.spires.length;
    building.pieces.push({ kind: 'spire', index });
    this.out.spires.push({ kind: 'spire', index, x, z, y, height, radius, building: building.id });
  }

  private addBeacon(x: number, y: number, z: number): void {
    const building = this.current();
    const index = this.out.beacons.length;
    building.pieces.push({ kind: 'beacon', index });
    this.out.beacons.push({ kind: 'beacon', index, x, y, z, building: building.id });
  }

  private addCollider(spec: {
    kind: 'box' | 'cyl'; role: PieceRole; piece: PieceRef | null; minY: number; maxY: number;
    minX?: number; maxX?: number; minZ?: number; maxZ?: number; x?: number; z?: number; radius?: number;
  }): void {
    const building = this.current();
    const collider: ColliderSpec =
      spec.kind === 'cyl'
        ? {
            kind: 'cyl', role: spec.role, building: building.id, piece: spec.piece,
            x: spec.x!, z: spec.z!, radius: spec.radius!,
            minX: spec.x! - spec.radius!, maxX: spec.x! + spec.radius!, minZ: spec.z! - spec.radius!, maxZ: spec.z! + spec.radius!,
            minY: spec.minY, maxY: spec.maxY, sturdy: STURDY_ROLES.has(spec.role),
          }
        : {
            kind: 'box', role: spec.role, building: building.id, piece: spec.piece,
            minX: spec.minX!, maxX: spec.maxX!, minZ: spec.minZ!, maxZ: spec.maxZ!, minY: spec.minY, maxY: spec.maxY,
            x: (spec.minX! + spec.maxX!) / 2, z: (spec.minZ! + spec.maxZ!) / 2, radius: 0, sturdy: STURDY_ROLES.has(spec.role),
          };
    building.colliders.push(this.out.colliders.length);
    this.out.colliders.push(collider);
  }
}

/** Generate the city. `heightAt` must be the terrain grid's height (v1 used the same). */
export function generateCityBlueprint(heightAt: (x: number, z: number) => number): CityBlueprint {
  return new BlueprintBuilder(heightAt).generate();
}
