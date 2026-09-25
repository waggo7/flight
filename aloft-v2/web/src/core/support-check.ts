import type { BuildingStructure, Segment, StructureNode } from './building-structure';
import { convexHull, insideConvex, nearestEdge, type Point2 } from './convex-hull';
import type { DestructionTuning } from './destruction-tuning';

// After damage: does what's left still hold up what's above it? Storeys are checked from the
// lowest damaged one upward, and the first that fails decides the building's fate:
//   - its centre of mass is outside the survivors' footprint → topple over the nearest hull edge;
//   - overloaded (surviving area < intact load / reserve) by a directed hit with the load off-centre →
//     the heavy side is crushed and the storey re-checked (so the tower tips toward it);
//   - overloaded otherwise (centred, or undirected like a blast) → pancake (the top drops onto the storey and crushes down);
//   - nothing left at all → detach (the part above is free and falls with its momentum).
// A hit's push counts too: its momentum is an overturning moment that loads the far side, so the
// effective load centre shifts along the push (Δv of the part above × pushLever, capped). That is
// why a punched tower leans away from the hero rather than back onto the camera.
// A storey past `strainRatio` of its capacity groans but stands. Pure: the sim turns verdicts
// into bodies and sounds.

/** Metres: survivors this close to the heaviest one are crushed in the same pass. */
const TIE_BAND = 0.5;

export type SupportFailure = 'topple' | 'pancake' | 'detach';

export interface StoreyRef {
  segment: number;
  storey: number;
}

/** Horizontal push from the hit (unit direction, N·s), as reported by the crush planner. */
export interface SupportPush {
  x: number;
  z: number;
  impulse: number;
}

export interface Hinge {
  a: Point2;
  b: Point2;
  /** Unit ground-plane direction the part above leans (from the hinge toward its centre of mass). */
  lean: Point2;
}

export interface SupportVerdict {
  /** The storey that gave way, or null when everything holds. */
  failure: null | { kind: SupportFailure; segment: number; storey: number; hinge: Hinge | null; loadRatio: number };
  /** The worst storey that holds but groans (load ratio ≥ strainRatio). */
  strain: null | { segment: number; storey: number; loadRatio: number };
  /** Nodes crushed by off-centre passes (the sim removes them like planner crushes). */
  crushed: number[];
}

/** Share of capacity a storey is using: 1 = on the edge of failing. */
export function loadRatio(structure: BuildingStructure, segment: number, storey: number): number {
  const s = structure.segments[segment]!;
  if (s.sturdy) return 0;
  const intact = structure.intactLoad[segment]![storey]!;
  if (intact <= 0) return 0;
  const share = structure.storeyShare(segment, storey);
  const { mass } = structure.loadAbove(segment, storey);
  if (mass <= 0) return 0;
  if (share <= 0) return Infinity;
  return mass / intact / (s.reserve * share);
}

function survivorHull(structure: BuildingStructure, nodes: StructureNode[]): Point2[] {
  return convexHull(nodes.flatMap((n) => structure.footprint(n)));
}

/** Area-weighted centre of the surviving supports (where the storey pushes back from). */
function resistanceCentre(structure: BuildingStructure, survivors: StructureNode[]): Point2 {
  let area = 0;
  let x = 0;
  let z = 0;
  for (const node of survivors) {
    const a = structure.footprintArea(node);
    const c = structure.nodeCentre(node);
    area += a;
    x += c.x * a;
    z += c.z * a;
  }
  return { x: x / area, z: z / area };
}

const unit = (x: number, z: number): Point2 => {
  const length = Math.hypot(x, z);
  return length > 1e-9 ? { x: x / length, z: z / length } : { x: 0, z: 0 };
};

/**
 * The hull edge the part above pivots on, and which way it leans. Outside the hull the load
 * swings away from the nearest hull point (diagonally over a lone corner); inside it (an
 * overloaded, off-centre storey) it leans from the centre of resistance toward the load.
 */
function hingeFor(hull: Point2[], com: Point2, resistance: Point2): Hinge {
  const edge = nearestEdge(hull, com);
  if (insideConvex(hull, com)) return { a: edge.a, b: edge.b, lean: unit(com.x - resistance.x, com.z - resistance.z) };
  const ex = edge.b.x - edge.a.x;
  const ez = edge.b.z - edge.a.z;
  const t = Math.max(0, Math.min(1, ((com.x - edge.a.x) * ex + (com.z - edge.a.z) * ez) / (ex * ex + ez * ez || 1)));
  return { a: edge.a, b: edge.b, lean: unit(com.x - (edge.a.x + ex * t), com.z - (edge.a.z + ez * t)) };
}

function loadCentre(segment: Segment, load: { mass: number; x: number; z: number }, push: SupportPush | null, tuning: DestructionTuning): Point2 {
  if (!push || push.impulse <= 0) return { x: load.x, z: load.z };
  const shift = Math.min((push.impulse / load.mass) * tuning.pushLever, (tuning.maxPushShift * Math.min(segment.w, segment.d)) / 2);
  return { x: load.x + push.x * shift, z: load.z + push.z * shift };
}

function storeyBase(structure: BuildingStructure, ref: StoreyRef): number {
  const s = structure.segments[ref.segment]!;
  return s.y0 + ref.storey * s.layout.storeyHeight;
}

export function checkSupport(structure: BuildingStructure, damaged: readonly StoreyRef[], tuning: DestructionTuning, push: SupportPush | null = null): SupportVerdict {
  const verdict: SupportVerdict = { failure: null, strain: null, crushed: [] };
  const directed = push !== null && push.impulse > 0;
  const order = [...damaged].sort((a, b) => storeyBase(structure, a) - storeyBase(structure, b));
  for (const { segment, storey } of order) {
    const s = structure.segments[segment]!;
    if (s.sturdy) continue;
    for (let pass = 0; pass <= tuning.maxCrushPasses; pass++) {
      const load = structure.loadAbove(segment, storey);
      if (load.mass <= 0) break;
      const survivors = structure.presentNodes(segment, storey);
      const ratio = loadRatio(structure, segment, storey);
      if (survivors.length === 0) {
        verdict.failure = { kind: 'detach', segment, storey, hinge: null, loadRatio: ratio };
        return verdict;
      }
      const hull = survivorHull(structure, survivors);
      const com = loadCentre(s, load, push, tuning);
      if (!insideConvex(hull, com)) {
        verdict.failure = { kind: 'topple', segment, storey, hinge: hingeFor(hull, com, resistanceCentre(structure, survivors)), loadRatio: ratio };
        return verdict;
      }
      if (ratio > 1) {
        const middle = resistanceCentre(structure, survivors);
        const reach = Math.max(...hull.map((p) => Math.hypot(p.x - middle.x, p.z - middle.z)), 1e-6);
        const offX = com.x - middle.x;
        const offZ = com.z - middle.z;
        const offset = Math.hypot(offX, offZ);
        // Only a directed hit loads one side harder; undirected damage (a blast) pancakes.
        const offCentre = directed && offset / reach > tuning.offCentreShare;
        if (offCentre && survivors.length > 1 && pass < tuning.maxCrushPasses) {
          // The heavy side is carrying more than its share: crush the survivors furthest toward the
          // load (the whole row within TIE_BAND, so symmetric damage stays symmetric).
          const along = survivors.map((node) => {
            const c = structure.nodeCentre(node);
            return ((c.x - middle.x) * offX + (c.z - middle.z) * offZ) / offset;
          });
          const furthest = Math.max(...along);
          survivors.forEach((node, i) => {
            if (along[i]! < furthest - TIE_BAND) return;
            structure.crush(node.id);
            verdict.crushed.push(node.id);
          });
          continue;
        }
        if (offCentre) {
          verdict.failure = { kind: 'topple', segment, storey, hinge: hingeFor(hull, com, middle), loadRatio: ratio };
        } else {
          verdict.failure = { kind: 'pancake', segment, storey, hinge: null, loadRatio: ratio };
        }
        return verdict;
      }
      if (ratio >= tuning.strainRatio && (!verdict.strain || ratio > verdict.strain.loadRatio)) {
        verdict.strain = { segment, storey, loadRatio: ratio };
      }
      break;
    }
  }
  return verdict;
}
