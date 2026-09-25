import type RAPIER from '@dimforge/rapier3d-compat';
import { BuildingStructure, NodeState, type WorldPoint } from '../core/building-structure';
import { FacadeStyle, type CityBlueprint, type PieceRef } from '../core/city-blueprint';
import { applyDamage, type DamageEvent, type DamageOutcome } from '../core/crush-planner';
import { perStyle, type DestructionTuning } from '../core/destruction-tuning';
import type { SmashOutcome } from '../core/flight-model';
import { regionsOfNodes, regionVolume, splitIntoBands, splitIntoBays, standingRegions, type Region } from '../core/structure-regions';
import { checkSupport, type SupportFailure, type SupportPush } from '../core/support-check';
import type { EventBus } from '../engine/event-bus';
import type { GameEventMap } from '../engine/event-bus';
import type { QualityProfile } from '../engine/game-context';
import type { RandomStream } from '../engine/random-streams';
import { ornamentPlacement, placementCollider, regionPlacement, solverMass, type Placement } from './destruction-bodies';
import type { PhysicsWorld } from './physics-world';
import type { WorldHit } from './rapier-city-world';

// Rules decide, Rapier moves. A hit goes through the crush planner and the support check (core,
// pure); this turns their verdicts into the world: a damaged building's colliders are rebuilt from
// what still stands, crushed chunks fly off as debris, and the part above a failed storey becomes
// one dynamic body that Rapier tips over the stump (no scripted pivot). Contacts do the rest:
// hard landings break sections into bands and chunks, a section dropping onto its own stump
// crushes the next storey (pancake), and one hitting a neighbour damages it (dominoes).
// Everything here works on Rapier handles, never objects: Restart swaps the world.

declare module '../engine/event-bus' {
  interface GameEventMap {
    'destruction:damage': {
      building: number;
      outcome: DamageOutcome;
      crushed: WorldPoint[];
      point: WorldPoint;
      generation: number;
      /** Facade style of what broke (glass towers shed glass). */
      style: number;
      /** Which way the hit was going (dust and chips fly that way), or null for crushing under load. */
      direction: WorldPoint | null;
    };
    'destruction:strain': { building: number; loadRatio: number; position: WorldPoint };
    'destruction:failure': { building: number; kind: SupportFailure; position: WorldPoint; height: number; mass: number; first: boolean };
    'destruction:impact': { position: WorldPoint; energy: number; mass: number; ground: boolean };
    /**
     * The hero hit something breakable. `soaked` = share of the punch's energy the target used up
     * (0 = paper, 1 = stopped dead): the recoil (speed lost, stagger, camera punch) follows it.
     */
    'destruction:hero-hit': { kind: SmashOutcome['kind']; brokeThrough: boolean; soaked: number; point: WorldPoint; direction: WorldPoint; glass: boolean };
  }
}

export type FragmentLevel = 0 | 1 | 2;

/** Something the renderer draws for the destruction: a region, an ornament riding a body, or debris. */
export type DestructionItem =
  | { kind: 'region'; id: number; building: number; region: Region; body: number | null; origin: WorldPoint }
  | { kind: 'ornament'; id: number; building: number; piece: PieceRef; body: number; origin: WorldPoint }
  | { kind: 'debris'; id: number; building: number; segment: number; body: number; size: WorldPoint };

type NewItem = DestructionItem extends infer T ? (T extends DestructionItem ? Omit<T, 'id'> : never) : never;

export interface DestructionChanges {
  reset: boolean;
  added: DestructionItem[];
  removed: number[];
  /** Intact pieces to stop drawing (their building took damage or they fell). */
  hidden: PieceRef[];
}

export interface BodyPose {
  position: WorldPoint;
  rotation: { x: number; y: number; z: number; w: number };
}

interface BuildingState {
  structure: BuildingStructure;
  body: number;
  /** Static collider handles and drawn items per segment once it has been rebuilt from regions. */
  segmentColliders: Map<number, number[]>;
  segmentItems: Map<number, number[]>;
  cooldownUntil: number;
}

interface Fragment {
  body: number;
  level: FragmentLevel;
  building: number;
  generation: number;
  massReal: number;
  massSim: number;
  origin: WorldPoint;
  regions: Region[];
  ornaments: PieceRef[];
  items: number[];
  debris: boolean;
  bornAt: number;
  asleepFor: number;
  frozen: boolean;
  /** J a contact must carry to break this fragment up. */
  breakupEnergy: number;
  /** The storey a toppling section pivots on; crushed once it leans past hingeTilt. */
  hinge: { segment: number; storey: number } | null;
  /** Pancaking sections crush whole storeys under them; toppling ones crush the edge they roll over. */
  mode: 'topple' | 'pancake';
  /** Storeys (pancake) or edge crushes (topple) so far. */
  pancakeStoreys: number;
  nextEdgeCrush: number;
  /** Carried by the hero (never frozen or culled). */
  held: boolean;
  /** Until then (s), hitting a building damages it: a thrown piece. */
  projectileUntil: number;
  preVelocity: WorldPoint;
  previous: BodyPose;
  current: BodyPose;
}

export interface DestructionOptions {
  profile: QualityProfile;
  heroRadius: number;
  events: EventBus<GameEventMap>;
  random: () => RandomStream;
  /** Called when the hero bursts through a building (the world lets the hero pass for a moment). */
  onBurst?: (building: number) => void;
}

const UP = { x: 0, y: 1, z: 0 };
const length3 = (v: WorldPoint): number => Math.hypot(v.x, v.y, v.z);

function rotate(q: BodyPose['rotation'], v: WorldPoint): WorldPoint {
  // v' = q v q*
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

export class DestructionSystem {
  private readonly buildings = new Map<number, BuildingState>();
  private readonly fragments = new Map<number, Fragment>();
  private changes: DestructionChanges = { reset: false, added: [], removed: [], hidden: [] };
  private nextItem = 1;
  private time = 0;
  private failures = 0;
  enabled = true;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly blueprint: CityBlueprint,
    private readonly tuning: DestructionTuning,
    private readonly options: DestructionOptions,
  ) {}

  // ----- queries ------------------------------------------------------------------------

  structureOf(building: number): BuildingStructure | null {
    return this.buildings.get(building)?.structure ?? null;
  }

  /** Live fragment bodies (sections, bands, chunks, debris). */
  get fragmentCount(): number {
    return this.fragments.size;
  }

  countBodies(filter: (f: { level: FragmentLevel; debris: boolean; frozen: boolean }) => boolean): number {
    let n = 0;
    for (const f of this.fragments.values()) if (filter(f)) n++;
    return n;
  }

  takeChanges(): DestructionChanges {
    const out = this.changes;
    this.changes = { reset: false, added: [], removed: [], hidden: [] };
    return out;
  }

  /** Interpolated pose of a fragment body (alpha between the last two steps). */
  pose(body: number, alpha: number, out: BodyPose): boolean {
    const f = this.fragments.get(body);
    if (!f) return false;
    const a = f.previous;
    const b = f.current;
    out.position.x = a.position.x + (b.position.x - a.position.x) * alpha;
    out.position.y = a.position.y + (b.position.y - a.position.y) * alpha;
    out.position.z = a.position.z + (b.position.z - a.position.z) * alpha;
    // nlerp is plenty between two 1/60 s steps
    const dot = a.rotation.x * b.rotation.x + a.rotation.y * b.rotation.y + a.rotation.z * b.rotation.z + a.rotation.w * b.rotation.w;
    const sign = dot < 0 ? -1 : 1;
    const r = out.rotation;
    r.x = a.rotation.x + (b.rotation.x * sign - a.rotation.x) * alpha;
    r.y = a.rotation.y + (b.rotation.y * sign - a.rotation.y) * alpha;
    r.z = a.rotation.z + (b.rotation.z * sign - a.rotation.z) * alpha;
    r.w = a.rotation.w + (b.rotation.w * sign - a.rotation.w) * alpha;
    const n = Math.hypot(r.x, r.y, r.z, r.w) || 1;
    r.x /= n;
    r.y /= n;
    r.z /= n;
    r.w /= n;
    return true;
  }

  // ----- damage in ------------------------------------------------------------------------

  /** The flight model's smash hook: the hero hit `hit` at `impact` m/s into the surface. */
  heroHit(hit: WorldHit, point: WorldPoint, velocity: WorldPoint, impact: number, extraMass = 0): SmashOutcome | null {
    if (!this.enabled || impact < this.tuning.dentSpeed) return null;
    const speed = length3(velocity);
    if (speed < 1e-3) return null;
    const dir = { x: velocity.x / speed, y: velocity.y / speed, z: velocity.z / speed };
    const punchMass = this.tuning.punchMass + extraMass;
    const owner = hit.owner;

    if (owner.kind === 'actor' || owner.kind === 'chunk') {
      // Punching a falling section: it breaks up and takes the hero's shove.
      const fragment = this.fragments.get(owner.id);
      if (!fragment) return null;
      const body = this.physics.world.getRigidBody(fragment.body);
      const shove = Math.min(punchMass * impact / fragment.massReal, this.tuning.motion.maxPushSpeed * 2) * fragment.massSim;
      body.applyImpulse({ x: dir.x * shove, y: dir.y * shove, z: dir.z * shove }, true);
      if (fragment.level < 2) this.breakUp(fragment, point);
      this.options.onBurst?.(fragment.building);
      this.options.events.emit('destruction:hero-hit', { kind: 'burst', brokeThrough: true, soaked: 0.4 - 0.12 * fragment.level, point: { ...point }, direction: dir, glass: false });
      return { brokeThrough: true, strength: 0.6, kind: 'burst' };
    }
    if (owner.kind !== 'building') return null;

    const energy = 0.5 * punchMass * speed * impact;
    const result = this.damageBuilding(owner.building, {
      kind: 'blunt',
      shape: { type: 'sweep', from: { x: point.x - dir.x * 4, y: point.y - dir.y * 4, z: point.z - dir.z * 4 }, direction: dir, radius: this.options.heroRadius + this.tuning.tunnelClearance },
      energy,
      speed,
      impulse: punchMass * impact,
      generation: 0,
    }, point);
    if (!result || result.outcome === 'none') return null;
    const brokeThrough = result.outcome === 'burst';
    if (brokeThrough) this.options.onBurst?.(owner.building);
    const strength = Math.min(1, Math.max(0.2, energy / 3e8));
    const kind = result.failed ? 'topple' : brokeThrough ? 'burst' : 'dent';
    // Bursting through, the building took what the crush cost; bouncing off, the hero lost the
    // part of its speed that went into the wall (a glancing scrape barely counts).
    const soaked = brokeThrough ? Math.min(1, result.energyUsed / energy) : Math.min(1, impact / speed);
    this.options.events.emit('destruction:hero-hit', { kind, brokeThrough, soaked, point: { ...point }, direction: dir, glass: result.style === FacadeStyle.glass });
    return { brokeThrough, strength, kind };
  }

  /** Any damage event on a building (hero, knock-ons, powers). */
  damageBuilding(building: number, event: DamageEvent, point: WorldPoint): { outcome: DamageOutcome; failed: boolean; energyUsed: number; style: number } | null {
    const state = this.buildingState(building);
    if (!state) return null;
    const { structure } = state;
    const report = applyDamage(structure, event, this.tuning);
    if (report.outcome === 'none') return { outcome: 'none', failed: false, energyUsed: 0, style: structure.segments[0]!.style };
    const touched = new Set(report.storeys.map((s) => s.segment));
    const crushedPoints: WorldPoint[] = [];
    this.spawnDebris(state, report.crushed, event, crushedPoints);

    const verdict = checkSupport(structure, report.storeys, this.tuning, report.push);
    this.spawnDebris(state, verdict.crushed, event, crushedPoints);
    for (const id of verdict.crushed) touched.add(structure.nodes[id]!.segment);
    if (verdict.strain && !verdict.failure) {
      const s = structure.segments[verdict.strain.segment]!;
      this.options.events.emit('destruction:strain', { building, loadRatio: verdict.strain.loadRatio, position: { x: s.x, y: s.y0 + verdict.strain.storey * s.layout.storeyHeight, z: s.z } });
    }
    let failed = false;
    if (verdict.failure) {
      failed = this.fail(state, verdict.failure.segment, verdict.failure.storey, verdict.failure.kind, report.push, event.generation, touched, crushedPoints);
    }
    for (const segment of touched) this.rebuildSegment(state, segment);
    const style = structure.segments[report.storeys[0]?.segment ?? 0]!.style;
    this.options.events.emit('destruction:damage', {
      building, outcome: report.outcome, crushed: crushedPoints, point, generation: event.generation, style,
      direction: event.shape.type === 'sweep' ? event.shape.direction : null,
    });
    return { outcome: report.outcome, failed, energyUsed: report.energyUsed, style };
  }

  // ----- stepping -------------------------------------------------------------------------

  /** Before the physics step: remember velocities (impact energies come from their change). */
  beforeStep(): void {
    const world = this.physics.world;
    for (const f of this.fragments.values()) {
      if (f.frozen) continue;
      const v = world.getRigidBody(f.body).linvel();
      f.preVelocity.x = v.x;
      f.preVelocity.y = v.y;
      f.preVelocity.z = v.z;
    }
  }

  /** After the physics step: contacts, hinges, the rubble governor, poses. */
  afterStep(dt: number): void {
    this.time += dt;
    this.handleContacts();
    this.checkHinges();
    this.govern(dt);
    const world = this.physics.world;
    for (const f of this.fragments.values()) {
      if (f.frozen) {
        f.previous = f.current;
        continue;
      }
      const body = world.getRigidBody(f.body);
      f.previous = f.current;
      f.current = { position: { ...body.translation() }, rotation: { ...body.rotation() } };
    }
  }

  /** Restart: the world has already been restored to the pristine city; forget everything. */
  reset(): void {
    this.buildings.clear();
    this.fragments.clear();
    this.changes = { reset: true, added: [], removed: [], hidden: [] };
    this.time = 0;
    this.failures = 0;
  }

  // ----- powers ---------------------------------------------------------------------------

  /** Loose pieces whose centre of mass is within `radius` of `point`. */
  fragmentsNear(point: WorldPoint, radius: number): { body: number; massReal: number; level: FragmentLevel; debris: boolean; centre: WorldPoint }[] {
    const world = this.physics.world;
    const out: { body: number; massReal: number; level: FragmentLevel; debris: boolean; centre: WorldPoint }[] = [];
    for (const f of this.fragments.values()) {
      const com = world.getRigidBody(f.body).worldCom();
      if (Math.hypot(com.x - point.x, com.y - point.y, com.z - point.z) <= radius) out.push({ body: f.body, massReal: f.massReal, level: f.level, debris: f.debris, centre: { x: com.x, y: com.y, z: com.z } });
    }
    return out;
  }

  /** Shove loose pieces away from `point`: `speed` m/s at the centre, falling off as (1 − d/R)². */
  nudge(point: WorldPoint, radius: number, speed: number): void {
    const world = this.physics.world;
    for (const near of this.fragmentsNear(point, radius)) {
      const f = this.fragments.get(near.body)!;
      if (f.held) continue;
      this.thaw(f);
      const d = Math.max(1, Math.hypot(near.centre.x - point.x, near.centre.z - point.z));
      const falloff = (1 - Math.min(1, d / radius)) ** 2;
      const push = Math.min(this.tuning.motion.maxPushSpeed * 2, speed * falloff) * f.massSim;
      world.getRigidBody(f.body).applyImpulse({ x: ((near.centre.x - point.x) / d) * push, y: push * 0.6, z: ((near.centre.z - point.z) / d) * push }, true);
    }
  }

  /** Pick up a loose piece: it rides the hero's hold point and no longer touches debris. */
  hold(bodyHandle: number): boolean {
    const f = this.fragments.get(bodyHandle);
    if (!f || f.level === 0) return false;
    this.thaw(f);
    const { world, groups, rapier } = this.physics;
    const body = world.getRigidBody(f.body);
    if (f.debris) {
      // Debris becomes a proper chunk: it reports contacts and is never culled for age.
      f.debris = false;
      f.level = 2;
    }
    for (let i = 0; i < body.numColliders(); i++) {
      const collider = body.collider(i);
      collider.setCollisionGroups(groups.held);
      collider.setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS);
      collider.setContactForceEventThreshold(3 * 9.81 * f.massSim);
      const owner = this.physics.ownerOf(collider);
      if (owner) owner.kind = 'chunk';
    }
    body.enableCcd(true);
    f.held = true;
    f.hinge = null;
    return true;
  }

  /** Let go of a held piece at `velocity`; for `seconds` whatever building it hits takes the blow. */
  throwHeld(bodyHandle: number, velocity: WorldPoint, seconds: number): void {
    const f = this.fragments.get(bodyHandle);
    if (!f) return;
    const body = this.physics.world.getRigidBody(f.body);
    for (let i = 0; i < body.numColliders(); i++) body.collider(i).setCollisionGroups(this.physics.groups.chunk);
    body.setLinvel(velocity, true);
    f.held = false;
    f.projectileUntil = this.time + seconds;
    f.preVelocity = { ...velocity };
  }

  /** Drop a held piece without throwing it (Restart, grab lost). */
  releaseHeld(bodyHandle: number): void {
    const f = this.fragments.get(bodyHandle);
    if (!f) return;
    const body = this.physics.world.getRigidBody(f.body);
    for (let i = 0; i < body.numColliders(); i++) body.collider(i).setCollisionGroups(this.physics.groups.chunk);
    f.held = false;
  }

  isLoose(bodyHandle: number): boolean {
    return this.fragments.has(bodyHandle);
  }

  massOf(bodyHandle: number): number {
    return this.fragments.get(bodyHandle)?.massReal ?? 0;
  }

  /** A piece smashes to rubble (a held chunk rammed into a building, a projectile's hit). */
  shatter(bodyHandle: number): void {
    const f = this.fragments.get(bodyHandle);
    if (!f) return;
    const state = this.buildings.get(f.building);
    const centre = { ...this.physics.world.getRigidBody(f.body).worldCom() };
    const velocity = { ...f.preVelocity };
    const segment = f.regions[0]?.segment ?? 0;
    this.removeFragment(f);
    if (!state) return;
    const pieces = Math.min(5, Math.max(2, Math.round(Math.cbrt(f.massReal / 30000))));
    const points: WorldPoint[] = [];
    for (let i = 0; i < pieces; i++) this.spawnDebrisBody(state, segment, centre, 2.2, velocity, points);
    this.options.events.emit('destruction:damage', {
      building: f.building, outcome: 'crush', crushed: points, point: centre, generation: 0,
      style: state.structure.segments[segment]?.style ?? 1, direction: null,
    });
  }

  private projectileHit(fragment: Fragment, building: number, point: WorldPoint): void {
    const v = fragment.preVelocity;
    const speed = Math.hypot(v.x, v.y, v.z);
    fragment.projectileUntil = 0;
    if (speed < 5) return;
    const dir = { x: v.x / speed, y: v.y / speed, z: v.z / speed };
    this.damageBuilding(building, {
      kind: 'blunt',
      shape: { type: 'sweep', from: { x: point.x - dir.x * 4, y: point.y - dir.y * 4, z: point.z - dir.z * 4 }, direction: dir, radius: 2.5 },
      energy: 0.5 * fragment.massReal * speed * speed,
      speed,
      impulse: fragment.massReal * speed,
      generation: 0,
    }, point);
    if (this.fragments.has(fragment.body)) this.shatter(fragment.body);
  }

  private thaw(f: Fragment): void {
    if (!f.frozen) return;
    this.physics.world.getRigidBody(f.body).setBodyType(this.physics.rapier.RigidBodyType.Dynamic, true);
    f.frozen = false;
    f.asleepFor = 0;
  }

  // ----- buildings ------------------------------------------------------------------------

  private buildingState(building: number): BuildingState | null {
    const existing = this.buildings.get(building);
    if (existing) return existing;
    let structure: BuildingStructure;
    try {
      structure = new BuildingStructure(building, this.blueprint, this.tuning);
    } catch {
      return null;
    }
    if (structure.segments.length === 0) return null;
    const spec = this.blueprint.buildings[building];
    let body = -1;
    for (const [handle, owner] of this.physics.owners) {
      if (owner.kind === 'building' && owner.building === building && owner.alive) {
        body = this.physics.world.getCollider(handle).parent()!.handle;
        break;
      }
    }
    if (body < 0 || !spec) return null;
    const state: BuildingState = { structure, body, segmentColliders: new Map(), segmentItems: new Map(), cooldownUntil: 0 };
    this.buildings.set(building, state);
    return state;
  }

  private pieceColliders(building: number, piece: PieceRef): number[] {
    const handles: number[] = [];
    for (const [handle, owner] of this.physics.owners) {
      if (owner.kind === 'building' && owner.building === building && owner.alive && owner.piece?.kind === piece.kind && owner.piece.index === piece.index) handles.push(handle);
    }
    return handles;
  }

  private removeColliders(handles: readonly number[]): void {
    for (const handle of handles) {
      const owner = this.physics.ownerOf(handle);
      if (!owner?.alive) continue;
      this.physics.removeCollider(this.physics.world.getCollider(handle));
    }
  }

  /** Replace a segment's colliders and drawing with boxes for what still stands. */
  private rebuildSegment(state: BuildingState, segmentIndex: number): void {
    const { structure } = state;
    const segment = structure.segments[segmentIndex]!;
    const building = structure.building;
    const previous = state.segmentColliders.get(segmentIndex);
    if (previous) this.removeColliders(previous);
    else {
      this.removeColliders(this.pieceColliders(building, segment.piece));
      this.changes.hidden.push(segment.piece);
    }
    for (const id of state.segmentItems.get(segmentIndex) ?? []) this.changes.removed.push(id);

    const { rapier, world, groups } = this.physics;
    const body = world.getRigidBody(state.body);
    const colliders: number[] = [];
    const items: number[] = [];
    for (const region of standingRegions(structure, segmentIndex)) {
      const placement = regionPlacement(segment, region);
      const collider = world.createCollider(placementCollider(rapier, placement, { x: 0, y: 0, z: 0 }, 0, 1).setCollisionGroups(groups.city), body);
      this.physics.own(collider, { kind: 'building', building, id: segment.piece.index, piece: segment.piece });
      colliders.push(collider.handle);
      items.push(this.addItem({ kind: 'region', building, region, body: null, origin: { x: 0, y: 0, z: 0 } }));
    }
    state.segmentColliders.set(segmentIndex, colliders);
    state.segmentItems.set(segmentIndex, items);
  }

  // ----- failures -------------------------------------------------------------------------

  private fail(state: BuildingState, segmentIndex: number, storey: number, kind: SupportFailure, push: SupportPush | null, generation: number, touched: Set<number>, crushedPoints: WorldPoint[]): boolean {
    const { structure } = state;
    const motion = this.tuning.motion;
    if (kind === 'pancake') {
      // The storey gave way in compression: it's gone, and the top drops onto the one below.
      const survivors = structure.presentNodes(segmentIndex, storey).map((n) => n.id);
      for (const id of survivors) structure.crush(id);
      this.spawnDebris(state, survivors, null, crushedPoints);
    }
    const part = structure.partAbove(segmentIndex, storey);
    if (part.nodes.length === 0 && part.ornaments.length === 0) return false;
    structure.detach(part);
    for (const segment of part.segments) touched.add(segment);

    const regions = regionsOfNodes(structure, part.nodes);
    const ornaments = part.ornaments.map((i) => structure.ornaments[i]!.piece);
    const ornamentMass = part.ornaments.reduce((m, i) => m + structure.ornaments[i]!.mass, 0);
    for (const piece of ornaments) {
      this.removeColliders(this.pieceColliders(structure.building, piece));
      this.changes.hidden.push(piece);
    }
    const massReal = regions.reduce((m, r) => m + r.mass, 0) + ornamentMass;
    if (massReal <= 0) return false;

    // Start still, plus the hit's push (capped) and a nudge of spin toward the lean.
    const pushSpeed = push ? Math.min(motion.maxPushSpeed, push.impulse / massReal) : 0;
    const linvel = push ? { x: push.x * pushSpeed, y: 0, z: push.z * pushSpeed } : { x: 0, y: 0, z: 0 };
    const top = regions.reduce((h, r) => Math.max(h, structure.segments[r.segment]!.y0 + r.y1), 0);
    const base = structure.segments[segmentIndex]!.y0 + (storey + 1) * structure.segments[segmentIndex]!.layout.storeyHeight;
    const height = Math.max(1, top - base);
    // Spin about the horizontal axis that tips the top along the push (right-hand rule: up × lean).
    const spin = push && kind === 'topple' ? motion.toppleSpin + pushSpeed / height : 0;
    const angvel = push ? { x: push.z * spin, y: 0, z: -push.x * spin } : { x: 0, y: 0, z: 0 };

    const origin = this.centreOf(structure, regions);
    const fragment = this.createFragment({
      level: 0, building: structure.building, generation, origin, regions, ornaments, ornamentMass,
      pose: { position: origin, rotation: { x: 0, y: 0, z: 0, w: 1 } }, linvel, angvel,
    });
    if (fragment && kind === 'topple') fragment.hinge = { segment: segmentIndex, storey };
    if (fragment && kind !== 'topple') fragment.mode = 'pancake';
    const segment = structure.segments[segmentIndex]!;
    this.options.events.emit('destruction:failure', {
      building: structure.building, kind, height, mass: massReal, first: this.failures++ === 0,
      position: { x: segment.x, y: base, z: segment.z },
    });
    return true;
  }

  private centreOf(structure: BuildingStructure, regions: readonly Region[]): WorldPoint {
    let m = 0;
    const c = { x: 0, y: 0, z: 0 };
    for (const r of regions) {
      const p = regionPlacement(structure.segments[r.segment]!, r).centre;
      c.x += p.x * r.mass;
      c.y += p.y * r.mass;
      c.z += p.z * r.mass;
      m += r.mass;
    }
    return m > 0 ? { x: c.x / m, y: c.y / m, z: c.z / m } : { x: 0, y: 0, z: 0 };
  }

  // ----- fragment bodies ------------------------------------------------------------------

  private createFragment(spec: {
    level: FragmentLevel;
    building: number;
    generation: number;
    origin: WorldPoint;
    regions: Region[];
    ornaments: PieceRef[];
    ornamentMass: number;
    pose: BodyPose;
    linvel: WorldPoint;
    angvel: WorldPoint;
  }): Fragment | null {
    const structure = this.buildings.get(spec.building)?.structure;
    if (!structure) return null;
    const { rapier, world, groups } = this.physics;
    const motion = this.tuning.motion;
    const placements: { placement: Placement; mass: number }[] = [];
    for (const region of spec.regions) placements.push({ placement: regionPlacement(structure.segments[region.segment]!, region), mass: region.mass });
    const perOrnament = spec.ornaments.length > 0 ? spec.ornamentMass / spec.ornaments.length : 0;
    for (const piece of spec.ornaments) {
      const placement = ornamentPlacement(this.blueprint, piece);
      if (placement) placements.push({ placement, mass: Math.max(perOrnament, 1) });
    }
    const massReal = placements.reduce((m, p) => m + p.mass, 0);
    if (placements.length === 0 || massReal <= 0) return null;
    const massSim = solverMass(massReal, motion.solverMassReference);
    const scale = massSim / massReal;

    const desc = rapier.RigidBodyDesc.dynamic()
      .setTranslation(spec.pose.position.x, spec.pose.position.y, spec.pose.position.z)
      .setRotation(spec.pose.rotation)
      .setLinvel(spec.linvel.x, spec.linvel.y, spec.linvel.z)
      .setAngvel(spec.angvel)
      .setCcdEnabled(spec.level < 2)
      .setDominanceGroup(spec.level === 0 ? 1 : 0)
      .setCanSleep(true);
    const body = world.createRigidBody(desc);
    const kind = spec.level === 0 ? 'actor' : 'chunk';
    const colliderGroups = spec.level === 0 ? groups.actor : groups.chunk;
    // Sections report even resting contact (their weight on the stump edge matters); smaller
    // pieces only real knocks.
    const threshold = (spec.level === 0 ? 0.02 : 3) * 9.81 * massSim;
    for (const { placement, mass } of placements) {
      const collider = world.createCollider(
        placementCollider(rapier, placement, spec.origin, motion.spawnClearance, mass * scale)
          .setCollisionGroups(colliderGroups)
          .setFriction(motion.friction)
          .setRestitution(0.02)
          .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(threshold),
        body,
      );
      this.physics.own(collider, { kind, building: spec.building, id: body.handle });
    }

    const fragment: Fragment = {
      body: body.handle, level: spec.level, building: spec.building, generation: spec.generation,
      massReal, massSim, origin: spec.origin, regions: spec.regions, ornaments: spec.ornaments, items: [],
      debris: false, bornAt: this.time, asleepFor: 0, frozen: false,
      breakupEnergy: this.breakupEnergy(structure, spec.level, spec.regions),
      hinge: null, mode: 'topple', pancakeStoreys: 0, nextEdgeCrush: 0, held: false, projectileUntil: 0,
      preVelocity: { ...spec.linvel },
      previous: { position: { ...spec.pose.position }, rotation: { ...spec.pose.rotation } },
      current: { position: { ...spec.pose.position }, rotation: { ...spec.pose.rotation } },
    };
    for (const region of spec.regions) fragment.items.push(this.addItem({ kind: 'region', building: spec.building, region, body: body.handle, origin: spec.origin }));
    for (const piece of spec.ornaments) fragment.items.push(this.addItem({ kind: 'ornament', building: spec.building, piece, body: body.handle, origin: spec.origin }));
    this.fragments.set(body.handle, fragment);
    return fragment;
  }

  /** Energy that breaks a section into bands (level 0) or a band into chunks (level 1). */
  private breakupEnergy(structure: BuildingStructure, level: FragmentLevel, regions: readonly Region[]): number {
    if (level >= 2 || regions.length === 0) return Infinity;
    const main = regions.reduce((a, b) => (regionVolume(b) > regionVolume(a) ? b : a));
    const segment = structure.segments[main.segment]!;
    if (!Number.isFinite(segment.crushEnergy)) return Infinity;
    const { layout } = segment;
    const slice = level === 0
      ? (main.x1 - main.x0) * (main.z1 - main.z0) * layout.storeyHeight * this.tuning.motion.bandStoreys
      : (segment.w / layout.baysX) * (segment.d / layout.baysZ) * layout.storeyHeight;
    return this.tuning.motion.breakupFraction * slice * segment.crushEnergy;
  }

  private removeFragment(fragment: Fragment): void {
    const world = this.physics.world;
    const body = world.getRigidBody(fragment.body);
    for (let i = 0; i < body.numColliders(); i++) {
      const owner = this.physics.ownerOf(body.collider(i));
      if (owner) owner.alive = false;
    }
    world.removeRigidBody(body);
    for (const id of fragment.items) this.changes.removed.push(id);
    this.fragments.delete(fragment.body);
  }

  private chunkBudgetLeft(): number {
    const cap = this.tuning.motion.chunkBodies[this.options.profile];
    return cap - this.countBodies((f) => !f.debris && f.level > 0);
  }

  /** Split a section into bands (the ones near the contact into chunks), or a band into chunks. */
  private breakUp(fragment: Fragment, contact: WorldPoint): void {
    const structure = this.buildings.get(fragment.building)?.structure;
    if (!structure || fragment.level >= 2) return;
    let budget = this.chunkBudgetLeft();
    if (budget <= 1) return;
    const motion = this.tuning.motion;
    const world = this.physics.world;
    const body = world.getRigidBody(fragment.body);
    const pose: BodyPose = { position: { ...body.translation() }, rotation: { ...body.rotation() } };
    const v = { ...body.linvel() };
    const w = { ...body.angvel() };
    const com = { ...body.worldCom() };
    const worldOf = (p: WorldPoint): WorldPoint => {
      const local = rotate(pose.rotation, { x: p.x - fragment.origin.x, y: p.y - fragment.origin.y, z: p.z - fragment.origin.z });
      return { x: pose.position.x + local.x, y: pose.position.y + local.y, z: pose.position.z + local.z };
    };
    const velocityAt = (p: WorldPoint): WorldPoint => {
      const r = { x: p.x - com.x, y: p.y - com.y, z: p.z - com.z };
      return { x: v.x + w.y * r.z - w.z * r.y, y: v.y + w.z * r.x - w.x * r.z, z: v.z + w.x * r.y - w.y * r.x };
    };

    const pieces: { regions: Region[]; level: FragmentLevel }[] = [];
    for (const region of fragment.regions) {
      const bands = fragment.level === 0 ? splitIntoBands(structure, region, motion.bandStoreys) : [region];
      for (const band of bands) {
        const centre = worldOf(regionPlacement(structure.segments[band.segment]!, band).centre);
        const near = Math.hypot(centre.x - contact.x, centre.y - contact.y, centre.z - contact.z) <= motion.chunkRadius + (band.y1 - band.y0) / 2;
        const chunks = near || fragment.level === 1 ? splitIntoBays(structure, band) : [];
        if (chunks.length > 1 && chunks.length <= budget) {
          for (const chunk of chunks) pieces.push({ regions: [chunk], level: 2 });
          budget -= chunks.length;
        } else if (budget > 0 || pieces.length === 0) {
          pieces.push({ regions: [band], level: fragment.level === 0 ? 1 : 2 });
          budget -= 1;
        } else {
          // Over budget: what's left stays together with the last piece.
          pieces[pieces.length - 1]!.regions.push(band);
        }
      }
    }
    if (pieces.length <= 1 && fragment.ornaments.length === 0) return;
    const { building, generation, origin, ornaments } = fragment;
    this.removeFragment(fragment);
    for (const piece of pieces) {
      const centre = worldOf(regionPlacement(structure.segments[piece.regions[0]!.segment]!, piece.regions[0]!).centre);
      this.createFragment({
        level: piece.level, building, generation, origin, regions: piece.regions, ornaments: [], ornamentMass: 0,
        pose, linvel: velocityAt(centre), angvel: w,
      });
    }
    for (const ornament of ornaments) {
      const placement = ornamentPlacement(this.blueprint, ornament);
      const centre = placement ? worldOf(placement.centre) : pose.position;
      this.createFragment({ level: 2, building, generation, origin, regions: [], ornaments: [ornament], ornamentMass: 20000, pose, linvel: velocityAt(centre), angvel: w });
    }
  }

  // ----- debris ---------------------------------------------------------------------------

  private spawnDebris(state: BuildingState, nodeIds: readonly number[], event: DamageEvent | null, points: WorldPoint[]): void {
    const { structure } = state;
    const random = this.options.random();
    const dir = event?.shape.type === 'sweep' ? event.shape.direction : null;
    const speed = event?.speed ?? 0;
    for (const id of nodeIds) {
      const node = structure.nodes[id]!;
      if (node.state === NodeState.Intact) continue;
      const centre = structure.nodeCentre(node);
      points.push(centre);
      const side = Math.min(4, Math.max(1.5, Math.min(node.x1 - node.x0, node.y1 - node.y0, node.z1 - node.z0) * random.range(0.35, 0.6)));
      for (let k = 0; k < this.tuning.motion.debrisPerCrushed; k++) {
        const throwSpeed = dir ? speed * random.range(0.15, 0.4) : 0;
        this.spawnDebrisBody(state, node.segment, centre, side, { x: (dir?.x ?? 0) * throwSpeed, y: (dir?.y ?? 0) * throwSpeed, z: (dir?.z ?? 0) * throwSpeed }, null);
      }
    }
  }

  /** One debris block of about `side` m near `centre`, flying off with `velocity` plus some scatter. */
  private spawnDebrisBody(state: BuildingState, segmentIndex: number, centre: WorldPoint, side: number, velocity: WorldPoint, points: WorldPoint[] | null): void {
    const motion = this.tuning.motion;
    const random = this.options.random();
    const { rapier, world, groups } = this.physics;
    const building = state.structure.building;
    this.enforceDebrisBudget(1);
    const size = { x: side * random.range(0.8, 1.3), y: side * random.range(0.5, 0.9), z: side * random.range(0.8, 1.3) };
    const position = { x: centre.x + random.signed() * 2, y: centre.y + random.signed(), z: centre.z + random.signed() * 2 };
    points?.push(position);
    const linvel = { x: velocity.x + random.signed() * 5, y: velocity.y + random.range(0, 5), z: velocity.z + random.signed() * 5 };
    const massReal = size.x * size.y * size.z * 1600;
    const massSim = solverMass(massReal, motion.solverMassReference);
    const body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setLinvel(linvel.x, linvel.y, linvel.z)
        .setAngvel({ x: random.signed() * 3, y: random.signed() * 3, z: random.signed() * 3 })
        .setDominanceGroup(-1)
        .setCanSleep(true),
    );
    const collider = world.createCollider(
      rapier.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
        .setDensity(massSim / (size.x * size.y * size.z))
        .setCollisionGroups(groups.debris)
        .setFriction(motion.friction),
      body,
    );
    this.physics.own(collider, { kind: 'debris', building, id: body.handle });
    const rotation = { x: 0, y: 0, z: 0, w: 1 };
    const fragment: Fragment = {
      body: body.handle, level: 2, building, generation: 99, massReal, massSim,
      origin: position, regions: [], ornaments: [], items: [], debris: true, bornAt: this.time, asleepFor: 0, frozen: false,
      breakupEnergy: Infinity, hinge: null, mode: 'topple', pancakeStoreys: 0, nextEdgeCrush: 0, held: false, projectileUntil: 0, preVelocity: linvel,
      previous: { position: { ...position }, rotation: { ...rotation } }, current: { position: { ...position }, rotation: { ...rotation } },
    };
    fragment.items.push(this.addItem({ kind: 'debris', building, segment: segmentIndex, body: body.handle, size }));
    this.fragments.set(body.handle, fragment);
  }

  private enforceDebrisBudget(incoming: number): void {
    const cap = this.tuning.motion.debrisBodies[this.options.profile];
    const debris = [...this.fragments.values()].filter((f) => f.debris);
    const excess = debris.length + incoming - cap;
    if (excess <= 0) return;
    debris.sort((a, b) => a.bornAt - b.bornAt);
    for (let i = 0; i < excess && i < debris.length; i++) this.removeFragment(debris[i]!);
  }

  // ----- contacts -------------------------------------------------------------------------

  private handleContacts(): void {
    const { world, events } = this.physics;
    // Per fragment this step: its strongest contact, and its strongest contact with its own stump
    // plus the total force on that stump (a section's weight spreads over many collider pairs).
    type Pair = { force: number; mine: number; other: number };
    const contacts = new Map<number, { strongest: Pair | null; own: Pair | null; ownPairs: Pair[] }>();
    events.drainContactForceEvents((event) => {
      const c1 = event.collider1();
      const c2 = event.collider2();
      const force = event.totalForceMagnitude();
      for (const [mine, other] of [[c1, c2], [c2, c1]] as const) {
        const owner = this.physics.ownerOf(mine);
        if (!owner || (owner.kind !== 'actor' && owner.kind !== 'chunk')) continue;
        const otherOwner = this.physics.ownerOf(other);
        const own = otherOwner?.kind === 'building' && otherOwner.building === owner.building;
        const pair = { force, mine, other };
        let entry = contacts.get(owner.id);
        if (!entry) contacts.set(owner.id, (entry = { strongest: null, own: null, ownPairs: [] }));
        if (own) {
          entry.ownPairs.push(pair);
          if (!entry.own || force > entry.own.force) entry.own = pair;
        } else if (!entry.strongest || force > entry.strongest.force) entry.strongest = pair;
      }
    });
    for (const [bodyHandle, contact] of contacts) {
      const fragment = this.fragments.get(bodyHandle);
      if (!fragment || fragment.frozen) continue;
      const body = world.getRigidBody(bodyHandle);
      const v = body.linvel();
      const pre = fragment.preVelocity;
      const dv = Math.hypot(v.x - pre.x, v.y - pre.y, v.z - pre.z);
      const energy = 0.5 * fragment.massReal * dv * dv;
      if (contact.own && fragment.level === 0) {
        // On its own stump a section pancakes or rolls over the edge.
        const com = body.worldCom();
        const point = this.contactPoint(contact.own.mine, contact.own.other) ?? { x: com.x, y: fragment.current.position.y - 2, z: com.z };
        if (energy >= this.tuning.motion.impactEnergy) this.options.events.emit('destruction:impact', { position: point, energy, mass: fragment.massReal, ground: false });
        if (fragment.mode === 'pancake') this.pancake(fragment, body);
        else {
          const supports = contact.ownPairs.flatMap((pair) => this.contactPoints(pair.mine, pair.other));
          this.crushUnder(fragment, point, energy);
          this.crushLeadingEdge(fragment, body, supports);
        }
      }
      // Break-ups, knock-ons and impact sounds come from what else it hit (never its own stump).
      if (!contact.strongest) continue;
      const other = this.physics.ownerOf(contact.strongest.other);
      if (!this.fragments.has(bodyHandle)) continue;
      const point = this.contactPoint(contact.strongest.mine, contact.strongest.other) ?? { ...body.translation() };
      if (energy >= this.tuning.motion.impactEnergy) {
        this.options.events.emit('destruction:impact', { position: point, energy, mass: fragment.massReal, ground: other?.kind === 'ground' });
      }
      if (fragment.held) continue;
      if (fragment.projectileUntil > this.time && other?.kind === 'building') {
        this.projectileHit(fragment, other.building, point);
        continue;
      }
      if (other?.kind === 'building' && energy >= this.tuning.motion.impactEnergy) this.knockOn(fragment, other.building, point, energy);
      if (energy >= fragment.breakupEnergy && this.fragments.has(bodyHandle)) this.breakUp(fragment, point);
    }
  }

  private contactPoints(c1: number, c2: number): WorldPoint[] {
    const world = this.physics.world;
    const points: WorldPoint[] = [];
    const a = world.getCollider(c1);
    const b = world.getCollider(c2);
    if (!a || !b) return points;
    world.contactPair(a, b, (manifold) => {
      for (let i = 0; i < manifold.numSolverContacts(); i++) {
        const p = manifold.solverContactPoint(i);
        if (p) points.push({ x: p.x, y: p.y, z: p.z });
      }
    });
    return points;
  }

  /** Mean of the solver contact points between two colliders, or null if none. */
  private contactPoint(c1: number, c2: number): WorldPoint | null {
    const world = this.physics.world;
    const sum = { x: 0, y: 0, z: 0 };
    let count = 0;
    const a = world.getCollider(c1);
    const b = world.getCollider(c2);
    if (!a || !b) return null;
    world.contactPair(a, b, (manifold) => {
      for (let i = 0; i < manifold.numSolverContacts(); i++) {
        const p = manifold.solverContactPoint(i);
        if (!p) continue;
        sum.x += p.x;
        sum.y += p.y;
        sum.z += p.z;
        count++;
      }
    });
    return count > 0 ? { x: sum.x / count, y: sum.y / count, z: sum.z / count } : null;
  }

  /**
   * A section dropping onto its own stump crushes the storey under it when it carries enough
   * energy, and keeps falling (v·M/(M + accretion·m)). Returns true if a storey went.
   */
  private pancake(fragment: Fragment, body: RAPIER.RigidBody): boolean {
    const state = this.buildings.get(fragment.building);
    const motion = this.tuning.motion;
    if (!state || fragment.pancakeStoreys >= motion.pancakeMaxStoreys[this.options.profile]) return false;
    const pre = fragment.preVelocity;
    if (pre.y > -3) return false;
    const { structure } = state;
    const bottom = fragment.current.position.y - 1;
    // The highest standing storey under the section, in the segment it came from or those below.
    let target: { segment: number; storey: number } | null = null;
    let segmentIndex = fragment.regions[0]?.segment ?? -1;
    while (segmentIndex >= 0 && !target) {
      const segment = structure.segments[segmentIndex]!;
      for (let s = segment.layout.storeys - 1; s >= 0; s--) {
        if (segment.y0 + s * segment.layout.storeyHeight > bottom + segment.layout.storeyHeight * 0.5 + 40) continue;
        if (structure.presentNodes(segmentIndex, s).length > 0) {
          target = { segment: segmentIndex, storey: s };
          break;
        }
      }
      segmentIndex = segment.below;
    }
    if (!target || structure.segments[target.segment]!.sturdy) return false;
    const nodes = structure.presentNodes(target.segment, target.storey);
    const health = nodes.reduce((h, n) => h + n.health, 0);
    const energy = 0.5 * fragment.massReal * (pre.x * pre.x + pre.y * pre.y + pre.z * pre.z);
    if (energy < health) return false;
    const crushed = nodes.map((n) => n.id);
    for (const id of crushed) structure.crush(id);
    const points: WorldPoint[] = [];
    this.spawnDebris(state, crushed, null, points);
    this.rebuildSegment(state, target.segment);
    const storeyMass = nodes.reduce((m, n) => m + n.mass, 0);
    const keep = fragment.massReal / (fragment.massReal + motion.pancakeAccretion * storeyMass);
    body.setLinvel({ x: pre.x * keep, y: pre.y * keep, z: pre.z * keep }, true);
    fragment.preVelocity = { x: pre.x * keep, y: pre.y * keep, z: pre.z * keep };
    fragment.pancakeStoreys++;
    this.options.events.emit('destruction:damage', {
      building: fragment.building, outcome: 'crush', crushed: points, point: points[0] ?? fragment.current.position,
      generation: fragment.generation, style: structure.segments[target.segment]!.style, direction: null,
    });
    return true;
  }

  /** A section landing hard on its stump crushes the chunks under the contact if it carries more than they can absorb. */
  private crushUnder(fragment: Fragment, point: WorldPoint, energy: number): void {
    const state = this.buildings.get(fragment.building);
    if (!state || energy < this.tuning.motion.impactEnergy) return;
    const { structure } = state;
    const patch: number[] = [];
    let health = 0;
    for (const segment of structure.segments) {
      if (segment.sturdy) continue;
      const h = segment.layout.storeyHeight;
      const local = structure.worldToLocal(segment.index, point);
      const storey = Math.min(segment.layout.storeys - 1, Math.floor((local.y + 0.5) / h));
      for (let s = storey; s >= Math.max(0, storey - 1); s--) {
        const near = structure.expandStorey(segment.index, s).map((id) => structure.nodes[id]!).filter((n) => {
          if (n.state !== NodeState.Intact) return false;
          const dx = Math.max(n.x0 - local.x, 0, local.x - n.x1);
          const dz = Math.max(n.z0 - local.z, 0, local.z - n.z1);
          return Math.hypot(dx, dz) <= h * 1.5;
        });
        if (near.length === 0) continue;
        for (const n of near) {
          patch.push(n.id);
          health += n.health;
        }
        break;
      }
    }
    if (patch.length === 0 || energy < health) return;
    this.crushStump(state, fragment, patch, point);
  }

  /**
   * A leaning section bears on its stump through its contact points. Taking them as the support,
   * edge stress is (W/A)(1 + 6e/b) for a centre-of-mass offset e over a support depth b: once that
   * passes the storey's reserve (or the centre of mass is past the supports, so the whole weight
   * sits on the edge) the chunks under the leading contacts crush. The lean grows and the next
   * ones go — the section rolls forward off its stump instead of balancing on it.
   */
  private crushLeadingEdge(fragment: Fragment, body: RAPIER.RigidBody, supports: readonly WorldPoint[]): void {
    const state = this.buildings.get(fragment.building);
    if (!state) return;
    const { structure } = state;
    // The hinge is gone once nothing is left of its storey (the landing rule may have crushed it).
    if (fragment.hinge && structure.presentNodes(fragment.hinge.segment, fragment.hinge.storey).length === 0) fragment.hinge = null;
    if (fragment.hinge || supports.length === 0 || this.time < fragment.nextEdgeCrush) return;
    const com = body.worldCom();
    const mean = { x: 0, z: 0 };
    for (const p of supports) {
      mean.x += p.x / supports.length;
      mean.z += p.z / supports.length;
    }
    const ex = com.x - mean.x;
    const ez = com.z - mean.z;
    const e = Math.hypot(ex, ez);
    if (e < 0.25) return;
    const lean = { x: ex / e, z: ez / e };
    const along = supports.map((p) => (p.x - mean.x) * lean.x + (p.z - mean.z) * lean.z);
    const hi = Math.max(...along);
    const depth = Math.max(hi - Math.min(...along), 1);
    const reserve = Math.min(...structure.segments.map((seg) => seg.reserve)) * this.tuning.motion.edgeReserveShare;
    if (e < hi && 1 + (6 * e) / depth <= reserve) return;
    const leading = supports.filter((_, i) => along[i]! >= hi - 1);
    const ids = new Set<number>();
    for (const p of leading) {
      for (const segment of structure.segments) {
        if (segment.sturdy) continue;
        const local = structure.worldToLocal(segment.index, p);
        const h = segment.layout.storeyHeight;
        const storey = Math.floor((local.y - 0.5) / h);
        if (storey < 0 || storey >= segment.layout.storeys) continue;
        for (const id of structure.expandStorey(segment.index, storey)) {
          const n = structure.nodes[id]!;
          if (n.state !== NodeState.Intact) continue;
          const dx = Math.max(n.x0 - local.x, 0, local.x - n.x1);
          const dz = Math.max(n.z0 - local.z, 0, local.z - n.z1);
          if (Math.hypot(dx, dz) <= 1.5) ids.add(id);
        }
      }
    }
    if (ids.size === 0) return;
    fragment.nextEdgeCrush = this.time + this.tuning.motion.edgeCrushInterval;
    this.crushStump(state, fragment, [...ids], leading[0]!);
  }

  private crushStump(state: BuildingState, fragment: Fragment, ids: number[], point: WorldPoint): void {
    if (fragment.pancakeStoreys >= this.tuning.motion.pancakeMaxStoreys[this.options.profile] * 4) return;
    const { structure } = state;
    for (const id of ids) structure.crush(id);
    fragment.pancakeStoreys++;
    const points: WorldPoint[] = [];
    this.spawnDebris(state, ids, null, points);
    for (const segmentIndex of new Set(ids.map((id) => structure.nodes[id]!.segment))) this.rebuildSegment(state, segmentIndex);
    this.options.events.emit('destruction:damage', {
      building: fragment.building, outcome: 'crush', crushed: points, point, generation: fragment.generation,
      style: structure.segments[structure.nodes[ids[0]!]!.segment]!.style, direction: null,
    });
  }

  /** A falling piece hit another building: it takes a share of the impact (dominoes). */
  private knockOn(fragment: Fragment, building: number, point: WorldPoint, energy: number): void {
    const motion = this.tuning.motion;
    if (fragment.generation >= motion.maxGeneration) return;
    const state = this.buildingState(building);
    if (!state || this.time < state.cooldownUntil) return;
    state.cooldownUntil = this.time + motion.buildingCooldown;
    const v = fragment.preVelocity;
    const speed = Math.hypot(v.x, v.y, v.z);
    if (speed < 1) return;
    const dir = { x: v.x / speed, y: v.y / speed, z: v.z / speed };
    this.damageBuilding(building, {
      kind: 'blunt',
      shape: { type: 'sweep', from: { x: point.x - dir.x * 3, y: point.y - dir.y * 3, z: point.z - dir.z * 3 }, direction: dir, radius: 3 },
      energy: energy * motion.generationDecay,
      speed,
      impulse: fragment.massReal * speed * motion.generationDecay,
      generation: fragment.generation + 1,
    }, point);
  }

  // ----- hinges and the governor ----------------------------------------------------------

  /** Past hingeTilt, the storey a section pivots on is crushed so it falls free. */
  private checkHinges(): void {
    const limit = Math.cos(this.tuning.motion.hingeTilt);
    for (const fragment of this.fragments.values()) {
      if (!fragment.hinge) continue;
      const up = rotate(fragment.current.rotation, UP);
      if (up.y > limit) continue;
      const state = this.buildings.get(fragment.building);
      const { segment, storey } = fragment.hinge;
      fragment.hinge = null;
      if (!state) continue;
      const survivors = state.structure.presentNodes(segment, storey).map((n) => n.id);
      if (survivors.length === 0) continue;
      for (const id of survivors) state.structure.crush(id);
      const points: WorldPoint[] = [];
      this.spawnDebris(state, survivors, null, points);
      this.rebuildSegment(state, segment);
    }
  }

  private govern(dt: number): void {
    const motion = this.tuning.motion;
    const life = motion.debrisLife[this.options.profile];
    const world = this.physics.world;
    for (const fragment of [...this.fragments.values()]) {
      if (fragment.held) continue;
      if (fragment.current.position.y < -5 || (fragment.debris && this.time - fragment.bornAt > life)) {
        this.removeFragment(fragment);
        continue;
      }
      if (fragment.frozen) continue;
      const body = world.getRigidBody(fragment.body);
      if (!body.isSleeping()) {
        fragment.asleepFor = 0;
        continue;
      }
      fragment.asleepFor += dt;
      if (fragment.asleepFor >= motion.freezeAfter) {
        body.setBodyType(this.physics.rapier.RigidBodyType.Fixed, false);
        fragment.frozen = true;
        fragment.hinge = null;
      }
    }
  }

  private addItem(item: NewItem): number {
    const id = this.nextItem++;
    this.changes.added.push({ ...item, id } as DestructionItem);
    return id;
  }

  /** Crush energy per m³ of a building's style, for callers that size damage (powers). */
  crushEnergyOf(building: number): number {
    const piece = this.blueprint.buildings[building]?.pieces[0];
    const data = piece?.kind === 'box' ? this.blueprint.boxes[piece.index] : piece?.kind === 'round' ? this.blueprint.rounds[piece.index] : null;
    return data ? perStyle(this.tuning.crushEnergy, data.style) : this.tuning.crushEnergy.stone;
  }
}
