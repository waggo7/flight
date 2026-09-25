import type { FacadeStyle} from './city-blueprint';
import { type BoxPiece, type CityBlueprint, type PieceRef, type PieceRole, type RoundPiece } from './city-blueprint';
import { perStyle, type DestructionTuning } from './destruction-tuning';
import { bayColumnStarts, boxStoreyLayout, roundStoreyLayout, type StoreyLayout } from './storey-layout';

// One building as a structure: a stack of segments (tiers, twist slabs, round drums), each a
// stack of storeys. A storey starts as one node and expands into bay chunks the first time it is
// damaged, so a 300 m tower costs a few hundred nodes, not thousands. Every node knows its mass
// and how much energy it can absorb before it is crushed; ornaments (crowns, roof kit, spires,
// beacons) ride the storey they sit on. Pure data — the physics layer turns failures into bodies.

export const NodeState = { Intact: 0, Crushed: 1, Detached: 2, Expanded: 3 } as const;
export type NodeState = (typeof NodeState)[keyof typeof NodeState];

export interface Segment {
  index: number;
  piece: PieceRef;
  shape: 'box' | 'round';
  role: PieceRole;
  style: FacadeStyle;
  /** Footprint centre, yaw, base height. */
  x: number;
  z: number;
  yaw: number;
  y0: number;
  /** Size; round segments use the diameter for w and d. */
  w: number;
  h: number;
  d: number;
  layout: StoreyLayout;
  /** Podiums and landmark bases scar but never break. */
  sturdy: boolean;
  /** The segment this one stands on, or -1 when it stands on the ground or a podium. */
  below: number;
  density: number;
  crushEnergy: number;
  reserve: number;
}

export interface StructureNode {
  id: number;
  segment: number;
  storey: number;
  /** -1 = the whole storey; otherwise bx * baysZ + bz. */
  bay: number;
  /** Box in the segment's local frame: x, z from its min corner, y from its base (metres). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  mass: number;
  /** Energy (J) it can still absorb before it is crushed. */
  health: number;
  state: NodeState;
}

export interface Ornament {
  piece: PieceRef;
  /** Rides the top storey of this segment. */
  segment: number;
  mass: number;
  detached: boolean;
}

export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

const STRUCTURAL_ROLES: ReadonlySet<PieceRole> = new Set(['tower', 'podium', 'base']);
const STURDY_ROLES: ReadonlySet<PieceRole> = new Set(['podium', 'base']);

export class BuildingStructure {
  readonly segments: Segment[] = [];
  readonly nodes: StructureNode[] = [];
  /** segment → storey → ids of the nodes that currently make up that storey. */
  readonly storeys: number[][][] = [];
  readonly ornaments: Ornament[] = [];
  /** Intact mass resting on each storey (everything above it, ornaments included). */
  readonly intactLoad: number[][] = [];
  /** Segments each segment carries, transitively (tiers stacked on it). */
  readonly carried: number[][] = [];

  constructor(
    readonly building: number,
    blueprint: CityBlueprint,
    readonly tuning: DestructionTuning,
  ) {
    const spec = blueprint.buildings[building];
    if (!spec) throw new Error(`no building ${building}`);
    const pieces = spec.pieces.map((ref) => ({ ref, data: ref.kind === 'box' ? blueprint.boxes[ref.index]! : ref.kind === 'round' ? blueprint.rounds[ref.index]! : null }));
    const structural = pieces
      .filter((p): p is { ref: PieceRef; data: BoxPiece | RoundPiece } => !!p.data && STRUCTURAL_ROLES.has(p.data.role))
      .sort((a, b) => a.data.y0 - b.data.y0);
    for (const { ref, data } of structural) this.addSegment(ref, data);
    this.linkStack();
    for (const p of pieces) {
      if (p.data && STRUCTURAL_ROLES.has(p.data.role)) continue;
      this.addOrnament(p.ref, blueprint);
    }
    this.computeIntactLoads();
  }

  // ----- construction ---------------------------------------------------------------------

  private addSegment(piece: PieceRef, data: BoxPiece | RoundPiece): void {
    const round = data.kind === 'round';
    const w = round ? data.radius * 2 : data.w;
    const d = round ? data.radius * 2 : data.d;
    const layout = round ? roundStoreyLayout(data) : boxStoreyLayout(data);
    const sturdy = STURDY_ROLES.has(data.role);
    const segment: Segment = {
      index: this.segments.length, piece, shape: round ? 'round' : 'box', role: data.role, style: data.style,
      x: data.x, z: data.z, yaw: round ? 0 : data.yaw, y0: data.y0, w, h: data.h, d, layout, sturdy, below: -1,
      density: perStyle(this.tuning.density, data.style),
      crushEnergy: sturdy ? Infinity : perStyle(this.tuning.crushEnergy, data.style) * (round ? this.tuning.roundToughness : 1),
      reserve: sturdy ? Infinity : perStyle(this.tuning.reserve, data.style),
    };
    this.segments.push(segment);
    const storeys: number[][] = [];
    for (let s = 0; s < layout.storeys; s++) {
      storeys.push([this.addNode(segment, s, -1, 0, w, s * layout.storeyHeight, (s + 1) * layout.storeyHeight, 0, d)]);
    }
    this.storeys.push(storeys);
  }

  private addNode(segment: Segment, storey: number, bay: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number {
    const volume = segment.shape === 'round' && bay < 0 ? (Math.PI * (x1 - x0) * (z1 - z0) * (y1 - y0)) / 4 : (x1 - x0) * (y1 - y0) * (z1 - z0);
    const id = this.nodes.length;
    this.nodes.push({ id, segment: segment.index, storey, bay, x0, x1, y0, y1, z0, z1, mass: volume * segment.density, health: volume * segment.crushEnergy, state: NodeState.Intact });
    return id;
  }

  /** Tiers stand on the segment whose top meets their base and whose footprint holds their centre. */
  private linkStack(): void {
    for (const segment of this.segments) {
      let best = -1;
      for (const other of this.segments) {
        if (other.index === segment.index) continue;
        if (Math.abs(other.y0 + other.h - segment.y0) > 0.05) continue;
        if (!this.containsXZ(other, segment.x, segment.z)) continue;
        best = other.index;
      }
      segment.below = best;
    }
    for (let i = 0; i < this.segments.length; i++) this.carried.push([]);
    for (const segment of this.segments) {
      let below = segment.below;
      while (below >= 0) {
        this.carried[below]!.push(segment.index);
        below = this.segments[below]!.below;
      }
    }
  }

  private addOrnament(piece: PieceRef, blueprint: CityBlueprint): void {
    let base: WorldPoint;
    let mass: number;
    const plain = this.tuning.density.plain;
    if (piece.kind === 'box') {
      const b = blueprint.boxes[piece.index]!;
      base = { x: b.x, y: b.y0, z: b.z };
      mass = b.w * b.h * b.d * plain;
    } else if (piece.kind === 'round') {
      const r = blueprint.rounds[piece.index]!;
      base = { x: r.x, y: r.y0, z: r.z };
      mass = Math.PI * r.radius * r.radius * r.h * plain;
    } else if (piece.kind === 'spire') {
      const s = blueprint.spires[piece.index]!;
      base = { x: s.x, y: s.y, z: s.z };
      mass = (Math.PI * s.radius * s.radius * s.height * plain) / 3;
    } else {
      const b = blueprint.beacons[piece.index]!;
      base = { x: b.x, y: b.y, z: b.z };
      mass = 0;
    }
    // The highest segment whose top is at or below the ornament's base and holds its centre.
    let host = -1;
    let hostTop = -Infinity;
    for (const segment of this.segments) {
      const top = segment.y0 + segment.h;
      if (top <= base.y + 0.5 && top > hostTop && this.containsXZ(segment, base.x, base.z)) {
        host = segment.index;
        hostTop = top;
      }
    }
    if (host < 0) host = this.segments.length - 1;
    if (host >= 0) this.ornaments.push({ piece, segment: host, mass, detached: false });
  }

  private computeIntactLoads(): void {
    for (const segment of this.segments) {
      const loads: number[] = [];
      const storeyMass = this.storeys[segment.index]!.map((ids) => ids.reduce((m, id) => m + this.nodes[id]!.mass, 0));
      let carriedMass = 0;
      for (const other of this.carried[segment.index]!) carriedMass += this.storeys[other]!.flat().reduce((m, id) => m + this.nodes[id]!.mass, 0);
      for (const ornament of this.ornaments) {
        if (ornament.segment === segment.index || this.carried[segment.index]!.includes(ornament.segment)) carriedMass += ornament.mass;
      }
      let above = carriedMass;
      for (let s = segment.layout.storeys - 1; s >= 0; s--) {
        loads[s] = above;
        above += storeyMass[s]!;
      }
      this.intactLoad.push(loads);
    }
  }

  // ----- geometry -------------------------------------------------------------------------

  containsXZ(segment: Segment, x: number, z: number, margin = 0): boolean {
    const local = this.worldToLocal(segment.index, { x, y: segment.y0, z });
    if (segment.shape === 'round') return Math.hypot(local.x - segment.w / 2, local.z - segment.d / 2) <= segment.w / 2 + margin;
    return local.x >= -margin && local.x <= segment.w + margin && local.z >= -margin && local.z <= segment.d + margin;
  }

  /** Local (x, z from the segment's min corner, y from its base) → world. */
  localToWorld(segmentIndex: number, p: WorldPoint): WorldPoint {
    const s = this.segments[segmentIndex]!;
    const lx = p.x - s.w / 2;
    const lz = p.z - s.d / 2;
    const cos = Math.cos(s.yaw);
    const sin = Math.sin(s.yaw);
    return { x: s.x + lx * cos + lz * sin, y: s.y0 + p.y, z: s.z - lx * sin + lz * cos };
  }

  worldToLocal(segmentIndex: number, p: WorldPoint): WorldPoint {
    const s = this.segments[segmentIndex]!;
    const dx = p.x - s.x;
    const dz = p.z - s.z;
    const cos = Math.cos(s.yaw);
    const sin = Math.sin(s.yaw);
    return { x: dx * cos - dz * sin + s.w / 2, y: p.y - s.y0, z: dx * sin + dz * cos + s.d / 2 };
  }

  nodeCentre(node: StructureNode): WorldPoint {
    return this.localToWorld(node.segment, { x: (node.x0 + node.x1) / 2, y: (node.y0 + node.y1) / 2, z: (node.z0 + node.z1) / 2 });
  }

  /** Footprint corners of a node on the ground plane (world x, z). Round drums use 8 rim points. */
  footprint(node: StructureNode): { x: number; z: number }[] {
    const segment = this.segments[node.segment]!;
    if (segment.shape === 'round' && node.bay < 0) {
      const r = segment.w / 2;
      return Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return { x: segment.x + Math.cos(a) * r, z: segment.z + Math.sin(a) * r };
      });
    }
    return [
      [node.x0, node.z0], [node.x1, node.z0], [node.x1, node.z1], [node.x0, node.z1],
    ].map(([x, z]) => {
      const w = this.localToWorld(node.segment, { x: x!, y: 0, z: z! });
      return { x: w.x, z: w.z };
    });
  }

  footprintArea(node: StructureNode): number {
    const segment = this.segments[node.segment]!;
    if (segment.shape === 'round' && node.bay < 0) return (Math.PI * segment.w * segment.d) / 4;
    return (node.x1 - node.x0) * (node.z1 - node.z0);
  }

  fullArea(segmentIndex: number): number {
    const segment = this.segments[segmentIndex]!;
    return segment.shape === 'round' ? (Math.PI * segment.w * segment.d) / 4 : segment.w * segment.d;
  }

  // ----- state ----------------------------------------------------------------------------

  /** Split a storey into bay chunks (no-op for round drums or already-expanded storeys). Returns its node ids. */
  expandStorey(segmentIndex: number, storey: number): number[] {
    const segment = this.segments[segmentIndex];
    const current = this.storeys[segmentIndex]?.[storey];
    if (!segment || !current) return [];
    if (segment.shape === 'round' || current.length !== 1 || this.nodes[current[0]!]!.bay >= 0) return current;
    const whole = this.nodes[current[0]!]!;
    if (whole.state !== NodeState.Intact) return current;
    const { layout } = segment;
    const xs = bayColumnStarts(layout.columnsX, layout.baysX).map((c) => (c * segment.w) / layout.columnsX);
    const zs = bayColumnStarts(layout.columnsZ, layout.baysZ).map((c) => (c * segment.d) / layout.columnsZ);
    const ids: number[] = [];
    const damageShare = whole.health / (whole.mass / segment.density * segment.crushEnergy || 1);
    for (let bx = 0; bx < layout.baysX; bx++) {
      for (let bz = 0; bz < layout.baysZ; bz++) {
        const id = this.addNode(segment, storey, bx * layout.baysZ + bz, xs[bx]!, xs[bx + 1]!, whole.y0, whole.y1, zs[bz]!, zs[bz + 1]!);
        this.nodes[id]!.health *= Number.isFinite(damageShare) ? damageShare : 1;
        ids.push(id);
      }
    }
    whole.state = NodeState.Expanded;
    this.storeys[segmentIndex]![storey] = ids;
    return ids;
  }

  isPresent(node: StructureNode): boolean {
    return node.state === NodeState.Intact;
  }

  presentNodes(segmentIndex: number, storey: number): StructureNode[] {
    return (this.storeys[segmentIndex]?.[storey] ?? []).map((id) => this.nodes[id]!).filter((n) => this.isPresent(n));
  }

  /** Share of a storey's footprint still standing (0..1). */
  storeyShare(segmentIndex: number, storey: number): number {
    const present = this.presentNodes(segmentIndex, storey).reduce((a, n) => a + this.footprintArea(n), 0);
    return present / this.fullArea(segmentIndex);
  }

  /** Mass resting on a storey right now, and its centre (world x, z). */
  loadAbove(segmentIndex: number, storey: number): { mass: number; x: number; z: number } {
    let mass = 0;
    let mx = 0;
    let mz = 0;
    const addNode = (node: StructureNode): void => {
      if (!this.isPresent(node)) return;
      const c = this.nodeCentre(node);
      mass += node.mass;
      mx += c.x * node.mass;
      mz += c.z * node.mass;
    };
    const storeys = this.storeys[segmentIndex]!;
    for (let s = storey + 1; s < storeys.length; s++) for (const id of storeys[s]!) addNode(this.nodes[id]!);
    const carried = this.carried[segmentIndex]!;
    for (const other of carried) for (const ids of this.storeys[other]!) for (const id of ids) addNode(this.nodes[id]!);
    for (const ornament of this.ornaments) {
      if (ornament.detached) continue;
      if (ornament.segment !== segmentIndex && !carried.includes(ornament.segment)) continue;
      const host = this.segments[ornament.segment]!;
      mass += ornament.mass;
      mx += host.x * ornament.mass;
      mz += host.z * ornament.mass;
    }
    return mass > 0 ? { mass, x: mx / mass, z: mz / mass } : { mass: 0, x: this.segments[segmentIndex]!.x, z: this.segments[segmentIndex]!.z };
  }

  /** Every node and ornament above a storey (what falls if that storey fails). */
  partAbove(segmentIndex: number, storey: number): { nodes: number[]; ornaments: number[]; segments: number[] } {
    const nodes: number[] = [];
    const storeys = this.storeys[segmentIndex]!;
    for (let s = storey + 1; s < storeys.length; s++) nodes.push(...storeys[s]!.filter((id) => this.isPresent(this.nodes[id]!)));
    const carried = this.carried[segmentIndex]!;
    for (const other of carried) for (const ids of this.storeys[other]!) nodes.push(...ids.filter((id) => this.isPresent(this.nodes[id]!)));
    const ornaments: number[] = [];
    this.ornaments.forEach((o, i) => {
      if (!o.detached && (o.segment === segmentIndex || carried.includes(o.segment))) ornaments.push(i);
    });
    return { nodes, ornaments, segments: [segmentIndex, ...carried] };
  }

  /** Mark nodes (and the ornaments above) as having left the building. */
  detach(part: { nodes: number[]; ornaments: number[] }): void {
    for (const id of part.nodes) this.nodes[id]!.state = NodeState.Detached;
    for (const index of part.ornaments) this.ornaments[index]!.detached = true;
  }

  crush(id: number): void {
    const node = this.nodes[id]!;
    if (node.state === NodeState.Intact) {
      node.state = NodeState.Crushed;
      node.health = 0;
    }
  }
}
