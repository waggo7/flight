import { Color, ConeGeometry, DynamicDrawUsage, Group, InstancedMesh, Matrix4, MeshBasicMaterial, SphereGeometry, Vector3, type Material } from 'three';
import type { BoxPiece, CityBlueprint, PieceRef, RoundPiece } from '../../../core/city-blueprint';
import { boxStoreyLayout, roundStoreyLayout } from '../../../core/storey-layout';
import { createSpireMaterial, INTACT_EXTERIOR_MASK } from './facade-material';
import { FacadeInstances, type FacadeInstance } from './facade-instances';

// The intact city: every blueprint piece as an instance (boxes and round towers share the
// building-space facade; spires and aviation beacons are simple instanced meshes). Keeps a
// pristine copy of every matrix so Restart can put the skyline back after destruction.

const HIDDEN_MATRIX = new Matrix4().makeScale(0, 0, 0);

export function boxFacadeInstance(piece: BoxPiece): FacadeInstance {
  const layout = boxStoreyLayout(piece);
  return {
    x: piece.x, y: piece.y0, z: piece.z, yaw: piece.yaw,
    width: piece.w, height: piece.h, depth: piece.d,
    style: piece.style, seed: piece.seed, glass: piece.glass, lit: piece.lit, color: piece.color,
    storeyHeight: layout.storeyHeight, columnsX: layout.columnsX, columnsZ: layout.columnsZ,
    tierWidth: piece.w, tierHeight: piece.h, tierDepth: piece.d, tierBaseY: piece.y0,
    offsetX: 0, offsetY: 0, offsetZ: 0, exteriorMask: INTACT_EXTERIOR_MASK,
  };
}

export function roundFacadeInstance(piece: RoundPiece): FacadeInstance {
  const layout = roundStoreyLayout(piece);
  const diameter = piece.radius * 2;
  return {
    x: piece.x, y: piece.y0, z: piece.z, yaw: 0,
    width: diameter, height: piece.h, depth: diameter,
    style: piece.style, seed: piece.seed, glass: piece.glass, lit: piece.lit, color: piece.color,
    storeyHeight: layout.storeyHeight, columnsX: layout.columnsX, columnsZ: layout.columnsZ,
    tierWidth: diameter, tierHeight: piece.h, tierDepth: diameter, tierBaseY: piece.y0,
    offsetX: 0, offsetY: 0, offsetZ: 0, exteriorMask: INTACT_EXTERIOR_MASK,
  };
}

export class CityMeshes {
  readonly group = new Group();
  readonly boxes: FacadeInstances;
  readonly rounds: FacadeInstances;
  readonly spires: InstancedMesh;
  readonly beacons: InstancedMesh;
  /** Pools for pieces of damaged buildings: standing remains, falling sections, chunks, debris. */
  readonly boxChunks: FacadeInstances;
  readonly roundChunks: FacadeInstances;
  private readonly beaconMaterial = new MeshBasicMaterial({ color: new Color(8, 0.4, 0.25) });
  private readonly pristine: Map<InstancedMesh, Float32Array>;

  constructor(
    readonly blueprint: CityBlueprint,
    { chunkCapacity = 12000 }: { chunkCapacity?: number } = {},
  ) {
    this.group.name = 'city';
    this.boxes = new FacadeInstances('box', blueprint.boxes.length);
    blueprint.boxes.forEach((piece, i) => this.boxes.set(i, boxFacadeInstance(piece)));
    this.rounds = new FacadeInstances('round', blueprint.rounds.length);
    blueprint.rounds.forEach((piece, i) => this.rounds.set(i, roundFacadeInstance(piece)));

    const matrix = new Matrix4();
    const spireGeometry = new ConeGeometry(1, 1, 10, 1);
    spireGeometry.translate(0, 0.5, 0);
    this.spires = new InstancedMesh(spireGeometry, createSpireMaterial(), blueprint.spires.length);
    blueprint.spires.forEach((spire, i) => {
      matrix.makeScale(spire.radius, spire.height, spire.radius).setPosition(spire.x, spire.y, spire.z);
      this.spires.setMatrixAt(i, matrix);
    });
    this.spires.castShadow = true;

    // Aviation beacons: tiny, bright, blinking in unison.
    this.beacons = new InstancedMesh(new SphereGeometry(1.1, 8, 6), this.beaconMaterial, blueprint.beacons.length);
    blueprint.beacons.forEach((beacon, i) => this.beacons.setMatrixAt(i, matrix.makeTranslation(new Vector3(beacon.x, beacon.y, beacon.z))));

    const meshes = [this.boxes.mesh, this.rounds.mesh, this.spires, this.beacons];
    for (const mesh of meshes) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }
    this.pristine = new Map(meshes.map((mesh) => [mesh, mesh.instanceMatrix.array.slice() as Float32Array]));

    // Same materials as the intact pieces, so chunks share their shader programs.
    this.boxChunks = this.createPool('box', chunkCapacity, this.boxes.mesh.material as Material);
    this.roundChunks = this.createPool('round', Math.ceil(chunkCapacity / 8), this.rounds.mesh.material as Material);
  }

  private createPool(shape: 'box' | 'round', capacity: number, material: Material): FacadeInstances {
    const pool = new FacadeInstances(shape, capacity, material);
    pool.mesh.frustumCulled = false; // members move anywhere; a bounding sphere would go stale
    pool.mesh.count = 0;
    pool.mesh.name = `city-${shape}-chunks`;
    this.group.add(pool.mesh);
    return pool;
  }

  /**
   * Swap an intact box piece for chunks (from splitBoxIntoChunks) that draw exactly like it.
   * Returns the chunk instance ids, or null when the pool is full (the piece stays intact).
   */
  replaceWithChunks(boxIndex: number, chunks: readonly FacadeInstance[]): number[] | null {
    const ids: number[] = [];
    for (const chunk of chunks) {
      const id = this.boxChunks.alloc(chunk);
      if (id === null) {
        for (const taken of ids) this.boxChunks.release(taken);
        return null;
      }
      ids.push(id);
    }
    this.boxes.hide(boxIndex);
    return ids;
  }

  /** The instanced mesh and slot that draw an intact piece. */
  pieceSlot(piece: PieceRef): { mesh: InstancedMesh; index: number } {
    const mesh = piece.kind === 'box' ? this.boxes.mesh : piece.kind === 'round' ? this.rounds.mesh : piece.kind === 'spire' ? this.spires : this.beacons;
    return { mesh, index: piece.index };
  }

  /** The piece's matrix as generated. */
  pristineMatrix(piece: PieceRef, out: Matrix4): Matrix4 {
    const { mesh, index } = this.pieceSlot(piece);
    return out.fromArray(this.pristine.get(mesh)!, index * 16);
  }

  setPieceMatrix(piece: PieceRef, matrix: Matrix4): void {
    const { mesh, index } = this.pieceSlot(piece);
    mesh.setMatrixAt(index, matrix);
    mesh.instanceMatrix.needsUpdate = true;
  }

  hidePiece(piece: PieceRef): void {
    this.setPieceMatrix(piece, HIDDEN_MATRIX);
  }

  /** Beacons blink together. */
  update(time: number): void {
    const blink = Math.pow(0.5 + 0.5 * Math.sin(time * 2.4), 6);
    this.beaconMaterial.color.setRGB(0.6 + 9 * blink, 0.03 + 0.5 * blink, 0.02 + 0.3 * blink);
  }

  /** Restart: put every intact piece back exactly as generated. */
  restore(): void {
    for (const [mesh, matrices] of this.pristine) {
      mesh.instanceMatrix.array.set(matrices);
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.boxChunks.releaseAll();
    this.roundChunks.releaseAll();
  }
}
