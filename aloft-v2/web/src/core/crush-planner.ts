import { NodeState, type BuildingStructure, type StructureNode, type WorldPoint } from './building-structure';
import type { DestructionTuning } from './destruction-tuning';

// Decides what an impact pulverises. A hero hit bores a tunnel along the flight path, then spends
// what's left from the exit face inward in a cone (a blow-out), never deeper than a share of the
// path — so the entry side survives as a hinge and the top falls forward, in view, instead of back
// onto the camera. A blast crushes outward from its centre. Every node absorbs energy up to its
// health; damage that doesn't crush a node still weakens it, so a round tower takes 2–3 hits.

export type DamageShape =
  | { type: 'sweep'; from: WorldPoint; direction: WorldPoint; radius: number }
  | { type: 'sphere'; centre: WorldPoint; radius: number };

export interface DamageEvent {
  kind: 'blunt' | 'blast' | 'cut';
  shape: DamageShape;
  /** Joules delivered. */
  energy: number;
  /** m/s into the building (sweeps); shapes the blow-out cone. */
  speed: number;
  /** N·s the impactor carries (sweeps); what isn't spent getting through pushes the part above. */
  impulse: number;
  /** 0 = the hero or a power; +1 for each knock-on (dominoes). */
  generation: number;
}

export type DamageOutcome = 'none' | 'dent' | 'crush' | 'burst';

export interface DamageReport {
  outcome: DamageOutcome;
  crushed: number[];
  /** Nodes damaged but not crushed. */
  weakened: number[];
  /** Storeys touched (for the support check), lowest first. */
  storeys: { segment: number; storey: number }[];
  energyUsed: number;
  /** Where a sweep left the building (bursts). */
  exit: WorldPoint | null;
  /** Horizontal push delivered to the structure (sweeps): unit direction and N·s. */
  push: { x: number; z: number; impulse: number } | null;
}

interface PathPass {
  segment: number;
  /** Entry and exit parameters along the ray, and the ray in the segment's local frame. */
  t0: number;
  t1: number;
  o: WorldPoint;
  d: WorldPoint;
}

interface Candidate {
  node: StructureNode;
  /** Sort key: path position (tunnel), distance (blow-out, blast). */
  order: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

function distancePointBox(p: WorldPoint, node: StructureNode): number {
  const dx = Math.max(node.x0 - p.x, 0, p.x - node.x1);
  const dy = Math.max(node.y0 - p.y, 0, p.y - node.y1);
  const dz = Math.max(node.z0 - p.z, 0, p.z - node.z1);
  return Math.hypot(dx, dy, dz);
}

/** Entry/exit parameters of a ray against a segment's local box (slab test), or null. */
function rayThroughSegment(structure: BuildingStructure, segmentIndex: number, origin: WorldPoint, direction: WorldPoint): PathPass | null {
  const segment = structure.segments[segmentIndex]!;
  const o = structure.worldToLocal(segmentIndex, origin);
  const tip = structure.worldToLocal(segmentIndex, { x: origin.x + direction.x, y: origin.y + direction.y, z: origin.z + direction.z });
  const d = { x: tip.x - o.x, y: tip.y - o.y, z: tip.z - o.z };
  let t0 = -Infinity;
  let t1 = Infinity;
  const axes: [number, number, number, number][] = [
    [o.x, d.x, 0, segment.w],
    [o.y, d.y, 0, segment.h],
    [o.z, d.z, 0, segment.d],
  ];
  for (const [start, step, lo, hi] of axes) {
    if (Math.abs(step) < 1e-9) {
      if (start < lo || start > hi) return null;
      continue;
    }
    let a = (lo - start) / step;
    let b = (hi - start) / step;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  if (t1 < 0) return null;
  return { segment: segmentIndex, t0: Math.max(t0, 0), t1, o, d };
}

/** Storeys of a segment whose height range meets [yLo, yHi] (local metres). */
function storeysBetween(structure: BuildingStructure, segmentIndex: number, yLo: number, yHi: number): number[] {
  const { storeys, storeyHeight } = structure.segments[segmentIndex]!.layout;
  const first = Math.max(0, Math.floor(yLo / storeyHeight));
  const last = Math.min(storeys - 1, Math.floor(yHi / storeyHeight));
  const result: number[] = [];
  for (let s = first; s <= last; s++) result.push(s);
  return result;
}

/** Mutable bookkeeping for one damage event: remaining energy and the report being built. */
class DamageLedger {
  readonly report: DamageReport = { outcome: 'none', crushed: [], weakened: [], storeys: [], energyUsed: 0, exit: null, push: null };
  private readonly touched = new Set<string>();

  constructor(
    private readonly structure: BuildingStructure,
    public energy: number,
  ) {}

  /** Spend energy on candidates in order; true if every candidate ended up crushed. */
  spend(candidates: Candidate[]): boolean {
    candidates.sort((a, b) => a.order - b.order);
    for (const { node } of candidates) {
      if (node.state !== NodeState.Intact) continue;
      if (!Number.isFinite(node.health)) return false; // sturdy: podiums and bases don't break
      if (this.energy <= 0) return false;
      const used = Math.min(this.energy, node.health);
      node.health -= used;
      this.energy -= used;
      this.report.energyUsed += used;
      this.touch(node.segment, node.storey);
      if (node.health > 1e-6) {
        this.report.weakened.push(node.id);
        return false;
      }
      this.structure.crush(node.id);
      this.report.crushed.push(node.id);
    }
    return true;
  }

  private touch(segment: number, storey: number): void {
    const key = `${segment}:${storey}`;
    if (this.touched.has(key)) return;
    this.touched.add(key);
    this.report.storeys.push({ segment, storey });
  }
}

/** Nodes within `radius` of the path through one segment, ordered by where the path meets them. */
function tunnelCandidates(structure: BuildingStructure, pass: PathPass, radius: number): Candidate[] {
  const segment = structure.segments[pass.segment]!;
  const yAt = pass.o.y + pass.d.y * ((pass.t0 + pass.t1) / 2);
  // Expand one storey beyond the bore too, so later checks and chunks see bays there.
  const band = radius + segment.layout.storeyHeight;
  for (const storey of storeysBetween(structure, pass.segment, yAt - band, yAt + band)) structure.expandStorey(pass.segment, storey);
  const candidates: Candidate[] = [];
  const steps = 12;
  for (const storey of storeysBetween(structure, pass.segment, yAt - radius, yAt + radius)) {
    for (const node of structure.presentNodes(pass.segment, storey)) {
      let best = Infinity;
      let bestT = pass.t0;
      for (let i = 0; i <= steps; i++) {
        const t = lerp(pass.t0, pass.t1, i / steps);
        const dist = distancePointBox({ x: pass.o.x + pass.d.x * t, y: pass.o.y + pass.d.y * t, z: pass.o.z + pass.d.z * t }, node);
        if (dist < best) {
          best = dist;
          bestT = t;
        }
      }
      if (best <= radius) candidates.push({ node, order: bestT });
    }
  }
  return candidates;
}

/**
 * Blow-out: an exit wound. A wedge with its apex at the entry that widens with speed toward the
 * exit face, spent from the exit inward and never deeper than a share of the path — so the far
 * side goes and the entry side survives as the hinge. It stays in the storeys the tunnel went
 * through, so the break is a clean shear plane.
 */
function blowOutCandidates(structure: BuildingStructure, passes: PathPass[], tunnelStoreys: Set<string>, exit: WorldPoint, radius: number, speed: number, tuning: DestructionTuning): Candidate[] {
  const b = tuning.blowOut;
  const tanHalf = Math.tan(lerp(b.minHalfAngle, b.maxHalfAngle, clamp01((speed - b.minSpeed) / (b.maxSpeed - b.minSpeed))));
  const candidates: Candidate[] = [];
  for (const pass of passes) {
    const segment = structure.segments[pass.segment]!;
    const exitLocal = structure.worldToLocal(pass.segment, exit);
    // The ray is unit length, so t is metres along the path.
    const apex = { x: pass.o.x + pass.d.x * pass.t0, y: pass.o.y + pass.d.y * pass.t0, z: pass.o.z + pass.d.z * pass.t0 };
    const pathLength = pass.t1 - pass.t0;
    const minAlong = (1 - b.maxDepthShare) * pathLength;
    for (let storey = 0; storey < segment.layout.storeys; storey++) {
      if (!tunnelStoreys.has(`${pass.segment}:${storey}`)) continue;
      for (const node of structure.presentNodes(pass.segment, storey)) {
        const c = { x: (node.x0 + node.x1) / 2, y: (node.y0 + node.y1) / 2, z: (node.z0 + node.z1) / 2 };
        const v = { x: c.x - apex.x, y: c.y - apex.y, z: c.z - apex.z };
        const along = v.x * pass.d.x + v.y * pass.d.y + v.z * pass.d.z;
        // The cap applies to the node's entry-most point, so a bay straddling it stays as hinge.
        const halfReach = (Math.abs(pass.d.x) * (node.x1 - node.x0) + Math.abs(pass.d.y) * (node.y1 - node.y0) + Math.abs(pass.d.z) * (node.z1 - node.z0)) / 2;
        if (along - halfReach < minAlong) continue;
        const lateral = Math.hypot(v.x - pass.d.x * along, v.y - pass.d.y * along, v.z - pass.d.z * along);
        if (lateral > along * tanHalf + radius) continue;
        candidates.push({ node, order: Math.hypot(c.x - exitLocal.x, c.y - exitLocal.y, c.z - exitLocal.z) });
      }
    }
  }
  return candidates;
}

function applySweep(structure: BuildingStructure, event: DamageEvent, shape: Extract<DamageShape, { type: 'sweep' }>, ledger: DamageLedger, tuning: DestructionTuning): void {
  const { from, radius } = shape;
  const report = ledger.report;
  const length = Math.hypot(shape.direction.x, shape.direction.y, shape.direction.z);
  if (length < 1e-9) return;
  const direction = { x: shape.direction.x / length, y: shape.direction.y / length, z: shape.direction.z / length };
  const passes = structure.segments.map((segment) => rayThroughSegment(structure, segment.index, from, direction)).filter((p): p is PathPass => p !== null);
  const tunnel: Candidate[] = [];
  let pathLength = 0;
  let exit: WorldPoint | null = null;
  for (const pass of passes) {
    tunnel.push(...tunnelCandidates(structure, pass, radius));
    if (pass.t1 - pass.t0 > pathLength) {
      pathLength = pass.t1 - pass.t0;
      exit = { x: from.x + direction.x * pass.t1, y: from.y + direction.y * pass.t1, z: from.z + direction.z * pass.t1 };
    }
  }
  if (tunnel.length === 0 || !exit) return;
  if (ledger.spend(tunnel)) {
    report.outcome = 'burst';
    report.exit = exit;
    const tunnelStoreys = new Set(tunnel.map((c) => `${c.node.segment}:${c.node.storey}`));
    ledger.spend(blowOutCandidates(structure, passes, tunnelStoreys, exit, radius, event.speed, tuning));
  } else {
    report.outcome = report.crushed.length > 0 ? 'crush' : 'dent';
  }
  // What the impactor spent getting in pushes the part above along the path.
  const horizontal = Math.hypot(direction.x, direction.z);
  if (horizontal > 1e-6) {
    const share = Math.min(1, report.energyUsed / Math.max(event.energy, 1e-9));
    report.push = { x: direction.x / horizontal, z: direction.z / horizontal, impulse: event.impulse * share * horizontal };
  }
}

function applyBlast(structure: BuildingStructure, shape: Extract<DamageShape, { type: 'sphere' }>, ledger: DamageLedger): void {
  const { centre, radius } = shape;
  const blast: Candidate[] = [];
  for (const segment of structure.segments) {
    const local = structure.worldToLocal(segment.index, centre);
    for (const storey of storeysBetween(structure, segment.index, local.y - radius, local.y + radius)) {
      structure.expandStorey(segment.index, storey);
      for (const node of structure.presentNodes(segment.index, storey)) {
        const distance = distancePointBox(local, node);
        if (distance <= radius) blast.push({ node, order: distance });
      }
    }
  }
  if (blast.length === 0) return;
  ledger.spend(blast);
  const report = ledger.report;
  report.outcome = report.crushed.length > 0 ? 'crush' : report.weakened.length > 0 ? 'dent' : 'none';
}

export function applyDamage(structure: BuildingStructure, event: DamageEvent, tuning: DestructionTuning): DamageReport {
  const ledger = new DamageLedger(structure, event.energy);
  if (event.shape.type === 'sweep') applySweep(structure, event, event.shape, ledger, tuning);
  else applyBlast(structure, event.shape, ledger);
  const report = ledger.report;
  const base = (ref: { segment: number; storey: number }): number => {
    const segment = structure.segments[ref.segment]!;
    return segment.y0 + ref.storey * segment.layout.storeyHeight;
  };
  report.storeys.sort((a, b) => base(a) - base(b));
  return report;
}
