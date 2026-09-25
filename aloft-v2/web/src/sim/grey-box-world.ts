import { Vector3 } from '../core/math';
import type { RandomStream } from '../engine/random-streams';
import type { GameWorld } from './world-contracts';

// M0 stand-in world: a flat island (ground at y = 4, like the real city) ringed by sea, with
// box towers on the 72 m block grid. Replaced by the ported city (M1) and Rapier (M2).

export interface GreyBox {
  readonly id: number;
  readonly min: Vector3;
  readonly max: Vector3;
}

export const ISLAND_RADIUS = 1300;
export const ISLAND_GROUND = 4;
const SEABED = -40;

export function createGreyBoxCity(random: RandomStream, blocks = 9, spacing = 72): GreyBox[] {
  const boxes: GreyBox[] = [];
  for (let i = -blocks; i <= blocks; i++) {
    for (let j = -blocks; j <= blocks; j++) {
      if (Math.hypot(i, j) > blocks || random.next() < 0.35) continue;
      const cx = i * spacing;
      const cz = j * spacing;
      if (Math.hypot(cx, cz) < 40) continue; // keep the launch pad clear
      if (Math.abs(cx) < 40 && cz > 0) continue; // and a clear avenue straight ahead of it
      const core = Math.exp(-(i * i + j * j) / (blocks * blocks * 0.25));
      const height = 18 + random.range(0, 1) * (40 + 220 * core);
      const halfW = random.range(10, 22);
      const halfD = random.range(10, 22);
      boxes.push({
        id: boxes.length,
        min: new Vector3(cx - halfW, ISLAND_GROUND, cz - halfD),
        max: new Vector3(cx + halfW, ISLAND_GROUND + height, cz + halfD),
      });
    }
  }
  return boxes;
}

const closest = new Vector3();
const delta = new Vector3();
const push = new Vector3();

export class GreyBoxWorld implements GameWorld<GreyBox> {
  constructor(readonly boxes: readonly GreyBox[]) {}

  groundHeight(x: number, z: number): number {
    return Math.hypot(x, z) < ISLAND_RADIUS ? ISLAND_GROUND : SEABED;
  }

  resolveSphere(position: Vector3, _previous: Vector3, radius: number, outNormal: Vector3): GreyBox | null {
    let deepest: GreyBox | null = null;
    let deepestPenetration = 0;
    push.set(0, 0, 0);
    // Two passes settle corners where two boxes meet.
    for (let pass = 0; pass < 2; pass++) {
      for (const box of this.boxes) {
        closest.set(
          Math.min(Math.max(position.x, box.min.x), box.max.x),
          Math.min(Math.max(position.y, box.min.y), box.max.y),
          Math.min(Math.max(position.z, box.min.z), box.max.z),
        );
        delta.subVectors(position, closest);
        const distance = delta.length();
        if (distance >= radius) continue;
        let penetration: number;
        if (distance > 1e-6) {
          delta.divideScalar(distance);
          penetration = radius - distance;
        } else {
          // Centre inside the box: leave through the nearest side (never downward).
          const exits = [
            { d: position.x - box.min.x, n: [-1, 0, 0] },
            { d: box.max.x - position.x, n: [1, 0, 0] },
            { d: box.max.y - position.y, n: [0, 1, 0] },
            { d: position.z - box.min.z, n: [0, 0, -1] },
            { d: box.max.z - position.z, n: [0, 0, 1] },
          ].sort((a, b) => a.d - b.d)[0]!;
          delta.set(exits.n[0]!, exits.n[1]!, exits.n[2]!);
          penetration = exits.d + radius;
        }
        position.addScaledVector(delta, penetration);
        push.addScaledVector(delta, penetration);
        if (penetration > deepestPenetration) {
          deepestPenetration = penetration;
          deepest = box;
        }
      }
    }
    if (deepest) outNormal.copy(push).normalize();
    return deepest;
  }

  nearestSurface(position: Vector3, maxDistance: number): number {
    let best = Infinity;
    for (const box of this.boxes) {
      const dx = Math.max(box.min.x - position.x, 0, position.x - box.max.x);
      const dy = Math.max(box.min.y - position.y, 0, position.y - box.max.y);
      const dz = Math.max(box.min.z - position.z, 0, position.z - box.max.z);
      const d = Math.hypot(dx, dy, dz);
      if (d < best) best = d;
    }
    return best <= maxDistance ? best : Infinity;
  }

  raycast(origin: Vector3, direction: Vector3, maxDistance: number): number {
    let best = maxDistance;
    for (const box of this.boxes) {
      let tMin = 0;
      let tMax = best;
      let hit = true;
      for (const axis of ['x', 'y', 'z'] as const) {
        const o = origin[axis];
        const d = direction[axis];
        if (Math.abs(d) < 1e-9) {
          if (o < box.min[axis] || o > box.max[axis]) {
            hit = false;
            break;
          }
          continue;
        }
        let t1 = (box.min[axis] - o) / d;
        let t2 = (box.max[axis] - o) / d;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) {
          hit = false;
          break;
        }
      }
      if (hit && tMin < best) best = tMin;
    }
    // The ground and sea surface.
    if (direction.y < -1e-6) {
      const surface = Math.max(this.groundHeight(origin.x, origin.z), 0);
      const t = (surface - origin.y) / direction.y;
      if (t >= 0 && t < best) best = t;
    }
    return best;
  }
}
