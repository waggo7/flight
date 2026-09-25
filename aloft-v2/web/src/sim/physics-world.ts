import RAPIER from '@dimforge/rapier3d-compat';
import type { PieceRef } from '../core/city-blueprint';
import { collisionGroups, type CollisionGroups } from './collision-groups';

// The one place that imports Rapier. Owns the world, the event queue, and the owner table that
// maps every collider back to what it belongs to (a building, a falling section, a chunk, debris).
// Restart restores a snapshot of the pristine world; handles survive, so owners stay valid.

export type Rapier = typeof RAPIER;

let rapierReady: Promise<Rapier> | null = null;
/** Decode and compile Rapier's wasm once (start it early; phones take ~0.5–1.5 s). */
export function loadRapier(): Promise<Rapier> {
  rapierReady ??= RAPIER.init().then(() => RAPIER);
  return rapierReady;
}

export type OwnerKind = 'ground' | 'building' | 'actor' | 'chunk' | 'debris' | 'held';

export interface ColliderOwner {
  kind: OwnerKind;
  /** Building id for city pieces and anything broken off them; -1 for the ground. */
  building: number;
  /** Id within its kind (piece index, actor id, chunk id…). */
  id: number;
  /** The blueprint piece a building collider stands for (to find it again when the building breaks). */
  piece?: PieceRef;
  /** False once removed; queries skip dead owners (Rapier's query tree refreshes only on step). */
  alive: boolean;
}

export interface PhysicsOptions {
  gravity: number;
  stepsPerSecond: number;
  solverIterations: number;
  debrisHitsDebris: boolean;
}

export class PhysicsWorld {
  world: RAPIER.World;
  readonly events: RAPIER.EventQueue;
  readonly groups: CollisionGroups;
  owners = new Map<number, ColliderOwner>();
  private pristine: { snapshot: Uint8Array; owners: Map<number, ColliderOwner> } | null = null;

  constructor(
    readonly rapier: Rapier,
    readonly options: PhysicsOptions,
  ) {
    this.world = this.createWorld();
    this.events = new rapier.EventQueue(true);
    this.groups = collisionGroups({ debrisHitsDebris: options.debrisHitsDebris });
  }

  private createWorld(): RAPIER.World {
    const world = new this.rapier.World({ x: 0, y: -this.options.gravity, z: 0 });
    this.applySettings(world);
    return world;
  }

  private applySettings(world: RAPIER.World): void {
    world.timestep = 1 / this.options.stepsPerSecond;
    world.numSolverIterations = this.options.solverIterations;
  }

  step(): void {
    this.world.step(this.events);
  }

  own(collider: RAPIER.Collider, owner: Omit<ColliderOwner, 'alive'>): RAPIER.Collider {
    this.owners.set(collider.handle, { ...owner, alive: true });
    return collider;
  }

  ownerOf(collider: RAPIER.Collider | number): ColliderOwner | undefined {
    return this.owners.get(typeof collider === 'number' ? collider : collider.handle);
  }

  isAlive(collider: RAPIER.Collider): boolean {
    return this.owners.get(collider.handle)?.alive ?? false;
  }

  removeCollider(collider: RAPIER.Collider): void {
    const owner = this.owners.get(collider.handle);
    if (owner) owner.alive = false;
    this.world.removeCollider(collider, true);
  }

  /** Remember the pristine world (call once the static city is built). */
  capturePristine(): void {
    this.pristine = {
      snapshot: this.world.takeSnapshot(),
      owners: new Map([...this.owners].map(([handle, owner]) => [handle, { ...owner }])),
    };
  }

  /** Restart: back to the pristine world. Handles are unchanged, so the owner table still applies. */
  restorePristine(): void {
    if (!this.pristine) throw new Error('capturePristine() was never called');
    this.world.free();
    this.world = this.rapier.World.restoreSnapshot(this.pristine.snapshot);
    this.applySettings(this.world);
    this.owners = new Map([...this.pristine.owners].map(([handle, owner]) => [handle, { ...owner }]));
    this.events.clear();
  }
}
