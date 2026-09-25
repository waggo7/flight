import {
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import type { BufferGeometry, Material, Object3D, QuaternionLike, Vector3Like } from 'three';
import { clamp, damp, lerp } from '../../../core/scalar-math';
import { afterInclude } from '../world/atmosphere';

// The hero: an ivory suit, charcoal gloves and boots, gold belt and crest, crimson cape.
// Built standing (head +Y, facing +Z). A pivot at the navel tips the body 90° into the
// classic flying pose — one fist forward — and back upright to hover, hands on hips.
// Ported from v1 (src/hero-figure.js) as-is for parity; M6 rebuilds it as the data-driven rig.
// Materials come from a factory (v1 shared module-level singletons), and the rim light edits
// three.js's shader only through the checked `afterInclude`.

export const HERO_JOINTS = [
  'pelvis', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR',
  'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR',
] as const;
export type HeroJoint = (typeof HERO_JOINTS)[number];

type Triple = readonly [number, number, number];
/** Euler angles (radians, XYZ) per joint; joints left out stay at rest. */
type HeroPose = Partial<Record<HeroJoint, Triple>>;

const POSES: { readonly fly: HeroPose; readonly hover: HeroPose } = {
  fly: {
    spine: [0.04, 0, 0], chest: [-0.07, 0, 0], neck: [-0.45, 0, 0], head: [-0.32, 0, 0],
    shoulderR: [-2.9, 0, 0.12], elbowR: [-0.08, 0, 0], wristR: [0, 0, 0],
    shoulderL: [-0.2, 0, 0.22], elbowL: [-0.35, 0, 0], wristL: [0.2, 0, 0],
    hipL: [0.05, 0, 0.05], hipR: [-0.03, 0, -0.05],
    kneeL: [0.42, 0, 0], kneeR: [0.12, 0, 0],
    ankleL: [0.9, 0, 0], ankleR: [0.85, 0, 0],
  },
  hover: {
    spine: [0, 0, 0], chest: [-0.05, 0, 0], neck: [0.05, 0, 0], head: [0.07, 0, 0],
    shoulderL: [0.18, 0, 0.72], elbowL: [0, 0, -1.5], wristL: [0, 0, -0.3],
    shoulderR: [0.18, 0, -0.72], elbowR: [0, 0, 1.5], wristR: [0, 0, 0.3],
    hipL: [-0.05, 0, 0.07], hipR: [-0.45, 0, -0.06],
    kneeL: [0.1, 0, 0], kneeR: [0.85, 0, 0],
    ankleL: [0.35, 0, 0], ankleR: [0.45, 0, 0],
  },
};

function mapJoints<T>(make: (name: HeroJoint) => T): Record<HeroJoint, T> {
  const result: Partial<Record<HeroJoint, T>> = {};
  for (const name of HERO_JOINTS) result[name] = make(name);
  return result as Record<HeroJoint, T>;
}

function toQuaternions(pose: HeroPose): Record<HeroJoint, Quaternion> {
  return mapJoints((name) => {
    const [x, y, z] = pose[name] ?? [0, 0, 0];
    return new Quaternion().setFromEuler(new Euler(x, y, z));
  });
}

interface RimLightOptions {
  strength?: number;
  color?: string;
  /** Multiplies the colour of back faces (the inside of the cape). */
  innerShade?: number;
}

function withRimLight<M extends Material>(material: M, { strength = 0.35, color = '#ffd9b0', innerShade = 1 }: RimLightOptions = {}): M {
  const rimColor = new Color(color);
  const where = `hero rim light (${strength}, ${innerShade})`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.uniforms.uRimStrength = { value: strength };
    let fragment = afterInclude(shader.fragmentShader, 'common', 'uniform vec3 uRimColor;\nuniform float uRimStrength;', where);
    fragment = afterInclude(fragment, 'color_fragment', `diffuseColor.rgb *= gl_FrontFacing ? 1.0 : ${innerShade.toFixed(2)};`, where);
    fragment = afterInclude(
      fragment,
      'emissivemap_fragment',
      `float rimFacing = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
totalEmissiveRadiance += uRimColor * pow(rimFacing, 3.0) * uRimStrength;`,
      where,
    );
    shader.fragmentShader = fragment;
  };
  material.customProgramCacheKey = () => `hero-rim:${strength}:${innerShade}`;
  return material;
}

export interface HeroMaterials {
  readonly suit: MeshPhysicalMaterial;
  readonly trim: MeshPhysicalMaterial;
  readonly cape: MeshPhysicalMaterial;
  readonly skin: MeshStandardMaterial;
  readonly hair: MeshStandardMaterial;
  readonly gold: MeshStandardMaterial;
}

/** A fresh set of the hero's materials (v1's MATERIALS, one set per call instead of one per page). */
export function createHeroMaterials(): HeroMaterials {
  return {
    suit: withRimLight(
      new MeshPhysicalMaterial({
        color: '#ebe5da', roughness: 0.45, sheen: 0.6, sheenColor: new Color('#fff0da'), sheenRoughness: 0.45,
        clearcoat: 0.25, clearcoatRoughness: 0.5,
      }),
    ),
    trim: withRimLight(new MeshPhysicalMaterial({ color: '#2a2e38', roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.3 }), { strength: 0.25 }),
    cape: withRimLight(
      new MeshPhysicalMaterial({
        color: '#a3121c', roughness: 0.6, sheen: 1, sheenColor: new Color('#ff6d55'), sheenRoughness: 0.35,
        side: DoubleSide,
      }),
      { strength: 0.3, color: '#ff9a70', innerShade: 0.62 },
    ),
    skin: new MeshStandardMaterial({ color: '#d69c7a', roughness: 0.6 }),
    hair: new MeshStandardMaterial({ color: '#221612', roughness: 0.42 }),
    gold: new MeshStandardMaterial({ color: '#e8b658', metalness: 1, roughness: 0.28 }),
  };
}

/** The flight state the rig poses from. FlightModel and FlightSnapshot both fit. */
export interface HeroFlightState {
  readonly position: Vector3Like;
  readonly quaternion: QuaternionLike;
  /** 1 = upright hover, 0 = horizontal flight. */
  readonly hoverBlend: number;
  /** Roll into turns, radians. */
  readonly bank: number;
  /** 0..1 how much boost is on. */
  readonly boostBlend: number;
  /** Radians per second; the head looks into turns. */
  readonly yawRate: number;
}

/** The steering the lead arm follows (FlightControls fits). */
export interface HeroSteering {
  readonly steerX: number;
}

interface PartPlacement {
  position?: Triple;
  scale?: Triple;
  rotation?: Triple;
}

export class HeroFigure {
  readonly root = new Group();
  /** Pivot at the navel: tipped 90° forward in flight, upright in hover. */
  readonly body = new Group();
  readonly joints: Readonly<Record<HeroJoint, Group>>;
  readonly flyPose = toQuaternions(POSES.fly);
  readonly hoverPose = toQuaternions(POSES.hover);
  /** Cape anchors across the upper back, in chest-joint space (left shoulder → right shoulder). */
  readonly capeAnchorsLocal: readonly Vector3[];
  /** xyz per anchor, relative to the hero root in world orientation; filled by refreshCapeFrame(). */
  readonly capeAnchors: Float32Array;
  /** The body capsule the cape collides with, relative to the hero root; filled by refreshCapeFrame(). */
  readonly capsule = { a: new Vector3(), b: new Vector3(), radius: 0.19 };
  time = 0;
  /** Smoothed flight share: 0 = hover pose, 1 = fly pose. */
  fly = 0;

  private readonly capsuleTop = new Vector3(0, 0.42, -0.03);
  private readonly capsuleBottom = new Vector3(0, -0.95, -0.03);
  private readonly scratch = new Vector3();
  private readonly quat = new Quaternion();
  private readonly euler = new Euler();
  private readonly builtJoints: Partial<Record<HeroJoint, Group>> = {};

  constructor(readonly materials: HeroMaterials = createHeroMaterials()) {
    this.root.name = 'hero';
    this.root.add(this.body);
    this.build();
    this.joints = mapJoints((name) => {
      const joint = this.builtJoints[name];
      if (!joint) throw new Error(`hero joint "${name}" was never built`);
      return joint;
    });

    const count = 11;
    const anchors: Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const u = i / (count - 1);
      const x = lerp(0.18, -0.18, u);
      const middle = 1 - Math.pow(2 * u - 1, 2);
      anchors.push(new Vector3(x, 0.27 - middle * 0.025, -0.095 - middle * 0.035));
    }
    this.capeAnchorsLocal = anchors;
    this.capeAnchors = new Float32Array(count * 3);
  }

  private joint(name: HeroJoint, parent: Object3D, x: number, y: number, z: number): Group {
    const joint = new Group();
    joint.name = name;
    joint.position.set(x, y, z);
    parent.add(joint);
    this.builtJoints[name] = joint;
    return joint;
  }

  private part(parent: Object3D, geometry: BufferGeometry, material: Material, { position = [0, 0, 0], scale = [1, 1, 1], rotation = [0, 0, 0] }: PartPlacement = {}): Mesh {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    mesh.rotation.set(...rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private build(): void {
    const M = this.materials;
    const capsule = (r: number, l: number, seg = 14): CapsuleGeometry => new CapsuleGeometry(r, l, 6, seg);
    const sphere = (r: number): SphereGeometry => new SphereGeometry(r, 24, 16);

    const pelvis = this.joint('pelvis', this.body, 0, -0.1, 0);
    this.part(pelvis, sphere(0.155), M.suit, { scale: [1, 0.72, 0.8] });
    this.part(pelvis, new TorusGeometry(0.13, 0.021, 10, 36), M.gold, {
      position: [0, 0.07, 0], rotation: [Math.PI / 2, 0, 0], scale: [1.12, 0.86, 1],
    });

    for (const side of [1, -1]) {
      const tag = side > 0 ? 'L' : 'R';
      const hip = this.joint(`hip${tag}`, pelvis, 0.095 * side, -0.06, 0);
      this.part(hip, capsule(0.078, 0.3), M.suit, { position: [0, -0.21, 0] });
      const knee = this.joint(`knee${tag}`, hip, 0, -0.44, 0);
      this.part(knee, capsule(0.06, 0.3), M.suit, { position: [0, -0.2, 0] });
      this.part(knee, capsule(0.067, 0.14), M.trim, { position: [0, -0.33, 0] });
      const ankle = this.joint(`ankle${tag}`, knee, 0, -0.43, 0);
      this.part(ankle, capsule(0.05, 0.12, 10), M.trim, { position: [0, -0.02, 0.05], rotation: [Math.PI / 2, 0, 0] });
    }

    const spine = this.joint('spine', this.body, 0, 0.02, 0);
    this.part(spine, capsule(0.12, 0.1), M.suit, { position: [0, 0.06, 0], scale: [1.1, 1, 0.85] });
    const chest = this.joint('chest', spine, 0, 0.16, 0);
    this.part(chest, capsule(0.15, 0.12), M.suit, { position: [0, 0.12, 0], scale: [1.32, 1, 0.82] });
    this.part(chest, new OctahedronGeometry(1, 0), M.gold, { position: [0, 0.14, 0.123], scale: [0.05, 0.072, 0.018] });
    this.part(chest, sphere(0.022), M.gold, { position: [0.14, 0.25, 0.07] });
    this.part(chest, sphere(0.022), M.gold, { position: [-0.14, 0.25, 0.07] });

    const neck = this.joint('neck', chest, 0, 0.3, 0);
    this.part(neck, new CylinderGeometry(0.048, 0.055, 0.1, 14), M.skin, { position: [0, 0.03, 0] });
    const head = this.joint('head', neck, 0, 0.07, 0);
    this.part(head, sphere(0.108), M.skin, { position: [0, 0.1, 0.005], scale: [0.92, 1.08, 1] });
    this.part(head, new SphereGeometry(0.114, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.56), M.hair, {
      position: [0, 0.112, -0.012], rotation: [-0.32, 0, 0], scale: [0.95, 1.05, 1.06],
    });

    for (const side of [1, -1]) {
      const tag = side > 0 ? 'L' : 'R';
      const shoulder = this.joint(`shoulder${tag}`, chest, 0.2 * side, 0.25, 0);
      this.part(shoulder, sphere(0.07), M.suit);
      this.part(shoulder, capsule(0.054, 0.2), M.suit, { position: [0, -0.15, 0] });
      const elbow = this.joint(`elbow${tag}`, shoulder, 0, -0.29, 0);
      this.part(elbow, capsule(0.047, 0.17), M.suit, { position: [0, -0.13, 0] });
      this.part(elbow, capsule(0.053, 0.07), M.trim, { position: [0, -0.2, 0] });
      const wrist = this.joint(`wrist${tag}`, elbow, 0, -0.26, 0);
      this.part(wrist, sphere(0.053), M.trim, { position: [0, -0.045, 0.005], scale: [0.9, 1.15, 1.1] });
    }
  }

  get capeMaterial(): MeshPhysicalMaterial {
    return this.materials.cape;
  }

  /** Pose from the flight state; call before reading anchors. */
  update(dt: number, flight: HeroFlightState, input?: HeroSteering | null): void {
    this.time += dt;
    this.fly = damp(this.fly, 1 - flight.hoverBlend, 12, dt);
    const fly = this.fly;
    this.root.position.copy(flight.position);
    this.root.quaternion.copy(flight.quaternion);

    this.body.rotation.x = fly * (Math.PI / 2);
    const bob = (1 - fly) * Math.sin(this.time * 1.6) * 0.045;
    this.body.position.set(0, bob, 0);

    const bank = flight.bank;
    const boost = flight.boostBlend;
    for (const name of HERO_JOINTS) {
      this.joints[name].quaternion.slerpQuaternions(this.hoverPose[name], this.flyPose[name], fly);
    }

    // Secondary motion layered on top of the base poses.
    const add = (name: HeroJoint, x: number, y: number, z: number): void => {
      this.quat.setFromEuler(this.euler.set(x, y, z));
      this.joints[name].quaternion.multiply(this.quat);
    };
    const flutter = Math.sin(this.time * 17) * 0.02 * boost * fly;
    add('hipL', 0, 0, bank * 0.12 * fly + flutter);
    add('hipR', 0, 0, bank * 0.12 * fly - flutter);
    add('kneeL', -0.28 * boost * fly, 0, 0);
    add('neck', 0, clamp(-flight.yawRate * 0.18, -0.25, 0.25) * fly, 0);
    add('shoulderR', 0, 0, clamp(-(input?.steerX ?? 0) * 0.1, -0.1, 0.1) * fly);
    const breathe = 1 + Math.sin(this.time * 1.9) * 0.012 * (1 - fly);
    this.joints.chest.scale.set(breathe, 1, breathe);
    add('hipR', Math.sin(this.time * 1.1) * 0.05 * (1 - fly), 0, 0);

    this.root.updateMatrixWorld(true);
  }

  /** Cape anchor points and body capsule, relative to the hero root, in world orientation. */
  refreshCapeFrame(): Float32Array {
    const origin = this.root.position;
    const chestMatrix = this.joints.chest.matrixWorld;
    this.capeAnchorsLocal.forEach((local, i) => {
      this.scratch.copy(local).applyMatrix4(chestMatrix).sub(origin);
      this.capeAnchors[i * 3] = this.scratch.x;
      this.capeAnchors[i * 3 + 1] = this.scratch.y;
      this.capeAnchors[i * 3 + 2] = this.scratch.z;
    });
    const bodyMatrix = this.body.matrixWorld;
    this.capsule.a.copy(this.capsuleTop).applyMatrix4(bodyMatrix).sub(origin);
    this.capsule.b.copy(this.capsuleBottom).applyMatrix4(bodyMatrix).sub(origin);
    return this.capeAnchors;
  }
}
