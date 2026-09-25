import {
  BoxGeometry, Color, CylinderGeometry, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import { createFacadeMaterial, type FacadeShape } from './facade-material';

// A pool of facade instances (boxes or round drums) sharing one draw call. Used for the intact
// city now, and for falling bands and chunks in M3; everything carries the building-space data
// the facade shader needs, so pieces look the same whichever pool draws them.

export interface FacadeInstance {
  /** Base centre (y is the bottom). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** This instance's size. Round drums: width = depth = diameter. */
  width: number;
  height: number;
  depth: number;
  style: number;
  seed: number;
  glass: number;
  lit: number;
  color: string | Color;
  storeyHeight: number;
  columnsX: number;
  columnsZ: number;
  /** The whole piece (tier) this instance is part of. */
  tierWidth: number;
  tierHeight: number;
  tierDepth: number;
  tierBaseY: number;
  /** This instance's min corner within the tier (metres). */
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  exteriorMask: number;
}

/** Unit geometries: x,z span [-0.5, 0.5] (round: diameter 1), y spans [0, 1]. */
export function createFacadeGeometry(shape: FacadeShape): BufferGeometry {
  const geometry = shape === 'box' ? new BoxGeometry(1, 1, 1) : new CylinderGeometry(0.5, 0.5, 1, 48, 1);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

const UP = new Vector3(0, 1, 0);
const matrix = new Matrix4();
const rotation = new Quaternion();
const position = new Vector3();
const scale = new Vector3();
const tint = new Color();
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

export class FacadeInstances {
  readonly mesh: InstancedMesh;
  readonly capacity: number;
  /** Pool use (alloc/release): the draw count is the high-water mark; freed slots are reused. */
  private highWater = 0;
  private readonly freeSlots: number[] = [];
  private readonly facade: InstancedBufferAttribute;
  private readonly grid: InstancedBufferAttribute;
  private readonly tier: InstancedBufferAttribute;
  private readonly chunk: InstancedBufferAttribute;

  constructor(readonly shape: FacadeShape, capacity: number, material: Material = createFacadeMaterial(shape)) {
    this.capacity = capacity;
    const geometry = createFacadeGeometry(shape);
    this.facade = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.grid = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.tier = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.chunk = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    for (const attribute of [this.facade, this.grid, this.tier, this.chunk]) attribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aFacade', this.facade);
    geometry.setAttribute('aGrid', this.grid);
    geometry.setAttribute('aTier', this.tier);
    geometry.setAttribute('aChunk', this.chunk);
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, HIDDEN);
      this.mesh.setColorAt(i, tint.set(1, 1, 1));
    }
  }

  set(index: number, item: FacadeInstance): void {
    rotation.setFromAxisAngle(UP, item.yaw);
    matrix.compose(position.set(item.x, item.y, item.z), rotation, scale.set(item.width, item.height, item.depth));
    this.mesh.setMatrixAt(index, matrix);
    this.mesh.setColorAt(index, typeof item.color === 'string' ? tint.set(item.color) : item.color);
    this.facade.setXYZW(index, item.style, item.seed, item.glass, item.lit);
    this.grid.setXYZW(index, item.storeyHeight, item.columnsX, item.columnsZ, 0);
    this.tier.setXYZW(index, item.tierWidth, item.tierHeight, item.tierDepth, item.tierBaseY);
    this.chunk.setXYZW(index, item.offsetX, item.offsetY, item.offsetZ, item.exteriorMask);
    this.markDirty();
  }

  /** Move an instance without touching its facade data (bodies moving each frame). */
  setMatrix(index: number, world: Matrix4): void {
    this.mesh.setMatrixAt(index, world);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Take a free slot for `item`; null when the pool is full. */
  alloc(item: FacadeInstance): number | null {
    const index = this.freeSlots.pop() ?? (this.highWater < this.capacity ? this.highWater++ : -1);
    if (index < 0) return null;
    this.mesh.count = this.highWater;
    this.set(index, item);
    return index;
  }

  release(index: number): void {
    this.hide(index);
    this.freeSlots.push(index);
  }

  /** Empty the pool (Restart). */
  releaseAll(): void {
    for (let i = 0; i < this.highWater; i++) this.mesh.setMatrixAt(i, HIDDEN);
    this.highWater = 0;
    this.freeSlots.length = 0;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  hide(index: number): void {
    this.mesh.setMatrixAt(index, HIDDEN);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  markDirty(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.facade.needsUpdate = true;
    this.grid.needsUpdate = true;
    this.tier.needsUpdate = true;
    this.chunk.needsUpdate = true;
  }
}
