import { BufferAttribute, BufferGeometry, CapsuleGeometry, Color, Euler, ExtrudeGeometry, Matrix3, Matrix4, Quaternion, Shape, SphereGeometry, Vector3 } from 'three';
import type { HeroLook } from '../../../core/hero-definition';
import { HERO_POSE_JOINTS, type HeroPoseJoint } from '../../../core/hero-pose-graph';
import { clamp, lerp, smoothstep } from '../../../core/scalar-math';

// The hero's procedural body for the rig builder (hero-rig.ts): torso loft, limb tubes, head,
// hair and mask variants, gloves with a finger group and thumb, boots with soles, belt and an
// extruded emblem. Every part is added to one SkinnedPartBuilder per material with its bone
// weights: rigid for most parts, soft two-bone blends along the limb and spine chains.
// Positions are metres in the bind pose (standing, facing +Z, +X on the hero's left).

export type Vec3 = readonly [number, number, number];
/** Up to two bones per vertex: [bone a, bone b, weight of b]. */
export type BoneBlend = readonly [number, number, number];
export type WeightRule = (p: Vector3) => BoneBlend;

/** Bone index per joint (the skeleton's bone order is HERO_POSE_JOINTS). */
export const BONE = Object.fromEntries(HERO_POSE_JOINTS.map((name, i) => [name, i])) as Record<HeroPoseJoint, number>;

/** Torso cross-section at height y (reference units): half-width, front depth, back depth. */
export function torsoSection(y: number, shoulders: number, bulk: number): { width: number; front: number; back: number } {
  // (y, half-width, front, back) keys, crotch to the neck base.
  const keys: readonly (readonly [number, number, number, number])[] = [
    [-0.215, 0.02, 0.02, 0.02],
    [-0.2, 0.075, 0.07, 0.075],
    [-0.15, 0.146, 0.094, 0.108],
    [-0.08, 0.15, 0.097, 0.1],
    [-0.02, 0.136, 0.094, 0.086],
    [0.08, 0.145, 0.097, 0.092],
    [0.19, 0.176 * shoulders, 0.112, 0.108],
    [0.3, 0.2 * shoulders, 0.13, 0.108],
    [0.37, 0.207 * shoulders, 0.122, 0.104],
    [0.42, 0.178 * shoulders, 0.094, 0.094],
    [0.455, 0.104, 0.068, 0.072],
    [0.475, 0.06, 0.052, 0.057],
  ];
  let i = 0;
  while (i < keys.length - 2 && y > keys[i + 1]![0]) i++;
  const [y0, w0, f0, b0] = keys[i]!;
  const [y1, w1, f1, b1] = keys[i + 1]!;
  const t = smoothstep(y0, y1, y);
  const girth = 0.8 + 0.2 * bulk;
  return { width: lerp(w0, w1, t) * (0.7 + 0.3 * bulk), front: lerp(f0, f1, t) * girth, back: lerp(b0, b1, t) * girth };
}

/** Superellipse point: exponent < 2 bulges toward a rounded box. */
export function superellipse(angle: number, exponent: number): [number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [Math.sign(c) * Math.pow(Math.abs(c), exponent), Math.sign(s) * Math.pow(Math.abs(s), exponent)];
}

/** An indexed tube through rings of equal size (wrapping). Rings must climb (+Y) for the faces to point outward. */
export function loftGeometry(rings: readonly (readonly Vector3[])[]): BufferGeometry {
  const around = rings[0]!.length;
  const positions = new Float32Array(rings.length * around * 3);
  rings.forEach((ring, r) => ring.forEach((p, a) => p.toArray(positions, (r * around + a) * 3)));
  const index: number[] = [];
  for (let r = 0; r < rings.length - 1; r++) {
    for (let a = 0; a < around; a++) {
      const b = (a + 1) % around;
      const i0 = r * around + a;
      const i1 = r * around + b;
      const i2 = (r + 1) * around + a;
      const i3 = (r + 1) * around + b;
      index.push(i0, i2, i1, i1, i2, i3);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A limb tube hanging from `top` along -Y for `length`, radius from `radius(t)` (t = 0 top, 1
 * bottom), elliptical by `depth`, with rounded (hemispherical) ends so it is closed.
 */
export interface LimbTubeOptions {
  around?: number;
  rings?: number;
  /** Front-back radius as a share of the side-to-side radius. */
  depth?: number;
  /** Shift along +Z at t (0 top, 1 bottom), metres. */
  forward?: (t: number) => number;
}

export function limbTube(top: Vector3, length: number, radius: (t: number) => number, { around = 16, rings = 18, depth = 1, forward = () => 0 }: LimbTubeOptions = {}): BufferGeometry {
  const ringList: Vector3[][] = [];
  const cap = 4;
  const makeRing = (y: number, r: number, zShift: number): Vector3[] => {
    const ring: Vector3[] = [];
    for (let a = 0; a < around; a++) {
      const angle = (a / around) * Math.PI * 2;
      ring.push(new Vector3(top.x + Math.cos(angle) * r, y, top.z + zShift + Math.sin(angle) * r * depth));
    }
    return ring;
  };
  const r0 = radius(0);
  const r1 = radius(1);
  for (let i = 0; i <= cap; i++) {
    const phi = (i / cap) * (Math.PI / 2);
    ringList.push(makeRing(top.y + Math.cos(phi) * r0 * 0.9, Math.max(1e-4, Math.sin(phi) * r0), forward(0)));
  }
  for (let i = 1; i < rings; i++) {
    const t = i / rings;
    ringList.push(makeRing(top.y - t * length, radius(t), forward(t)));
  }
  for (let i = 0; i <= cap; i++) {
    const phi = (i / cap) * (Math.PI / 2);
    ringList.push(makeRing(top.y - length - Math.sin(phi) * r1 * 0.9, Math.max(1e-4, Math.cos(phi) * r1), forward(1)));
  }
  // loftGeometry faces outward for rings that climb (+Y); these were made going down.
  return loftGeometry(ringList.reverse());
}

/** Blend weights along a chain of joints placed on one axis (e.g. y going down a leg). */
export function chainWeights(value: number, chain: readonly (readonly [bone: number, at: number])[], zone: readonly number[], descending: boolean): BoneBlend {
  const v = descending ? -value : value;
  let index = 0;
  for (let i = 1; i < chain.length; i++) if (v >= (descending ? -chain[i]![1] : chain[i]![1]) - zone[i]!) index = i;
  if (index === 0) return [chain[0]![0], chain[0]![0], 0];
  const at = descending ? -chain[index]![1] : chain[index]![1];
  const w = smoothstep(at - zone[index]!, at + zone[index]!, v);
  return [chain[index - 1]![0], chain[index]![0], w];
}

interface PartOptions {
  weights: WeightRule | number;
  color?: Color;
  /** Trim material only: 0 trim, 1 accent metal, 2 glowing accent. */
  surface?: number;
  /** Placement applied to the geometry first. */
  matrix?: Matrix4;
}

/** Collects parts for one material into one skinned geometry. */
export class SkinnedPartBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly skinIndex: number[] = [];
  private readonly skinWeight: number[] = [];
  private readonly colors: number[] = [];
  private readonly surfaces: number[] = [];
  private readonly indices: number[] = [];
  private readonly point = new Vector3();
  private readonly normal = new Vector3();
  private readonly normalMatrix = new Matrix3();

  constructor(readonly withColor: boolean, readonly withSurface: boolean) {}

  get triangles(): number {
    return this.indices.length / 3;
  }

  add(geometry: BufferGeometry, { weights, color, surface = 0, matrix }: PartOptions): void {
    const base = this.positions.length / 3;
    const position = geometry.getAttribute('position');
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const normal = geometry.getAttribute('normal');
    if (matrix) this.normalMatrix.getNormalMatrix(matrix);
    for (let i = 0; i < position.count; i++) {
      this.point.fromBufferAttribute(position, i);
      this.normal.fromBufferAttribute(normal, i);
      if (matrix) {
        this.point.applyMatrix4(matrix);
        this.normal.applyMatrix3(this.normalMatrix).normalize();
      }
      this.positions.push(this.point.x, this.point.y, this.point.z);
      this.normals.push(this.normal.x, this.normal.y, this.normal.z);
      const [a, b, w] = typeof weights === 'number' ? [weights, weights, 0] : weights(this.point);
      if (w <= 1e-4 || a === b) {
        this.skinIndex.push(a, 0, 0, 0);
        this.skinWeight.push(1, 0, 0, 0);
      } else if (w >= 1 - 1e-4) {
        this.skinIndex.push(b, 0, 0, 0);
        this.skinWeight.push(1, 0, 0, 0);
      } else {
        this.skinIndex.push(a, b, 0, 0);
        this.skinWeight.push(1 - w, w, 0, 0);
      }
      if (this.withColor) {
        const c = color ?? new Color('#ffffff');
        this.colors.push(c.r, c.g, c.b);
      }
      if (this.withSurface) this.surfaces.push(surface);
    }
    const index = geometry.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.indices.push(base + index.getX(i));
    else for (let i = 0; i < position.count; i++) this.indices.push(base + i);
    geometry.dispose();
  }

  build(): BufferGeometry | null {
    if (this.indices.length === 0) return null;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(this.skinIndex), 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array(this.skinWeight), 4));
    if (this.withColor) geometry.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    if (this.withSurface) geometry.setAttribute('aSurface', new BufferAttribute(new Float32Array(this.surfaces), 1));
    const count = this.positions.length / 3;
    geometry.setIndex(new BufferAttribute(count > 65535 ? new Uint32Array(this.indices) : new Uint16Array(this.indices), 1));
    geometry.computeBoundingSphere();
    return geometry;
  }
}

export const place = (position: Vector3, scale: Vec3 = [1, 1, 1], rotation: Vec3 = [0, 0, 0]): Matrix4 =>
  new Matrix4().compose(position, new Quaternion().setFromEuler(new Euler(...rotation)), new Vector3(...scale));

/** Emblem outlines, about 1 unit tall, centred on the origin. */
export function emblemShape(kind: HeroLook['emblem']): Shape {
  const shape = new Shape();
  if (kind === 'diamond') {
    shape.moveTo(0, 0.5).lineTo(0.36, 0).lineTo(0, -0.5).lineTo(-0.36, 0).closePath();
  } else if (kind === 'star') {
    for (let i = 0; i < 10; i++) {
      const angle = Math.PI / 2 + (i / 10) * Math.PI * 2;
      const r = i % 2 === 0 ? 0.52 : 0.22;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r - 0.04;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    shape.closePath();
  } else if (kind === 'bolt') {
    shape.moveTo(0.12, 0.52).lineTo(-0.26, -0.04).lineTo(-0.02, -0.04).lineTo(-0.14, -0.52).lineTo(0.28, 0.08).lineTo(0.04, 0.08).closePath();
  } else {
    shape.absarc(0, 0, 0.46, 0, Math.PI * 2, false);
    const hole = new Shape();
    hole.absarc(0, 0, 0.3, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  return shape;
}


export interface HeroPartBuilders {
  readonly suit: SkinnedPartBuilder;
  readonly trim: SkinnedPartBuilder;
  readonly skin: SkinnedPartBuilder;
}

const gauss = (x: number): number => Math.exp(-x * x);

/** A smooth piecewise radius profile over t in [0, 1]; values are reference units, times `scale`. */
function profile(keys: readonly (readonly [number, number])[], scale: number): (t: number) => number {
  return (t) => {
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1]![0]) i++;
    return lerp(keys[i]![1], keys[i + 1]![1], smoothstep(keys[i]![0], keys[i + 1]![0], t)) * scale;
  };
}

/** Piecewise-linear offsets through the joints (so a limb tube follows a bent bind skeleton). */
function jointPath(keys: readonly (readonly [number, number])[]): (t: number) => number {
  return (t) => {
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1]![0]) i++;
    const [t0, v0] = keys[i]!;
    const [t1, v1] = keys[i + 1]!;
    return lerp(v0, v1, clamp((t - t0) / Math.max(1e-6, t1 - t0), 0, 1));
  };
}

/** A unit sphere (optionally partial), reshaped per vertex. */
function sphere(widthSegments: number, heightSegments: number, reshape?: (v: Vector3) => void, thetaStart = 0, thetaLength = Math.PI, phiStart = 0, phiLength = Math.PI * 2): BufferGeometry {
  const geometry = new SphereGeometry(1, widthSegments, heightSegments, phiStart, phiLength, thetaStart, thetaLength);
  if (reshape) {
    const position = geometry.getAttribute('position');
    const v = new Vector3();
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i);
      reshape(v);
      position.setXYZ(i, v.x, v.y, v.z);
    }
    geometry.computeVertexNormals();
  }
  return geometry;
}

/** Drop the triangles whose centroid (in the geometry's own space) fails `keep`. */
function keepTriangles(geometry: BufferGeometry, keep: (centroid: Vector3) => boolean): BufferGeometry {
  const index = geometry.getIndex()!;
  const position = geometry.getAttribute('position');
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const kept: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(position, index.getX(i));
    b.fromBufferAttribute(position, index.getX(i + 1));
    c.fromBufferAttribute(position, index.getX(i + 2));
    if (keep(a.add(b).add(c).divideScalar(3))) kept.push(index.getX(i), index.getX(i + 1), index.getX(i + 2));
  }
  geometry.setIndex(kept);
  return geometry;
}

/**
 * Fill the part builders with a hero's body in the bind pose. `world` holds each joint's bind
 * position in metres; `s` converts reference units to metres.
 */
export function buildBody(builders: HeroPartBuilders, look: Readonly<HeroLook>, world: Readonly<Record<HeroPoseJoint, Vector3>>, s: number, parts: 'full' | 'arms'): void {
  const { palette, build } = look;
  const { shoulders, bulk } = build;
  const full = parts === 'full';
  const girth = 0.7 + 0.3 * bulk;
  const handGirth = 0.85 + 0.15 * bulk;
  const P = (x: number, y: number, z: number): Vector3 => new Vector3(x * s, y * s, z * s);
  const trim = new Color(palette.trim);
  const accent = new Color(palette.accent);
  const sole = trim.clone().multiplyScalar(0.28).lerp(new Color('#1a1714'), 0.5);
  const skin = new Color(palette.skin);
  const hair = new Color(palette.hair);
  const { suit: suitParts, trim: trimParts, skin: skinParts } = builders;

  // Weight rules (positions in metres).
  const at = (joint: HeroPoseJoint): number => world[joint].y;
  const torsoWeights: WeightRule = (p) =>
    chainWeights(p.y / s, [[BONE.pelvis, 0], [BONE.spine, 0.0], [BONE.spine2, 0.14], [BONE.chest, 0.27]], [0, 0.05, 0.05, 0.05], false);
  const neckWeights: WeightRule = (p) =>
    chainWeights(p.y, [[BONE.chest, 0], [BONE.neck, at('neck') + 0.01 * s], [BONE.head, at('head')]], [0, 0.03 * s, 0.03 * s], false);
  const armWeights = (side: 'L' | 'R'): WeightRule => (p) =>
    chainWeights(p.y, [
      [BONE[`clavicle${side}`], 0], [BONE[`shoulder${side}`], at(`shoulder${side}`)], [BONE[`elbow${side}`], at(`elbow${side}`)], [BONE[`wrist${side}`], at(`wrist${side}`)],
    ], [0, 0.03 * s, 0.045 * s, 0.02 * s], true);
  const legWeights = (side: 'L' | 'R'): WeightRule => (p) =>
    chainWeights(p.y, [
      [BONE.pelvis, 0], [BONE[`hip${side}`], at(`hip${side}`)], [BONE[`knee${side}`], at(`knee${side}`)], [BONE[`ankle${side}`], at(`ankle${side}`)],
    ], [0, 0.035 * s, 0.05 * s, 0.03 * s], true);

  // --- Torso: a V-tapered loft from the crotch to the neck base, pecs and a spine groove -------
  const section = (y: number): { width: number; front: number; back: number } => torsoSection(y, shoulders, bulk);
  const surfacePoint = (y: number, angle: number, inflate = 0): Vector3 => {
    const { width, front, back } = section(y);
    const [cx, sz] = superellipse(angle, 0.78);
    let x = (width + inflate) * cx;
    let z = sz > 0 ? (front + inflate) * sz : (back + inflate) * sz;
    if (sz > 0) z += 0.013 * bulk * gauss((Math.abs(x) - 0.078 * shoulders) / 0.05) * gauss((y - 0.315) / 0.045) * sz;
    else if (y > -0.06 && y < 0.42) z += 0.005 * gauss(x / 0.018) * -sz;
    // Obliques: a slight inward curve at the waist sides.
    x *= 1 - 0.035 * gauss((y - 0.05) / 0.07) * Math.abs(cx);
    return P(x, y, z);
  };
  if (full) {
    const rings: Vector3[][] = [];
    const around = 32;
    const heights: number[] = [];
    for (let i = 0; i <= 30; i++) heights.push(lerp(-0.215, 0.475, i / 30));
    for (const y of heights) {
      const ring: Vector3[] = [];
      for (let a = 0; a < around; a++) ring.push(surfacePoint(y, (a / around) * Math.PI * 2));
      rings.push(ring);
    }
    // Close the crotch with a small cap.
    const bottom = heights[0]!;
    rings.unshift(Array.from({ length: around }, () => P(0, bottom - 0.004, 0)));
    suitParts.add(loftGeometry(rings), { weights: torsoWeights });

    // Belt (accent metal) with a buckle.
    const beltRings: Vector3[][] = [];
    for (const [y, inflate] of [[-0.036, 0], [-0.034, 0.007], [0.002, 0.007], [0.004, 0]] as const) {
      const ring: Vector3[] = [];
      for (let a = 0; a < around; a++) ring.push(surfacePoint(y, (a / around) * Math.PI * 2, inflate));
      beltRings.push(ring);
    }
    trimParts.add(loftGeometry(beltRings), { weights: torsoWeights, color: accent, surface: 1 });
    const beltFront = section(-0.016).front + 0.008;
    trimParts.add(sphere(16, 10), { weights: torsoWeights, color: accent, surface: 1, matrix: place(P(0, -0.016, beltFront), [0.032 * s, 0.024 * s, 0.009 * s]) });

    // Emblem on the chest: extruded, glowing accent.
    const emblemY = 0.325;
    const emblemSize = 0.135 * (0.9 + 0.1 * shoulders);
    const emblemZ = section(emblemY).front + 0.006 * bulk + 0.001;
    const emblem = new ExtrudeGeometry(emblemShape(look.emblem), { depth: 0.05, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1, curveSegments: 18 });
    trimParts.add(emblem, { weights: BONE.chest, color: accent, surface: 2, matrix: place(P(0, emblemY, emblemZ - 0.004), [emblemSize * s, emblemSize * s, emblemSize * s]) });

    // Cape clasps at the front of the shoulders.
    if (look.cape) {
      for (const sign of [1, -1]) {
        const y = 0.425;
        const z = section(y).front * 0.72;
        trimParts.add(sphere(14, 10), { weights: BONE.chest, color: accent, surface: 1, matrix: place(P(0.12 * shoulders * sign, y, z), [0.021 * s, 0.021 * s, 0.01 * s], [0.5, 0.35 * sign, 0]) });
      }
    }

    // --- Neck and head -------------------------------------------------------------------------
    const cowl = look.mask === 'cowl';
    const neckTop = world.head.clone().add(P(0, 0.05, 0));
    const neckRadius = 0.056 * (0.8 + 0.2 * bulk);
    const neckGeometry = limbTube(neckTop, 0.2 * s, (t) => lerp(neckRadius, neckRadius * 1.25, t * t) * s * (cowl ? 1.08 : 1), { around: 16, rings: 8, depth: 1.05 });
    if (cowl) trimParts.add(neckGeometry, { weights: neckWeights, color: trim });
    else skinParts.add(neckGeometry, { weights: neckWeights, color: skin });

    const headCentre = world.head.clone().add(P(0, 0.1, 0.012));
    const skull: Vec3 = [0.093, 0.118, 0.106];
    const onHead = (x: number, y: number, z: number): Vector3 => headCentre.clone().add(P(x, y, z));
    const chin = (v: Vector3): void => {
      if (v.y < 0) {
        v.x *= 1 - 0.24 * -v.y;
        v.z += 0.13 * -v.y * Math.max(v.z, 0);
      }
    };
    skinParts.add(sphere(32, 24, chin), { weights: BONE.head, color: skin, matrix: place(headCentre, [skull[0] * s, skull[1] * s, skull[2] * s]) });
    const frontZ = (x: number, y: number): number => skull[2] * Math.sqrt(Math.max(0, 1 - (x / skull[0]) ** 2 - (y / skull[1]) ** 2));
    const darker = skin.clone().multiplyScalar(0.86);
    skinParts.add(sphere(12, 10), { weights: BONE.head, color: darker, matrix: place(onHead(0, -0.008, frontZ(0, -0.008) - 0.002), [0.011 * s, 0.021 * s, 0.017 * s], [-0.3, 0, 0]) });
    skinParts.add(sphere(12, 6), { weights: BONE.head, color: skin.clone().lerp(new Color('#8a3f36'), 0.35), matrix: place(onHead(0, -0.052, frontZ(0, -0.045) + 0.002), [0.02 * s, 0.0055 * s, 0.006 * s]) });
    for (const sign of [1, -1]) {
      skinParts.add(sphere(10, 8), { weights: BONE.head, color: skin, matrix: place(onHead(0.091 * sign, 0.002, -0.006), [0.012 * s, 0.026 * s, 0.018 * s]) });
      if (!cowl) {
        skinParts.add(sphere(10, 8), { weights: BONE.head, color: new Color('#241a16'), matrix: place(onHead(0.033 * sign, 0.012, frontZ(0.033, 0.012) - 0.005), [0.012 * s, 0.0075 * s, 0.008 * s]) });
        skinParts.add(sphere(10, 6), { weights: BONE.head, color: hair, matrix: place(onHead(0.035 * sign, 0.033, frontZ(0.035, 0.033) - 0.001), [0.019 * s, 0.0042 * s, 0.006 * s], [0, 0, -0.12 * sign]) });
      }
    }

    // Hair.
    if (!cowl && look.hair !== 'none') {
      const capLength = look.hair === 'long' ? 0.62 : 0.56;
      skinParts.add(sphere(32, 14, undefined, 0, Math.PI * capLength), {
        weights: BONE.head, color: hair, matrix: place(onHead(0, 0.012, -0.012), [skull[0] * 1.07 * s, skull[1] * 1.05 * s, skull[2] * 1.07 * s], [-0.32, 0, 0]),
      });
      if (look.hair === 'swept') {
        skinParts.add(sphere(16, 10), { weights: BONE.head, color: hair, matrix: place(onHead(0.014, 0.1, 0.05), [0.072 * s, 0.03 * s, 0.056 * s], [-0.45, 0, 0.16]) });
      } else if (look.hair === 'long') {
        const tail = limbTube(onHead(0, 0.06, -0.098), 0.2 * s, (t) => lerp(0.03, 0.012, t) * s, { around: 12, rings: 8, forward: (t) => -0.045 * t * s });
        skinParts.add(tail, { weights: BONE.head, color: hair });
      } else {
        skinParts.add(sphere(16, 10), { weights: BONE.head, color: hair, matrix: place(onHead(0, 0.108, 0.035), [0.06 * s, 0.02 * s, 0.05 * s], [-0.4, 0, 0]) });
      }
    }

    // Masks.
    if (look.mask === 'domino') {
      const band = sphere(28, 6, undefined, 1.2, 0.5, Math.PI / 2 - 0.95, 1.9);
      trimParts.add(band, { weights: BONE.head, color: trim, matrix: place(headCentre, [skull[0] * 1.045 * s, skull[1] * 1.03 * s, skull[2] * 1.05 * s]) });
      for (const sign of [1, -1]) {
        trimParts.add(sphere(10, 8), {
          weights: BONE.head, color: new Color('#f3efe6'), matrix: place(onHead(0.033 * sign, 0.013, frontZ(0.033, 0.012) * 1.05 + 0.001), [0.014 * s, 0.0075 * s, 0.004 * s], [0, 0.3 * sign, 0]),
        });
      }
    } else if (cowl) {
      const hood = keepTriangles(sphere(32, 24), (c) => !(c.y < -0.12 && c.z > 0.2));
      trimParts.add(hood, { weights: BONE.head, color: trim, matrix: place(headCentre.clone().add(P(0, 0.004, -0.003)), [skull[0] * 1.08 * s, skull[1] * 1.06 * s, skull[2] * 1.08 * s]) });
      for (const sign of [1, -1]) {
        trimParts.add(sphere(12, 8), {
          weights: BONE.head, color: accent, surface: 2, matrix: place(onHead(0.034 * sign, 0.014, frontZ(0.034, 0.014) * 1.08 + 0.0005), [0.017 * s, 0.0065 * s, 0.004 * s], [0, 0.32 * sign, -0.1 * sign]),
        });
      }
    }
  }

  // --- Arms and hands (both part sets) ---------------------------------------------------------
  for (const [side, sign] of [['L', 1], ['R', -1]] as const) {
    const shoulder = world[`shoulder${side}`];
    const elbow = world[`elbow${side}`];
    const wrist = world[`wrist${side}`];
    const weights = armWeights(side);
    const armLength = shoulder.y - wrist.y + 0.012 * s;
    const elbowT = (shoulder.y - elbow.y) / armLength;
    const wristT = (shoulder.y - wrist.y) / armLength;
    const armRadius = profile([[0, 0.066], [0.3, 0.068], [elbowT - 0.08, 0.054], [elbowT, 0.05], [elbowT + 0.13, 0.055], [wristT, 0.036], [1, 0.035]], girth * s);
    const armShift = jointPath([[0, 0], [elbowT, elbow.z - shoulder.z], [wristT, wrist.z - shoulder.z], [1, wrist.z - shoulder.z]]);
    // Deltoid: a cap over the top of the arm, part of the shoulder's silhouette.
    suitParts.add(sphere(20, 14), { weights: BONE[`shoulder${side}`], matrix: place(shoulder.clone().add(P(0.008 * sign, -0.022, -0.003)), [0.074 * girth * s, 0.09 * girth * s, 0.072 * girth * s]) });
    suitParts.add(limbTube(shoulder, armLength, armRadius, { around: 18, rings: 24, depth: 0.95, forward: armShift }), { weights });
    const elbowRadius = armRadius(elbowT) * 0.9;
    suitParts.add(sphere(16, 12), { weights: BONE[`elbow${side}`], matrix: place(elbow.clone().add(P(0, 0, -0.004)), [elbowRadius, elbowRadius, elbowRadius]) });

    // Glove: a flared cuff over the forearm, the palm, a finger group and the thumb.
    const cuffTop = 0.09;
    const cuff = limbTube(wrist.clone().add(P(0, cuffTop, 0)), (cuffTop + 0.006) * s, (t) => {
      const y = wrist.y + (cuffTop - t * (cuffTop + 0.006)) * s;
      return armRadius((shoulder.y - y) / armLength) + (0.006 + 0.01 * (1 - smoothstep(0, 0.35, t))) * s;
    }, { around: 18, rings: 7 });
    trimParts.add(cuff, { weights, color: trim });
    trimParts.add(sphere(16, 12), { weights: BONE[`wrist${side}`], color: trim, matrix: place(wrist.clone().add(P(-0.002 * sign, -0.048, 0.004)), [0.026 * handGirth * s, 0.05 * s, 0.045 * handGirth * s]) });
    const knuckles = world[`fingers${side}`];
    const fingerZ = [0.0285, 0.01, -0.009, -0.0265];
    const fingerLength = [0.05, 0.058, 0.055, 0.045];
    fingerZ.forEach((z, i) => {
      const radius = 0.0119 * handGirth;
      const length = fingerLength[i]!;
      trimParts.add(new CapsuleGeometry(radius * s, length * s, 3, 8), {
        weights: BONE[`fingers${side}`], color: trim, matrix: place(knuckles.clone().add(P(0, -length / 2 - 0.004, z)), [1, 1, 1]),
      });
    });
    const thumbDir = new Vector3(-0.3 * sign, -0.72, 0.62).normalize();
    const thumb = world[`thumb${side}`];
    trimParts.add(new CapsuleGeometry(0.013 * handGirth * s, 0.036 * s, 3, 8), {
      weights: BONE[`thumb${side}`], color: trim,
      matrix: new Matrix4().compose(thumb.clone().addScaledVector(thumbDir, 0.029 * s), new Quaternion().setFromUnitVectors(new Vector3(0, -1, 0), thumbDir), new Vector3(1, 1, 1)),
    });
  }

  if (!full) return;

  // --- Legs and boots --------------------------------------------------------------------------
  for (const side of ['L', 'R'] as const) {
    const hip = world[`hip${side}`];
    const knee = world[`knee${side}`];
    const ankle = world[`ankle${side}`];
    const weights = legWeights(side);
    const legLength = hip.y - ankle.y + 0.012 * s;
    const kneeT = (hip.y - knee.y) / legLength;
    const ankleT = (hip.y - ankle.y) / legLength;
    const legRadius = profile([[0, 0.09], [0.22, 0.086], [kneeT - 0.07, 0.062], [kneeT, 0.056], [kneeT + 0.12, 0.062], [0.85, 0.046], [ankleT, 0.04], [1, 0.04]], girth * s);
    const legShift = jointPath([[0, 0], [kneeT, knee.z - hip.z], [ankleT, ankle.z - hip.z], [1, ankle.z - hip.z]]);
    suitParts.add(limbTube(hip, legLength, legRadius, { around: 18, rings: 26, depth: 1.06, forward: legShift }), { weights });
    const hipRadius = legRadius(0) * 0.85;
    suitParts.add(sphere(16, 12), { weights: BONE[`hip${side}`], matrix: place(hip.clone(), [hipRadius, hipRadius, hipRadius]) });
    const kneeRadius = legRadius(kneeT) * 0.9;
    suitParts.add(sphere(16, 12), { weights: BONE[`knee${side}`], matrix: place(knee.clone().add(P(0, 0, 0.002)), [kneeRadius, kneeRadius * 1.05, kneeRadius]) });

    // Boot: a shaft over the shin with a cuff at the top, the foot and a sole.
    const bootTop = 0.28;
    const bootLength = bootTop + 0.01;
    const shaft = limbTube(ankle.clone().add(P(0, bootTop, 0)), bootLength * s, (t) => {
      const y = ankle.y + (bootTop - t * bootLength) * s;
      return legRadius((hip.y - y) / legLength) + (0.007 + 0.012 * (1 - smoothstep(0, 0.12, t))) * s;
    }, { around: 18, rings: 12, depth: 1.06, forward: (t) => legShift(clamp((hip.y - (ankle.y + (bootTop - t * bootLength) * s)) / legLength, 0, 1)) - (ankle.z - hip.z) });
    trimParts.add(shaft, { weights, color: trim });
    const footBottom = -0.3;
    trimParts.add(sphere(18, 12, (v) => {
      v.y = Math.max(v.y, footBottom);
      if (v.z > 0.4) v.y = Math.min(v.y, 0.55);
    }), { weights: BONE[`ankle${side}`], color: trim, matrix: place(ankle.clone().add(P(0, -0.04, 0.05)), [0.046 * handGirth * s, 0.05 * s, 0.12 * s]) });
    trimParts.add(sphere(18, 6, (v) => {
      v.y = clamp(v.y, -0.6, 0.6);
    }), { weights: BONE[`ankle${side}`], color: sole, matrix: place(ankle.clone().add(P(0, -0.052 - 0.05 * 0.3, 0.052)), [0.05 * handGirth * s, 0.014 * s, 0.126 * s]) });
  }
}
