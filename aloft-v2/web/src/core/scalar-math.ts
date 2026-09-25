// Small scalar helpers shared by the simulation, camera and effects.

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach: sharpness is roughly 1 / time-constant. */
export const damp = (current: number, target: number, sharpness: number, dt: number): number =>
  target + (current - target) * Math.exp(-sharpness * dt);

export const wrapAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

export const dampAngle = (current: number, target: number, sharpness: number, dt: number): number =>
  current + wrapAngle(target - current) * (1 - Math.exp(-sharpness * dt));

export const lerpAngle = (a: number, b: number, t: number): number => a + wrapAngle(b - a) * t;

export function approach(current: number, target: number, maxDelta: number): number {
  return current < target ? Math.min(current + maxDelta, target) : Math.max(current - maxDelta, target);
}

export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
