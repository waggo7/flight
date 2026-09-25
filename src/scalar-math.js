// Small scalar helpers shared by the simulation, camera and effects.

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const lerp = (a, b, t) => a + (b - a) * t;

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Frame-rate independent exponential approach: sharpness is roughly 1 / time-constant.
export const damp = (current, target, sharpness, dt) => target + (current - target) * Math.exp(-sharpness * dt);

export const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

export const dampAngle = (current, target, sharpness, dt) =>
  current + wrapAngle(target - current) * (1 - Math.exp(-sharpness * dt));

export function approach(current, target, maxDelta) {
  return current < target ? Math.min(current + maxDelta, target) : Math.max(current - maxDelta, target);
}

export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
