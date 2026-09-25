import type { FreeLookTuning } from './flight-tuning';
import { clamp } from './scalar-math';

// How the player's view relates to the hero (engine-neutral): free look — turning the head up to
// ±110° / ±70° without changing course, springing back when released — the comfort settings a
// first-person view needs, and when the body hides and the arms show as the view blends from
// chase (0) to first person (1).

export interface ComfortSettings {
  /** Share of the hero's bank the first-person view rolls with (chase keeps its own). */
  rollShare: number;
  /** First person keeps the horizon level. */
  horizonLock: boolean;
  /** Degrees; speed widening stops here. */
  maxFov: number;
  /** Shakes and speed blur scaled down. */
  reducedMotion: boolean;
}

export const DEFAULT_COMFORT: Readonly<ComfortSettings> = Object.freeze({ rollShare: 0.5, horizonLock: false, maxFov: 90, reducedMotion: false });

export interface LookInput {
  active: boolean;
  /** Stick-like, −1..1: right and up positive. */
  x: number;
  y: number;
}

/** Settle to within 2% of rest in `returnTime`: a critically damped spring with ω = 5.83 / t. */
const SETTLE = 5.83;

export class FreeLook {
  yaw = 0;
  pitch = 0;
  private yawVelocity = 0;
  private pitchVelocity = 0;

  constructor(private readonly tuning: FreeLookTuning) {}

  step(dt: number, input: LookInput): void {
    const t = this.tuning;
    if (input.active) {
      const k = 1 - Math.exp(-t.response * dt);
      const yaw = this.yaw + (clamp(input.x, -1, 1) * t.maxYaw - this.yaw) * k;
      const pitch = this.pitch + (clamp(input.y, -1, 1) * t.maxPitch - this.pitch) * k;
      this.yawVelocity = (yaw - this.yaw) / Math.max(dt, 1e-6);
      this.pitchVelocity = (pitch - this.pitch) / Math.max(dt, 1e-6);
      this.yaw = yaw;
      this.pitch = pitch;
      return;
    }
    // Critically damped return to centre (exact step, stable at any dt).
    const omega = SETTLE / t.returnTime;
    const e = Math.exp(-omega * dt);
    for (const axis of ['yaw', 'pitch'] as const) {
      const x = this[axis];
      const v = axis === 'yaw' ? this.yawVelocity : this.pitchVelocity;
      const c = v + omega * x;
      const next = (x + c * dt) * e;
      const velocity = (c - omega * (x + c * dt)) * e;
      this[axis] = next;
      if (axis === 'yaw') this.yawVelocity = velocity;
      else this.pitchVelocity = velocity;
    }
  }

  reset(): void {
    this.yaw = this.pitch = this.yawVelocity = this.pitchVelocity = 0;
  }
}

/** Past 0.6 of the way to first person the body hides; the arms fade in from 0.7. */
export function viewVisibility(firstPersonBlend: number): { body: boolean; arms: number } {
  const t = clamp((firstPersonBlend - 0.7) / 0.3, 0, 1);
  return { body: firstPersonBlend <= 0.6, arms: t * t * (3 - 2 * t) };
}

/** The roll share for a blend between chase and first person, honouring the comfort settings. */
export function viewRollShare(chaseShare: number, blend: number, comfort: ComfortSettings): number {
  const first = comfort.horizonLock ? 0 : comfort.rollShare;
  return chaseShare + (first - chaseShare) * blend;
}
