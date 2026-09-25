import { Color, Vector3 } from 'three';
import type { RandomSource } from '../../../core/seeded-noise';
import type { DustPlumes } from './dust-plumes';
import { ParticlePool } from './particle-pool';

// What a collapse throws into the air besides the big pieces: glass shards that glint as they
// fall, sparks off torn steel, concrete chips, dust jetting out of every crushed storey, and after
// a heavy landing a dust surge that rolls out along the streets. The hero's own hit gets its own
// burst: the curtain wall bursting back out as glass, the frame tearing in sparks, and a glass
// rain down the facade. Particles near the camera are left to the pools' own fades; the dust keeps
// v1's engulf culling.

const GLASS = 0;
/** v1's street grid (72 m blocks) runs along world x and z. */
const STREET_AXES = [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1)];

export interface CollapseEffectsBudget {
  glass: number;
  chips: number;
  sparks: number;
}

type Point = { x: number; y: number; z: number };

export class CollapseEffects {
  readonly glass: ParticlePool;
  readonly chips: ParticlePool;
  readonly sparks: ParticlePool;

  constructor(
    private readonly dust: DustPlumes,
    private readonly random: RandomSource,
    budget: CollapseEffectsBudget,
  ) {
    // HDR colours: glints and sparks are brighter than white so the bloom picks them up.
    this.glass = new ParticlePool({ capacity: budget.glass, color: new Color('#e8f4ff').multiplyScalar(1.7), additive: true, gravity: 9.8, drag: 0.35, maxSize: 26, twinkle: 9 });
    this.chips = new ParticlePool({ capacity: budget.chips, color: '#5a524b', gravity: 9.8, drag: 0.2, maxSize: 60 });
    this.sparks = new ParticlePool({ capacity: budget.sparks, color: new Color(3.2, 1.45, 0.42), additive: true, gravity: 9.8, drag: 0.9, maxSize: 12, twinkle: 40 });
  }

  /**
   * The hero's hit: `soak` (0..1) is how much of the punch the building took. The frame tears in a
   * spray of sparks, a glass facade bursts back out toward the hero and rains down the face.
   */
  heroStrike(point: Point, direction: Point, soak: number, glass: boolean): void {
    const r = this.random;
    const sparks = Math.round(50 + 110 * soak);
    for (let k = 0; k < sparks; k++) {
      // Most spray back off the face and outward; some follow the hero through.
      const back = r() < 0.7 ? -1 : 1;
      const speed = 10 + r() * (18 + 20 * soak);
      this.sparks.spawn(
        point.x + (r() - 0.5) * 2, point.y + (r() - 0.5) * 2, point.z + (r() - 0.5) * 2,
        direction.x * back * speed * r() + (r() - 0.5) * speed, (r() - 0.25) * speed * 0.8, direction.z * back * speed * r() + (r() - 0.5) * speed,
        0.35 + r() * 0.8, 0.28 + r() * 0.3,
      );
    }
    if (!glass) return;
    const shards = Math.round(120 + 160 * soak);
    for (let k = 0; k < shards; k++) {
      const back = r() < 0.6 ? -1 : 1;
      const speed = 6 + r() * (16 + 14 * soak);
      this.glass.spawn(
        point.x + (r() - 0.5) * 5, point.y + (r() - 0.5) * 4, point.z + (r() - 0.5) * 5,
        direction.x * back * speed + (r() - 0.5) * 14, r() * 6 - 1, direction.z * back * speed + (r() - 0.5) * 14,
        2.5 + r() * 2.5, 0.22 + r() * 0.35,
      );
    }
    // Glass rain: panes further up and down the face let go and fall past the hole, glinting.
    for (let k = 0; k < 70 * (0.5 + soak); k++) {
      const up = (r() - 0.3) * 30;
      this.glass.spawn(
        point.x - direction.x * 1.5 + (r() - 0.5) * 16, point.y + up, point.z - direction.z * 1.5 + (r() - 0.5) * 16,
        -direction.x * r() * 3, -r() * 2, -direction.z * r() * 3,
        4 + r() * 3, 0.25 + r() * 0.3,
      );
    }
  }

  /** A heavy contact (a section landing on a stump, a neighbour, the street): steel skids in sparks. */
  impactSparks(position: Point, energy: number): void {
    const r = this.random;
    const count = Math.round(Math.min(60, 8 * Math.log10(Math.max(energy, 1e6) / 1e6)));
    for (let k = 0; k < count; k++) {
      const speed = 6 + r() * 16;
      const a = r() * Math.PI * 2;
      this.sparks.spawn(position.x, position.y + 1, position.z, Math.cos(a) * speed, 2 + r() * 9, Math.sin(a) * speed, 0.3 + r() * 0.7, 0.25 + r() * 0.3);
    }
  }

  /** Storeys crushed at `points`: jets of dust and chips (and glass from glass towers) along `direction`. */
  crushed(points: readonly { x: number; y: number; z: number }[], style: number, direction: { x: number; y: number; z: number } | null): void {
    const r = this.random;
    const jets = Math.min(points.length, 12);
    const step = points.length / Math.max(jets, 1);
    for (let j = 0; j < jets; j++) {
      const p = points[Math.floor(j * step)]!;
      const dx = direction?.x ?? r() - 0.5;
      const dz = direction?.z ?? r() - 0.5;
      const push = direction ? 14 : 5;
      this.dust.puff(p.x, p.y, p.z, { size: 8, growth: 2.8, life: 6.5, rise: 1.3, vx: dx * push, vz: dz * push, alpha: 0.5, darkness: 0.25 });
      // Rebar and frame snapping as the storey goes.
      for (let k = 0; k < 7; k++) {
        const speed = 8 + r() * 18;
        this.sparks.spawn(p.x + (r() - 0.5) * 3, p.y + (r() - 0.5) * 2, p.z + (r() - 0.5) * 3, (dx * push * 0.6 + (r() - 0.5) * speed), r() * 8, (dz * push * 0.6 + (r() - 0.5) * speed), 0.3 + r() * 0.6, 0.25 + r() * 0.25);
      }
      for (let k = 0; k < 10; k++) {
        this.chips.spawn(p.x + (r() - 0.5) * 4, p.y + (r() - 0.5) * 3, p.z + (r() - 0.5) * 4, dx * push * (0.5 + r()) + (r() - 0.5) * 10, r() * 7, dz * push * (0.5 + r()) + (r() - 0.5) * 10, 2.5 + r() * 2, 0.6 + r() * 0.9);
      }
      if (style === GLASS) {
        for (let k = 0; k < 26; k++) {
          this.glass.spawn(p.x + (r() - 0.5) * 6, p.y + (r() - 0.5) * 3, p.z + (r() - 0.5) * 6, dx * push * r() + (r() - 0.5) * 12, r() * 5, dz * push * r() + (r() - 0.5) * 12, 3 + r() * 2.5, 0.25 + r() * 0.35);
        }
      }
    }
  }

  /** A heavy landing: a dust surge rolling out along the streets, sized by the energy. */
  groundImpact(position: { x: number; y: number; z: number }, energy: number): void {
    const r = this.random;
    const scale = Math.min(1, Math.log10(Math.max(energy, 1e6) / 1e6) / 3);
    this.dust.puff(position.x, position.y + 3, position.z, { size: 16 + 18 * scale, growth: 3.4, life: 9, rise: 1.6, alpha: 0.6, darkness: 0.2 });
    const perAxis = 2 + Math.round(3 * scale);
    for (const axis of STREET_AXES) {
      for (let k = 1; k <= perAxis; k++) {
        const speed = (8 + 10 * scale) * (0.7 + r() * 0.6);
        this.dust.puff(position.x + axis.x * k * 7, position.y + 2, position.z + axis.z * k * 7, {
          size: 10 + 8 * scale, growth: 3, life: 8 + r() * 2, rise: 0.6, vx: axis.x * speed, vz: axis.z * speed, alpha: 0.5, darkness: 0.15,
        });
      }
    }
    for (let k = 0; k < 30 * scale; k++) {
      this.chips.spawn(position.x, position.y + 2, position.z, (r() - 0.5) * 26, 4 + r() * 12, (r() - 0.5) * 26, 2 + r() * 2, 0.8 + r());
    }
  }

  update(dt: number, projectionScale: number): void {
    this.glass.update(dt, projectionScale);
    this.chips.update(dt, projectionScale);
    this.sparks.update(dt, projectionScale);
  }

  clear(): void {
    this.glass.clear();
    this.chips.clear();
    this.sparks.clear();
  }
}
