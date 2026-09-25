import { Bone, Group, Skeleton, SkinnedMesh, Vector3 } from 'three';
import type { Material } from 'three';
import type { HeroLook } from '../../../core/hero-definition';
import { HERO_POSE_JOINTS, type HeroPoseJoint } from '../../../core/hero-pose-graph';
import { lerp } from '../../../core/scalar-math';
import { buildBody, SkinnedPartBuilder, torsoSection, type Vec3 } from './hero-body-geometry';
import { createHeroMaterials, type HeroMaterialSet } from './hero-materials';

// The data-driven hero: a procedural body built from a hero's `look`, bound to a 25-bone
// skeleton (v1's 17 joints + spine2, clavicles, a finger group and a thumb per hand, and the
// navel pivot `body`). Every part is merged into one rigid-skinned SkinnedMesh per material —
// suit, trim (gloves, boots, belt, mask, emblem) and skin (skin, hair) — so the figure is
// three draw calls (four with the cape) with no gaps: each vertex follows its joint, with soft
// two-bone weights across the shoulders, elbows, wrists, hips, knees, spine and neck, and a
// sphere at each hinge.
//
// Built standing (head +Y, facing +Z, +X on the hero's left), limbs hanging along -Y: the bind
// pose the pose library (content/heroes/poses.json) is authored against. `parts: 'arms'` builds
// only the shoulders, arms and hands on the same skeleton (first-person arms, M8).

export type HeroRigParts = 'full' | 'arms';

export interface HeroRigOptions {
  parts?: HeroRigParts;
  materials?: HeroMaterialSet;
}

/** The reference skeleton's standing height (sole to crown) at scale 1. */
const SKELETON_HEIGHT = 1.905;
/** Pose-library offsets are authored for this hero height. */
const POSE_REFERENCE_HEIGHT = 1.86;


const JOINT_PARENT: Record<HeroPoseJoint, HeroPoseJoint | null> = {
  body: null, pelvis: 'body', spine: 'body', spine2: 'spine', chest: 'spine2', neck: 'chest', head: 'neck',
  clavicleL: 'chest', clavicleR: 'chest', shoulderL: 'clavicleL', shoulderR: 'clavicleR', elbowL: 'shoulderL', elbowR: 'shoulderR',
  wristL: 'elbowL', wristR: 'elbowR', fingersL: 'wristL', fingersR: 'wristR', thumbL: 'wristL', thumbR: 'wristR',
  hipL: 'pelvis', hipR: 'pelvis', kneeL: 'hipL', kneeR: 'hipR', ankleL: 'kneeL', ankleR: 'kneeR',
};

/** Joint offsets from the parent, reference units (scale 1), for a given shoulder width. */
function jointOffsets(shoulders: number, bulk: number): Record<HeroPoseJoint, Vec3> {
  const hipX = 0.092 * (0.85 + 0.15 * bulk);
  const offsets: Partial<Record<HeroPoseJoint, Vec3>> = {
    body: [0, 0, 0], pelvis: [0, -0.08, 0], spine: [0, 0.02, 0], spine2: [0, 0.12, 0], chest: [0, 0.13, 0],
    neck: [0, 0.2, -0.012], head: [0, 0.085, 0.012],
  };
  for (const [side, sign] of [['L', 1], ['R', -1]] as const) {
    offsets[`clavicle${side}`] = [0.025 * sign, 0.15, -0.005];
    offsets[`shoulder${side}`] = [(0.2 * shoulders - 0.025) * sign, 0.005, -0.01];
    offsets[`elbow${side}`] = [0, -0.29, 0];
    offsets[`wrist${side}`] = [0, -0.265, 0.005];
    offsets[`fingers${side}`] = [-0.004 * sign, -0.088, 0.004];
    offsets[`thumb${side}`] = [-0.014 * sign, -0.028, 0.02];
    offsets[`hip${side}`] = [hipX * sign, -0.07, 0];
    offsets[`knee${side}`] = [0, -0.45, 0.005];
    offsets[`ankle${side}`] = [0, -0.44, -0.012];
  }
  return offsets as Record<HeroPoseJoint, Vec3>;
}

export interface HeroRigStats {
  drawCalls: number;
  triangles: number;
  bones: number;
}

/** A built hero: skeleton, skinned meshes and the cape frame, posed from the pose graph. */
export class HeroRig {
  readonly root = new Group();
  readonly bones: Readonly<Record<HeroPoseJoint, Bone>>;
  /** Bones in HERO_POSE_JOINTS order (the graph's rotation order). */
  readonly boneList: readonly Bone[];
  readonly skeleton: Skeleton;
  readonly meshes: readonly SkinnedMesh[];
  /** Metres per reference unit (height / 1.905). */
  readonly scale: number;
  /** Cape anchors across the upper back, in chest-bone space (left shoulder → right shoulder). */
  readonly capeAnchorsLocal: readonly Vector3[];
  /** xyz per anchor, relative to the hero root in world orientation; filled by refreshCapeFrame(). */
  readonly capeAnchors: Float32Array;
  /** The body capsule the cape collides with, relative to the hero root; filled by refreshCapeFrame(). */
  readonly capsule: { a: Vector3; b: Vector3; radius: number };
  /** Shoulder width of the cape's top edge, metres. */
  readonly capeTopWidth: number;

  private readonly offsetScale: number;
  private readonly capsuleTop: Vector3;
  private readonly capsuleBottom: Vector3;
  private readonly scratch = new Vector3();

  constructor(readonly look: Readonly<HeroLook>, readonly materials: HeroMaterialSet, readonly parts: HeroRigParts) {
    const { height, shoulders, bulk } = look.build;
    const s = height / SKELETON_HEIGHT;
    this.scale = s;
    this.offsetScale = height / POSE_REFERENCE_HEIGHT;
    this.root.name = parts === 'arms' ? 'hero-arms' : 'hero';

    // Skeleton in the bind pose.
    const offsets = jointOffsets(shoulders, bulk);
    const bones = {} as Record<HeroPoseJoint, Bone>;
    const world = {} as Record<HeroPoseJoint, Vector3>;
    for (const name of HERO_POSE_JOINTS) {
      const bone = new Bone();
      bone.name = name;
      const [x, y, z] = offsets[name];
      bone.position.set(x * s, y * s, z * s);
      const parent = JOINT_PARENT[name];
      if (parent) bones[parent].add(bone);
      else this.root.add(bone);
      bones[name] = bone;
      world[name] = parent ? world[parent].clone().add(bone.position) : bone.position.clone();
    }
    this.bones = bones;
    this.boneList = HERO_POSE_JOINTS.map((name) => bones[name]);
    this.root.updateMatrixWorld(true);
    this.skeleton = new Skeleton([...this.boneList]);

    const builders = {
      suit: new SkinnedPartBuilder(false, false),
      trim: new SkinnedPartBuilder(true, true),
      skin: new SkinnedPartBuilder(true, false),
    };
    buildBody(builders, look, world, s, parts);

    const meshes: SkinnedMesh[] = [];
    for (const [key, builder] of Object.entries(builders) as [keyof typeof builders, SkinnedPartBuilder][]) {
      const geometry = builder.build();
      if (!geometry) continue;
      const material: Material = materials[key];
      const mesh = new SkinnedMesh(geometry, material);
      mesh.name = `hero-${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      mesh.bind(this.skeleton);
      meshes.push(mesh);
    }
    this.meshes = meshes;

    // Cape frame: anchors across the shoulder blades, and the body capsule.
    const count = 11;
    const anchorY = 0.405;
    const back = torsoSection(anchorY, shoulders, bulk).back;
    const halfWidth = 0.165 * shoulders * (0.7 + 0.3 * bulk);
    this.capeTopWidth = halfWidth * 2 * s * 1.25;
    const chest = world.chest;
    const anchors: Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const u = i / (count - 1);
      const middle = 1 - Math.pow(2 * u - 1, 2);
      anchors.push(new Vector3(lerp(halfWidth, -halfWidth, u) * s, (anchorY - middle * 0.02) * s - chest.y, (-back - 0.012 - middle * 0.012) * s - chest.z));
    }
    this.capeAnchorsLocal = anchors;
    this.capeAnchors = new Float32Array(count * 3);
    const radius = 0.19 * s * (0.75 + 0.25 * bulk) * (0.8 + 0.2 * shoulders);
    this.capsule = { a: new Vector3(), b: new Vector3(), radius };
    this.capsuleTop = new Vector3(0, 0.42 * s, -0.03 * s);
    this.capsuleBottom = new Vector3(0, -0.95 * s, -0.03 * s);
  }

  /** Pose from the graph's output: rotations (x, y, z, w per joint) and the body offset (reference metres). */
  applyPose(rotations: ArrayLike<number>, offset: ArrayLike<number>): void {
    const list = this.boneList;
    for (let j = 0; j < list.length; j++) {
      const o = j * 4;
      list[j]!.quaternion.set(rotations[o]!, rotations[o + 1]!, rotations[o + 2]!, rotations[o + 3]!);
    }
    this.bones.body.position.set(offset[0]! * this.offsetScale, offset[1]! * this.offsetScale, offset[2]! * this.offsetScale);
  }

  /** Cape anchor points and body capsule, relative to the hero root, in world orientation (call after updateMatrixWorld). */
  refreshCapeFrame(): Float32Array {
    const origin = this.root.position;
    const chestMatrix = this.bones.chest.matrixWorld;
    this.capeAnchorsLocal.forEach((local, i) => {
      this.scratch.copy(local).applyMatrix4(chestMatrix).sub(origin);
      this.capeAnchors[i * 3] = this.scratch.x;
      this.capeAnchors[i * 3 + 1] = this.scratch.y;
      this.capeAnchors[i * 3 + 2] = this.scratch.z;
    });
    const bodyMatrix = this.bones.body.matrixWorld;
    this.capsule.a.copy(this.capsuleTop).applyMatrix4(bodyMatrix).sub(origin);
    this.capsule.b.copy(this.capsuleBottom).applyMatrix4(bodyMatrix).sub(origin);
    return this.capeAnchors;
  }

  stats(): HeroRigStats {
    let triangles = 0;
    for (const mesh of this.meshes) triangles += (mesh.geometry.getIndex()?.count ?? 0) / 3;
    return { drawCalls: this.meshes.length, triangles, bones: this.boneList.length };
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.geometry.dispose();
    this.skeleton.dispose();
    this.root.removeFromParent();
  }
}

/** Build a hero from its look. `parts: 'arms'` makes only the shoulders, arms and hands (first person). */
export function buildHeroRig(look: Readonly<HeroLook>, options: HeroRigOptions = {}): HeroRig {
  const { build } = look;
  const materials = options.materials ?? createHeroMaterials(look.palette, build.height / SKELETON_HEIGHT);
  return new HeroRig(look, materials, options.parts ?? 'full');
}
