// 2D convex hulls and point tests on the ground plane (x, z), for the tipping check.

export interface Point2 {
  x: number;
  z: number;
}

const cross = (o: Point2, a: Point2, b: Point2): number => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);

/** Andrew's monotone chain; returns the hull counter-clockwise without the repeated first point. */
export function convexHull(points: readonly Point2[]): Point2[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  if (sorted.length <= 2) return sorted;
  const lower: Point2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point2[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** True if p is inside (or within `margin` metres of) a counter-clockwise convex polygon. */
export function insideConvex(hull: readonly Point2[], p: Point2, margin = 0): boolean {
  if (hull.length < 3) return false;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    if (cross(a, b, p) / length < -margin) return false;
  }
  return true;
}

/** The hull edge closest to p (the edge a leaning block pivots on). */
export function nearestEdge(hull: readonly Point2[], p: Point2): { a: Point2; b: Point2; distance: number } {
  let best = { a: hull[0]!, b: hull[1 % hull.length]!, distance: Infinity };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.z - a.z) * ez) / (ex * ex + ez * ez || 1)));
    const distance = Math.hypot(a.x + ex * t - p.x, a.z + ez * t - p.z);
    if (distance < best.distance) best = { a, b, distance };
  }
  return best;
}

export function centroid(points: readonly Point2[]): Point2 {
  let x = 0;
  let z = 0;
  for (const p of points) {
    x += p.x;
    z += p.z;
  }
  return { x: x / Math.max(points.length, 1), z: z / Math.max(points.length, 1) };
}
