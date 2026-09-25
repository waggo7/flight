import { quatDot, quatFromEulerXYZ, quatIdentity, quatMultiply, quatNormalize, quatRotateInFrame } from './joint-rotation';
import { clamp, smoothstep } from './scalar-math';

// The hero's pose graph: flight state, power state and events in; weights over the pose
// library (content/heroes/poses.json) and one local rotation per joint out.
//
//   flight weights  hover / brake / dive / boost / cruise, from hoverBlend, brake, pitch, boost
//   overrides       power phases (slam, grab) and event pulses (burst, glance) take a share of
//                   the weight; poses marked `full: false` (upper body) leave the joints they
//                   don't list to the flight poses
//   springs         one damped spring per joint (per quaternion component, exact solution, so
//                   any dt is stable) gives anticipation, a small overshoot and weight
//   additive layers bank lean, steering arm drift, breathing, boost flutter, hover bob
//   head look-at    toward a target direction (grab target, failing tower, free look) or into
//                   the turn, split between neck and head
//
// Rotations are quaternions (x, y, z, w), local to each joint's parent, in the order of
// HERO_POSE_JOINTS; the library is authored as Euler XYZ radians. Pure: no DOM, no three.js
// objects, no randomness. The GDScript twin is godot/core/hero_pose_graph.gd, checked against
// conformance/hero-pose-graph.json.

/** Every joint the graph poses, parents before children. `body` is the navel pivot that tips the whole figure flat to fly. */
export const HERO_POSE_JOINTS = [
  'body', 'pelvis', 'spine', 'spine2', 'chest', 'neck', 'head',
  'clavicleL', 'clavicleR', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR',
  'fingersL', 'fingersR', 'thumbL', 'thumbR',
  'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR',
] as const;
export type HeroPoseJoint = (typeof HERO_POSE_JOINTS)[number];

export const HERO_POSE_NAMES = [
  'hover', 'cruise', 'boost', 'dive', 'brake', 'burst', 'glance',
  'slamWindup', 'slamLand', 'grabReach', 'hold', 'throwWindup', 'throwRelease',
] as const;
export type HeroPoseName = (typeof HERO_POSE_NAMES)[number];

/** The poses the flight state blends between; each must be `full`. */
export const HERO_FLIGHT_POSES = ['hover', 'brake', 'dive', 'boost', 'cruise'] as const satisfies readonly HeroPoseName[];

export const HERO_HAND_SHAPES = ['fist', 'open', 'grip'] as const;
export type HeroHandShape = (typeof HERO_HAND_SHAPES)[number];

export const SLAM_PHASES = ['ready', 'windup', 'dive', 'impact', 'recover', 'cooldown'] as const;
export type SlamPhase = (typeof SLAM_PHASES)[number];
export const GRAB_PHASES = ['empty', 'reaching', 'holding', 'windup', 'release'] as const;
export type GrabPhase = (typeof GRAB_PHASES)[number];

/** What the powers are doing (M7's state machines drive this). */
export interface HeroActionState {
  slam: SlamPhase;
  grab: GrabPhase;
}

export const IDLE_ACTIONS: Readonly<HeroActionState> = Object.freeze({ slam: 'ready', grab: 'empty' });

export type HeroPoseEvent = 'burst' | 'glance';

/** A direction to look toward, in the hero root's frame (+Z forward, +Y up); need not be unit length. */
export interface HeroLookTarget {
  x: number;
  y: number;
  z: number;
  /** 0..1, how strongly the head follows it. */
  weight: number;
}

export interface HeroPoseInput {
  /** 1 = upright hover, 0 = flying (FlightSnapshot.hoverBlend). */
  hoverBlend: number;
  /** 0..1. */
  boostBlend: number;
  /** 0..1 of boost speed. */
  speedShare: number;
  /** Radians, positive = climbing. */
  pitch: number;
  /** Radians of roll into the turn. */
  bank: number;
  /** Radians per second. */
  yawRate: number;
  /** Steering stick, -1..1 (right positive). */
  steerX: number;
  /** 0..1, the brake held. */
  brake: number;
  actions: HeroActionState;
  look: HeroLookTarget | null;
}

export type EulerTriple = readonly [number, number, number];

export interface HeroPoseDefinition {
  /** true: joints left out sit at rest. false (upper-body poses): joints left out follow the flight poses. */
  full: boolean;
  joints: Partial<Record<HeroPoseJoint, EulerTriple>>;
  /** Shift of the body pivot, metres for the 1.86 m reference hero (e.g. the landing crouch). */
  offset?: EulerTriple | null;
  /** Hand shapes; they set the fingers and thumb. The right hand is the mirror of the left. */
  handL?: HeroHandShape | null;
  handR?: HeroHandShape | null;
}

export interface HeroActionPose {
  pose: HeroPoseName;
  weight: number;
}

export interface HeroPoseGraphTuning {
  springs: { dampingRatio: number; core: number; limb: number; hand: number; head: number; offset: number; look: number };
  dive: { start: number; full: number };
  events: { burst: { duration: number; rise: number; hold: number }; glance: { duration: number; rise: number; hold: number } };
  layers: {
    bankLean: number; bankHips: number; steerDrift: number;
    breathRate: number; breathDepth: number; idleSway: number;
    flutterRate: number; flutterDepth: number; bobRate: number; bobHeight: number;
  };
  look: { maxYaw: number; maxPitch: number; neckShare: number; turnLead: number };
  actions: {
    slam: Partial<Record<SlamPhase, HeroActionPose | null>>;
    grab: Partial<Record<GrabPhase, HeroActionPose | null>>;
  };
}

export interface HeroPoseLibrary {
  hands: Record<HeroHandShape, { fingers: EulerTriple; thumb: EulerTriple }>;
  poses: Record<HeroPoseName, HeroPoseDefinition>;
  graph: HeroPoseGraphTuning;
}

const JOINT_COUNT = HERO_POSE_JOINTS.length;
const POSE_COUNT = HERO_POSE_NAMES.length;

type SpringGroup = 'core' | 'limb' | 'hand' | 'head';
const SPRING_GROUP: Record<HeroPoseJoint, SpringGroup> = {
  body: 'core', pelvis: 'core', spine: 'core', spine2: 'core', chest: 'core', neck: 'head', head: 'head',
  clavicleL: 'limb', clavicleR: 'limb', shoulderL: 'limb', shoulderR: 'limb', elbowL: 'limb', elbowR: 'limb', wristL: 'limb', wristR: 'limb',
  fingersL: 'hand', fingersR: 'hand', thumbL: 'hand', thumbR: 'hand',
  hipL: 'limb', hipR: 'limb', kneeL: 'limb', kneeR: 'limb', ankleL: 'limb', ankleR: 'limb',
};

export const jointIndex = (name: HeroPoseJoint): number => HERO_POSE_JOINTS.indexOf(name);
export const poseIndex = (name: HeroPoseName): number => HERO_POSE_NAMES.indexOf(name);

const J = Object.fromEntries(HERO_POSE_JOINTS.map((name, i) => [name, i])) as Record<HeroPoseJoint, number>;

/**
 * Coefficients of the exact damped-spring step over dt, for a spring of angular frequency
 * `omega` (rad/s) and damping ratio `zeta` (≤ 1): with y = x − target,
 *   y' = a·y + b·v,  v' = c·y + d·v.
 */
export function springCoefficients(omega: number, zeta: number, dt: number, out: Float64Array | number[], o = 0): void {
  if (zeta >= 0.9999) {
    const e = Math.exp(-omega * dt);
    out[o] = e * (1 + omega * dt);
    out[o + 1] = e * dt;
    out[o + 2] = -e * omega * omega * dt;
    out[o + 3] = e * (1 - omega * dt);
    return;
  }
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const e = Math.exp(-zeta * omega * dt);
  const c = Math.cos(wd * dt);
  const s = Math.sin(wd * dt);
  out[o] = e * (c + ((zeta * omega) / wd) * s);
  out[o + 1] = (e * s) / wd;
  out[o + 2] = (-e * omega * omega * s) / wd;
  out[o + 3] = e * (c - ((zeta * omega) / wd) * s);
}

/** 0..1 pulse for an event `age` seconds old: rises over `rise`, holds, falls away by `duration` (shares of it). */
export function eventEnvelope(age: number, duration: number, rise: number, hold: number): number {
  if (age < 0 || age >= duration) return 0;
  const u = age / duration;
  return Math.min(1, u / rise) * (1 - smoothstep(hold, 1, u));
}

const finite = (value: number, fallback = 0): number => (Number.isFinite(value) ? value : fallback);

export class HeroPoseGraph {
  /** Normalised pose weights in HERO_POSE_NAMES order: each in [0, 1], summing to 1. */
  readonly weights = new Float64Array(POSE_COUNT);
  /** Final local rotations, (x, y, z, w) per joint in HERO_POSE_JOINTS order. */
  readonly rotations = new Float64Array(JOINT_COUNT * 4);
  /** Body pivot offset, metres for the 1.86 m reference hero (scale by height / 1.86). */
  readonly offset = new Float64Array(3);
  /** Look angles actually applied (yaw, pitch), radians. */
  readonly look = new Float64Array(2);
  time = 0;

  /** Pose quaternions, POSE_COUNT × JOINT_COUNT × 4, canonical (w ≥ 0). */
  private readonly poseQuats = new Float64Array(POSE_COUNT * JOINT_COUNT * 4);
  /** 1 where a pose sets a joint. */
  private readonly defines = new Uint8Array(POSE_COUNT * JOINT_COUNT);
  private readonly poseOffsets = new Float64Array(POSE_COUNT * 3);
  private readonly flightWeights = new Float64Array(POSE_COUNT);
  private readonly overrideWeights = new Float64Array(POSE_COUNT);
  private readonly target = new Float64Array(JOINT_COUNT * 4);
  private readonly springValue = new Float64Array(JOINT_COUNT * 4);
  private readonly springVelocity = new Float64Array(JOINT_COUNT * 4);
  private readonly targetOffset = new Float64Array(3);
  private readonly offsetValue = new Float64Array(3);
  private readonly offsetVelocity = new Float64Array(3);
  private readonly lookValue = new Float64Array(2);
  private readonly lookVelocity = new Float64Array(2);
  private readonly targetLook = new Float64Array(2);
  private readonly coefficients = new Float64Array(24);
  private readonly scratch = new Float64Array(16);
  private readonly frame = new Float64Array(8);
  private readonly jointGroup = new Uint8Array(JOINT_COUNT);
  private readonly eventAge = { burst: Infinity, glance: Infinity };
  private forced = -1;
  private readonly tuning: HeroPoseGraphTuning;

  constructor(library: HeroPoseLibrary) {
    this.tuning = library.graph;
    const groups: SpringGroup[] = ['core', 'limb', 'hand', 'head'];
    HERO_POSE_JOINTS.forEach((name, j) => (this.jointGroup[j] = groups.indexOf(SPRING_GROUP[name])));
    HERO_POSE_NAMES.forEach((poseName, p) => {
      const pose = library.poses[poseName];
      if (!pose) throw new Error(`pose library: missing pose "${poseName}"`);
      if ((HERO_FLIGHT_POSES as readonly string[]).includes(poseName) && !pose.full) throw new Error(`pose library: flight pose "${poseName}" must be full`);
      const euler = new Map<HeroPoseJoint, EulerTriple>();
      for (const [joint, angles] of Object.entries(pose.joints) as [HeroPoseJoint, EulerTriple][]) euler.set(joint, angles);
      for (const [side, shapeName] of [['L', pose.handL], ['R', pose.handR]] as const) {
        const shape = shapeName ? library.hands[shapeName] : pose.full ? library.hands.open : null;
        if (!shape) continue;
        const mirror = side === 'R' ? -1 : 1;
        euler.set(`fingers${side}`, [shape.fingers[0], shape.fingers[1] * mirror, shape.fingers[2] * mirror]);
        euler.set(`thumb${side}`, [shape.thumb[0], shape.thumb[1] * mirror, shape.thumb[2] * mirror]);
      }
      for (let j = 0; j < JOINT_COUNT; j++) {
        const angles = euler.get(HERO_POSE_JOINTS[j]);
        const o = (p * JOINT_COUNT + j) * 4;
        if (angles) quatFromEulerXYZ(this.poseQuats, o, angles[0], angles[1], angles[2]);
        else quatIdentity(this.poseQuats, o);
        if (this.poseQuats[o + 3] < 0) for (let k = 0; k < 4; k++) this.poseQuats[o + k] = -this.poseQuats[o + k];
        this.defines[p * JOINT_COUNT + j] = pose.full || angles ? 1 : 0;
      }
      const offset = pose.offset ?? [0, 0, 0];
      for (let k = 0; k < 3; k++) this.poseOffsets[p * 3 + k] = offset[k];
    });
    for (let j = 0; j < JOINT_COUNT; j++) quatIdentity(this.springValue, j * 4);
    this.snap(null);
  }

  /** Start an event pulse (burst: bursting through a building; glance: bouncing off one). */
  trigger(event: HeroPoseEvent): void {
    this.eventAge[event] = 0;
  }

  /** Hold one pose at full weight (tests, stills); null returns to the graph. */
  force(name: HeroPoseName | null): void {
    this.forced = name === null ? -1 : poseIndex(name);
  }

  get forcedPose(): HeroPoseName | null {
    return this.forced < 0 ? null : HERO_POSE_NAMES[this.forced];
  }

  /** Jump every spring to its target (no transition); `input` null keeps the current targets. */
  snap(input: HeroPoseInput | null): void {
    if (input) this.computeTargets(input);
    else this.fillRestTargets();
    this.springValue.set(this.target);
    this.springVelocity.fill(0);
    this.offsetValue.set(this.targetOffset);
    this.offsetVelocity.fill(0);
    this.lookValue.set(this.targetLook);
    this.lookVelocity.fill(0);
    this.compose(input);
  }

  update(dt: number, input: HeroPoseInput): void {
    const step = clamp(finite(dt), 0, 0.25);
    this.time += step;
    this.eventAge.burst += step;
    this.eventAge.glance += step;
    this.computeTargets(input);
    this.stepSprings(step);
    this.compose(input);
  }

  private fillRestTargets(): void {
    // Before the first input: the hover pose.
    this.weights.fill(0);
    this.weights[poseIndex('hover')] = 1;
    const p = poseIndex('hover');
    for (let i = 0; i < JOINT_COUNT * 4; i++) this.target[i] = this.poseQuats[p * JOINT_COUNT * 4 + i];
    for (let k = 0; k < 3; k++) this.targetOffset[k] = this.poseOffsets[p * 3 + k];
    this.targetLook.fill(0);
  }

  private computeFlightWeights(input: HeroPoseInput): void {
    const T = this.tuning;
    const f = this.flightWeights;
    f.fill(0);
    const hover = clamp(finite(input.hoverBlend, 1), 0, 1);
    const fly = 1 - hover;
    const brake = fly * clamp(finite(input.brake), 0, 1);
    const rest = fly - brake;
    const dive = rest * smoothstep(T.dive.start, T.dive.full, -finite(input.pitch));
    const level = rest - dive;
    const boost = level * clamp(finite(input.boostBlend), 0, 1);
    f[poseIndex('hover')] = hover;
    f[poseIndex('brake')] = brake;
    f[poseIndex('dive')] = dive;
    f[poseIndex('boost')] = boost;
    f[poseIndex('cruise')] = level - boost;
  }

  private computeOverrideWeights(input: HeroPoseInput): number {
    const T = this.tuning;
    const o = this.overrideWeights;
    o.fill(0);
    if (this.forced >= 0) {
      o[this.forced] = 1;
      return 1;
    }
    let total = 0;
    const add = (entry: HeroActionPose | null | undefined): void => {
      if (!entry) return;
      const share = Math.min(clamp(entry.weight, 0, 1), 1 - total);
      o[poseIndex(entry.pose)] += share;
      total += share;
    };
    const actions = input.actions ?? IDLE_ACTIONS;
    add(T.actions.slam[actions.slam]);
    add(T.actions.grab[actions.grab]);
    const burst = eventEnvelope(this.eventAge.burst, T.events.burst.duration, T.events.burst.rise, T.events.burst.hold);
    const glance = eventEnvelope(this.eventAge.glance, T.events.glance.duration, T.events.glance.rise, T.events.glance.hold);
    const room = 1 - total;
    const events = burst + glance;
    const scale = events > 1 ? 1 / events : 1;
    o[poseIndex('burst')] += burst * scale * room;
    o[poseIndex('glance')] += glance * scale * room;
    total += events * scale * room;
    return total;
  }

  private computeTargets(input: HeroPoseInput): void {
    this.computeFlightWeights(input);
    const override = this.computeOverrideWeights(input);
    const f = this.flightWeights;
    const o = this.overrideWeights;
    let sum = 0;
    for (let p = 0; p < POSE_COUNT; p++) {
      this.weights[p] = f[p] * (1 - override) + o[p];
      sum += this.weights[p];
    }
    for (let p = 0; p < POSE_COUNT; p++) this.weights[p] = sum > 0 ? this.weights[p] / sum : 0;

    // Per joint: overrides that leave a joint out hand their share back to the flight poses.
    // The body pivot offset blends with the body joint's weights.
    this.targetOffset.fill(0);
    for (let j = 0; j < JOINT_COUNT; j++) {
      let missing = 0;
      for (let p = 0; p < POSE_COUNT; p++) if (o[p] > 0 && !this.defines[p * JOINT_COUNT + j]) missing += o[p];
      let x = 0;
      let y = 0;
      let z = 0;
      let w = 0;
      for (let p = 0; p < POSE_COUNT; p++) {
        let e = f[p] * (1 - override + missing);
        if (o[p] > 0 && this.defines[p * JOINT_COUNT + j]) e += o[p];
        if (e <= 0) continue;
        if (j === 0) for (let k = 0; k < 3; k++) this.targetOffset[k] += this.poseOffsets[p * 3 + k] * e;
        const q = (p * JOINT_COUNT + j) * 4;
        x += this.poseQuats[q] * e;
        y += this.poseQuats[q + 1] * e;
        z += this.poseQuats[q + 2] * e;
        w += this.poseQuats[q + 3] * e;
      }
      const t = j * 4;
      this.target[t] = x;
      this.target[t + 1] = y;
      this.target[t + 2] = z;
      this.target[t + 3] = w;
      quatNormalize(this.target, t);
    }

    // Look: toward the target, else into the turn.
    const L = this.tuning.look;
    const look = input.look;
    const turnYaw = clamp(finite(input.yawRate) * L.turnLead, -L.maxYaw, L.maxYaw);
    let yaw = turnYaw;
    let pitch = 0;
    if (look) {
      const weight = clamp(finite(look.weight), 0, 1);
      const x = finite(look.x);
      const y = finite(look.y);
      const z = finite(look.z);
      const flat = Math.sqrt(x * x + z * z);
      if (weight > 0 && flat + Math.abs(y) > 1e-9) {
        const wantYaw = clamp(Math.atan2(x, z), -L.maxYaw, L.maxYaw);
        const wantPitch = clamp(Math.atan2(y, flat), -L.maxPitch, L.maxPitch);
        yaw = turnYaw + (wantYaw - turnYaw) * weight;
        pitch = wantPitch * weight;
      }
    }
    this.targetLook[0] = yaw;
    this.targetLook[1] = pitch;
  }

  private stepSprings(dt: number): void {
    const S = this.tuning.springs;
    const k = this.coefficients;
    const zeta = S.dampingRatio;
    springCoefficients(S.core, zeta, dt, k, 0);
    springCoefficients(S.limb, zeta, dt, k, 4);
    springCoefficients(S.hand, zeta, dt, k, 8);
    springCoefficients(S.head, zeta, dt, k, 12);
    springCoefficients(S.offset, zeta, dt, k, 16);
    springCoefficients(S.look, zeta, dt, k, 20);
    for (let j = 0; j < JOINT_COUNT; j++) {
      const t = j * 4;
      // Follow the target on the near hemisphere (q and −q are the same rotation).
      const sign = quatDot(this.springValue, t, this.target, t) < 0 ? -1 : 1;
      const g = this.jointGroup[j] * 4;
      for (let c = 0; c < 4; c++) {
        const i = t + c;
        const goal = this.target[i] * sign;
        const y = this.springValue[i] - goal;
        const v = this.springVelocity[i];
        this.springValue[i] = goal + k[g] * y + k[g + 1] * v;
        this.springVelocity[i] = k[g + 2] * y + k[g + 3] * v;
      }
    }
    for (let c = 0; c < 3; c++) {
      const y = this.offsetValue[c] - this.targetOffset[c];
      const v = this.offsetVelocity[c];
      this.offsetValue[c] = this.targetOffset[c] + k[16] * y + k[17] * v;
      this.offsetVelocity[c] = k[18] * y + k[19] * v;
    }
    for (let c = 0; c < 2; c++) {
      const y = this.lookValue[c] - this.targetLook[c];
      const v = this.lookVelocity[c];
      this.lookValue[c] = this.targetLook[c] + k[20] * y + k[21] * v;
      this.lookVelocity[c] = k[22] * y + k[23] * v;
    }
  }

  /** Springs → normalised rotations, then additive layers and the head look. */
  private compose(input: HeroPoseInput | null): void {
    const out = this.rotations;
    out.set(this.springValue);
    for (let j = 0; j < JOINT_COUNT; j++) quatNormalize(out, j * 4);
    for (let k = 0; k < 3; k++) this.offset[k] = this.offsetValue[k];
    this.look[0] = this.lookValue[0];
    this.look[1] = this.lookValue[1];
    if (!input) return;

    const A = this.tuning.layers;
    const t = this.time;
    const hover = this.weights[poseIndex('hover')];
    const fly = 1 - clamp(finite(input.hoverBlend, 1), 0, 1);
    const bank = clamp(finite(input.bank), -1.6, 1.6);
    const steer = clamp(finite(input.steerX), -1, 1);
    const boost = clamp(finite(input.boostBlend), 0, 1);
    const breath = Math.sin(t * A.breathRate) * A.breathDepth * hover;
    const flutter = Math.sin(t * A.flutterRate) * A.flutterDepth * boost * fly;
    const sway = Math.sin(t * 1.1) * A.idleSway * hover;

    this.addRotation(J.spine2, breath, 0, -bank * A.bankLean * fly);
    this.addRotation(J.clavicleL, 0, 0, breath * 0.6);
    this.addRotation(J.clavicleR, 0, 0, -breath * 0.6);
    this.addRotation(J.hipL, 0, 0, bank * A.bankHips * fly + flutter);
    this.addRotation(J.hipR, sway, 0, bank * A.bankHips * fly - flutter);
    this.addRotation(J.ankleL, flutter * 2, 0, 0);
    this.addRotation(J.ankleR, -flutter * 2, 0, 0);
    this.addRotation(J.shoulderR, 0, 0, -steer * A.steerDrift * fly);
    this.addRotation(J.shoulderL, 0, 0, -steer * A.steerDrift * 0.5 * fly);
    this.offset[1] += Math.sin(t * A.bobRate) * A.bobHeight * hover;

    this.applyLook(this.look[0], this.look[1]);
  }

  /** rotations[j] = rotations[j] * euler(x, y, z) (a local additive turn). */
  private addRotation(j: number, x: number, y: number, z: number): void {
    if (x === 0 && y === 0 && z === 0) return;
    quatFromEulerXYZ(this.scratch, 0, x, y, z);
    quatMultiply(this.rotations, j * 4, this.rotations, j * 4, this.scratch, 0);
  }

  /** Turn neck and head by (yaw, pitch) about the hero root's up and right axes. */
  private applyLook(yaw: number, pitch: number): void {
    if (yaw === 0 && pitch === 0) return;
    const R = this.rotations;
    const share = this.tuning.look.neckShare;
    const frame = this.frame;
    // Orientation of the neck's parent in the root frame: body · spine · spine2 · chest.
    frame.set(R.subarray(J.body * 4, J.body * 4 + 4), 0);
    quatMultiply(frame, 0, frame, 0, R, J.spine * 4);
    quatMultiply(frame, 0, frame, 0, R, J.spine2 * 4);
    quatMultiply(frame, 0, frame, 0, R, J.chest * 4);
    // Turn in the root frame: yaw about +Y, then pitch (up = positive) about +X.
    quatFromEulerXYZ(this.scratch, 8, -pitch * share, 0, 0);
    quatFromEulerXYZ(this.scratch, 12, 0, yaw * share, 0);
    quatMultiply(frame, 4, this.scratch, 12, this.scratch, 8);
    quatRotateInFrame(R, J.neck * 4, frame, 0, frame, 4, R, J.neck * 4, this.scratch);
    quatNormalize(R, J.neck * 4);
    // Then the head, in its new parent frame.
    quatMultiply(frame, 0, frame, 0, R, J.neck * 4);
    quatFromEulerXYZ(this.scratch, 8, -pitch * (1 - share), 0, 0);
    quatFromEulerXYZ(this.scratch, 12, 0, yaw * (1 - share), 0);
    quatMultiply(frame, 4, this.scratch, 12, this.scratch, 8);
    quatRotateInFrame(R, J.head * 4, frame, 0, frame, 4, R, J.head * 4, this.scratch);
    quatNormalize(R, J.head * 4);
  }

  /** The quaternion a pose gives a joint (x, y, z, w), for tests and tooling. */
  poseRotation(pose: HeroPoseName, joint: HeroPoseJoint): [number, number, number, number] {
    const o = (poseIndex(pose) * JOINT_COUNT + jointIndex(joint)) * 4;
    return [this.poseQuats[o], this.poseQuats[o + 1], this.poseQuats[o + 2], this.poseQuats[o + 3]];
  }

  /** The current spring target for a joint (x, y, z, w). */
  targetRotation(joint: HeroPoseJoint): [number, number, number, number] {
    const o = jointIndex(joint) * 4;
    return [this.target[o], this.target[o + 1], this.target[o + 2], this.target[o + 3]];
  }
}
