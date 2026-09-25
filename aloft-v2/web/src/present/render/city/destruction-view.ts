import { Matrix4, Quaternion, Vector3 } from 'three';
import type { BuildingStructure, Segment } from '../../../core/building-structure';
import type { CityBlueprint, PieceRef } from '../../../core/city-blueprint';
import type { Region } from '../../../core/structure-regions';
import type { BodyPose, DestructionItem, DestructionSystem } from '../../../sim/destruction-system';
import { segmentToWorld } from '../../../sim/destruction-bodies';
import { boxFacadeInstance, roundFacadeInstance, type CityMeshes } from './city-meshes';
import type { FacadeInstance, FacadeInstances } from './facade-instances';

// Draws the destruction: what still stands of damaged buildings, falling sections, bands, chunks
// and debris, all with the city's own facade pools (building-space windows, so nothing pops when
// a piece swaps from intact to loose). Loose pieces follow their Rapier body, interpolated.

interface Drawn {
  item: DestructionItem;
  pool: FacadeInstances | null;
  slot: number;
  /** Instance matrix relative to the body (null for static regions). */
  local: Matrix4 | null;
}

const UP = new Vector3(0, 1, 0);
/** Metres: debris closer than this to the camera is not drawn. */
const NEAR_CUTAWAY = 5;
const matrix = new Matrix4();
const bodyMatrix = new Matrix4();
const position = new Vector3();
const rotation = new Quaternion();
const scale = new Vector3();

/** The facade instance that draws `region` of `segment` in place, as generated. */
export function regionFacadeInstance(blueprint: CityBlueprint, segment: Segment, region: Region): FacadeInstance {
  const whole = segment.piece.kind === 'box' ? boxFacadeInstance(blueprint.boxes[segment.piece.index]!) : roundFacadeInstance(blueprint.rounds[segment.piece.index]!);
  const base = segmentToWorld(segment, (region.x0 + region.x1) / 2, region.y0, (region.z0 + region.z1) / 2);
  return {
    ...whole,
    x: base.x, y: base.y, z: base.z,
    width: region.x1 - region.x0, height: region.y1 - region.y0, depth: region.z1 - region.z0,
    offsetX: region.x0, offsetY: region.y0, offsetZ: region.z0,
    exteriorMask: region.exteriorMask,
  };
}

/** Instance matrix for a facade instance (base centre, yaw, size), as FacadeInstances.set builds it. */
function instanceMatrix(item: FacadeInstance, out: Matrix4): Matrix4 {
  return out.compose(position.set(item.x, item.y, item.z), rotation.setFromAxisAngle(UP, item.yaw), scale.set(item.width, item.height, item.depth));
}

export class DestructionView {
  private readonly drawn = new Map<number, Drawn>();
  private readonly pose: BodyPose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };

  constructor(
    private readonly system: DestructionSystem,
    private readonly meshes: CityMeshes,
    private readonly blueprint: CityBlueprint,
  ) {}

  /** Apply the system's changes and move loose pieces to their interpolated poses. */
  sync(alpha: number, camera: { x: number; y: number; z: number }): void {
    const changes = this.system.takeChanges();
    if (changes.reset) this.drawn.clear(); // the meshes already released their pools on Restart
    for (const piece of changes.hidden) this.meshes.hidePiece(piece);
    for (const id of changes.removed) this.remove(id);
    for (const item of changes.added) this.add(item);
    for (const drawn of this.drawn.values()) {
      if (!drawn.local || !('body' in drawn.item) || drawn.item.body === null) continue;
      if (!this.system.pose(drawn.item.body, alpha, this.pose)) continue;
      const p = this.pose;
      bodyMatrix.compose(position.set(p.position.x, p.position.y, p.position.z), rotation.set(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w), scale.set(1, 1, 1));
      matrix.multiplyMatrices(bodyMatrix, drawn.local);
      // Loose pieces right at the lens are cut away, so a hit never fills the screen.
      if (drawn.item.kind === 'debris' && Math.hypot(p.position.x - camera.x, p.position.y - camera.y, p.position.z - camera.z) < NEAR_CUTAWAY) matrix.makeScale(0, 0, 0);
      if (drawn.item.kind === 'ornament') this.meshes.setPieceMatrix(drawn.item.piece, matrix);
      else drawn.pool?.setMatrix(drawn.slot, matrix);
    }
  }

  private structure(building: number): BuildingStructure | null {
    return this.system.structureOf(building);
  }

  private add(item: DestructionItem): void {
    const structure = this.structure(item.building);
    if (!structure) return;
    if (item.kind === 'ornament') {
      const local = this.meshes.pristineMatrix(item.piece, new Matrix4()).premultiply(new Matrix4().makeTranslation(-item.origin.x, -item.origin.y, -item.origin.z));
      this.drawn.set(item.id, { item, pool: null, slot: -1, local });
      return;
    }
    if (item.kind === 'debris') {
      const segment = structure.segments[item.segment]!;
      const instance = this.debrisInstance(segment, item.size);
      const slot = this.meshes.boxChunks.alloc(instance);
      if (slot === null) return;
      // Unit geometry has y in [0, 1]: centre it on the body.
      const local = new Matrix4().makeScale(item.size.x, item.size.y, item.size.z).premultiply(new Matrix4().makeTranslation(0, -item.size.y / 2, 0));
      this.drawn.set(item.id, { item, pool: this.meshes.boxChunks, slot, local });
      return;
    }
    const segment = structure.segments[item.region.segment]!;
    const instance = regionFacadeInstance(this.blueprint, segment, item.region);
    const pool = segment.shape === 'round' ? this.meshes.roundChunks : this.meshes.boxChunks;
    const slot = pool.alloc(instance);
    if (slot === null) return;
    const local = item.body === null ? null : instanceMatrix(instance, new Matrix4()).premultiply(new Matrix4().makeTranslation(-item.origin.x, -item.origin.y, -item.origin.z));
    this.drawn.set(item.id, { item, pool, slot, local });
  }

  private remove(id: number): void {
    const drawn = this.drawn.get(id);
    if (!drawn) return;
    if (drawn.item.kind === 'ornament') this.meshes.hidePiece(drawn.item.piece as PieceRef);
    else drawn.pool?.release(drawn.slot);
    this.drawn.delete(id);
  }

  /** Debris draws as broken concrete all round (no exterior faces), tinted like its building. */
  private debrisInstance(segment: Segment, size: { x: number; y: number; z: number }): FacadeInstance {
    const whole = segment.piece.kind === 'box' ? boxFacadeInstance(this.blueprint.boxes[segment.piece.index]!) : roundFacadeInstance(this.blueprint.rounds[segment.piece.index]!);
    return {
      ...whole,
      x: 0, y: -1e5, z: 0, yaw: 0,
      width: size.x, height: size.y, depth: size.z,
      tierWidth: size.x, tierHeight: size.y, tierDepth: size.z, tierBaseY: 0,
      offsetX: 0, offsetY: 0, offsetZ: 0, exteriorMask: 0,
    };
  }
}
