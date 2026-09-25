import { Vector3 } from 'three';
import type { RandomSource } from '../../../core/seeded-noise';
import type { DustPlumes } from './dust-plumes';
import { ParticlePool } from './particle-pool';

// What a collapse throws into the air besides the big pieces: glass shards that glint as they
// fall, concrete chips, dust jetting out of every crushed storey, and after a heavy landing a dust
// surge that rolls out along the streets. Particles near the camera are left to the pools' own
// fades; the dust keeps v1's engulf culling.

const GLASS = 0;
/** v1's street grid (72 m blocks) runs along world x and z. */
const STREET_AXES = [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1)];

export interface CollapseEffectsBudget {
  glass: number;
  chips: number;
}

export class CollapseEffects {
  readonly glass: ParticlePool;
  readonly chips: ParticlePool;

  constructor(
    private readonly dust: DustPlumes,
    private readonly random: RandomSource,
    budget: CollapseEffectsBudget,
  ) {
    this.glass = new ParticlePool({ capacity: budget.glass, color: '#e8f4ff', additive: true, gravity: 9.8, drag: 0.35, maxSize: 26 });
    this.chips = new ParticlePool({ capacity: budget.chips, color: '#5a524b', gravity: 9.8, drag: 0.2, maxSize: 60 });
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
  }

  clear(): void {
    this.glass.clear();
    this.chips.clear();
  }
}
