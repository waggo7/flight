import { describe, expect, test } from 'vitest';
import {
  eventEnvelope, GRAB_PHASES, HERO_POSE_JOINTS, HERO_POSE_NAMES, HeroPoseGraph, IDLE_ACTIONS, jointIndex, poseIndex, SLAM_PHASES, springCoefficients,
  type HeroPoseInput, type HeroPoseName,
} from '../../src/core/hero-pose-graph';
import { quatMultiply } from '../../src/core/joint-rotation';
import { loadContent } from '../../src/engine/content-library';

const library = loadContent().poses;
const DT = 1 / 60;

const HOVER: HeroPoseInput = {
  hoverBlend: 1, boostBlend: 0, speedShare: 0, pitch: 0, bank: 0, yawRate: 0, steerX: 0, brake: 0, actions: { ...IDLE_ACTIONS }, look: null,
};
const CRUISE: HeroPoseInput = { ...HOVER, hoverBlend: 0, speedShare: 0.3 };

/** A small seeded generator (tests only; the game uses engine/random-streams). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function run(graph: HeroPoseGraph, input: HeroPoseInput, seconds: number, dt = DT): void {
  for (let t = 0; t < seconds; t += dt) graph.update(dt, input);
}

function rotation(graph: HeroPoseGraph, joint: (typeof HERO_POSE_JOINTS)[number]): number[] {
  const o = jointIndex(joint) * 4;
  return Array.from(graph.rotations.subarray(o, o + 4));
}

/** Angle between two unit quaternions, radians. */
function angleBetween(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot));
}

function expectWeightsValid(graph: HeroPoseGraph): void {
  let sum = 0;
  for (const w of graph.weights) {
    expect(w).toBeGreaterThanOrEqual(0);
    expect(w).toBeLessThanOrEqual(1 + 1e-12);
    sum += w;
  }
  expect(sum).toBeCloseTo(1, 10);
}

describe('hero pose graph', () => {
  test('the pose library has all 13 poses over 25 joints (24 + the body pivot)', () => {
    expect(Object.keys(library.poses).sort()).toEqual([...HERO_POSE_NAMES].sort());
    expect(HERO_POSE_JOINTS).toHaveLength(25);
    expect(() => new HeroPoseGraph(library)).not.toThrow();
  });

  test('weights stay in [0, 1] and sum to 1, and nothing goes NaN, over a long random run', () => {
    const graph = new HeroPoseGraph(library);
    const random = lcg(7);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
    let input: HeroPoseInput = { ...HOVER };
    for (let i = 0; i < 20_000; i++) {
      if (i % 37 === 0) {
        input = {
          hoverBlend: random(), boostBlend: random(), speedShare: random(), pitch: (random() - 0.5) * 2.6,
          bank: (random() - 0.5) * 2.4, yawRate: (random() - 0.5) * 4, steerX: random() * 2 - 1, brake: random() < 0.2 ? 1 : 0,
          actions: { slam: pick(SLAM_PHASES), grab: pick(GRAB_PHASES) },
          look: random() < 0.5 ? null : { x: random() - 0.5, y: random() - 0.5, z: random() - 0.5, weight: random() },
        };
      }
      if (i % 211 === 0) graph.trigger(random() < 0.5 ? 'burst' : 'glance');
      if (i % 997 === 0) graph.force(random() < 0.3 ? pick(HERO_POSE_NAMES) : null);
      graph.update(random() < 0.01 ? 0.25 : DT * (0.5 + random()), input);
      if (i % 50 === 0) expectWeightsValid(graph);
    }
    expect(Array.from(graph.rotations).every(Number.isFinite)).toBe(true);
    expect(Array.from(graph.offset).every(Number.isFinite)).toBe(true);
    for (let j = 0; j < HERO_POSE_JOINTS.length; j++) {
      const q = graph.rotations.subarray(j * 4, j * 4 + 4);
      expect(Math.hypot(...q)).toBeCloseTo(1, 9);
    }
  });

  test('garbage input (NaN, Infinity, zero-length look) stays finite', () => {
    const graph = new HeroPoseGraph(library);
    const bad: HeroPoseInput = {
      hoverBlend: NaN, boostBlend: Infinity, speedShare: -Infinity, pitch: NaN, bank: Infinity, yawRate: NaN, steerX: NaN, brake: NaN,
      actions: { ...IDLE_ACTIONS }, look: { x: 0, y: 0, z: 0, weight: 1 },
    };
    for (let i = 0; i < 120; i++) graph.update(i % 2 ? NaN : DT, bad);
    expectWeightsValid(graph);
    expect(Array.from(graph.rotations).every(Number.isFinite)).toBe(true);
  });

  test('the spring settles with a small overshoot (≤ 5%) for every joint group and step size', () => {
    const { springs } = library.graph;
    const k = new Float64Array(4);
    for (const omega of [springs.core, springs.limb, springs.hand, springs.head, springs.offset, springs.look]) {
      for (const dt of [1 / 240, 1 / 60, 1 / 30, 0.1]) {
        springCoefficients(omega, springs.dampingRatio, dt, k);
        let x = 0;
        let v = 0;
        let peak = 0;
        for (let t = 0; t < 4; t += dt) {
          const y = x - 1;
          x = 1 + k[0] * y + k[1] * v;
          v = k[2] * y + k[3] * v;
          peak = Math.max(peak, x);
        }
        expect(peak - 1, `ω ${omega}, dt ${dt}`).toBeLessThanOrEqual(0.05);
        expect(peak - 1, `ω ${omega} should overshoot a little`).toBeGreaterThan(0.001);
        expect(Math.abs(x - 1)).toBeLessThan(1e-3);
      }
    }
    // A critically damped spring (ζ = 1) never overshoots.
    springCoefficients(10, 1, DT, k);
    let x = 0;
    let v = 0;
    for (let i = 0; i < 240; i++) {
      const y = x - 1;
      x = 1 + k[0] * y + k[1] * v;
      v = k[2] * y + k[3] * v;
      expect(x).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  test('hover → cruise: each joint overshoots its new pose by at most 5% of the swing, and arrives', () => {
    const graph = new HeroPoseGraph(library);
    graph.snap(HOVER);
    const start = HERO_POSE_JOINTS.map((joint) => rotation(graph, joint));
    const peak = HERO_POSE_JOINTS.map(() => 0);
    const goal = HERO_POSE_JOINTS.map((joint) => graph.poseRotation('cruise', joint));
    for (let i = 0; i < 180; i++) {
      graph.update(DT, CRUISE);
      HERO_POSE_JOINTS.forEach((joint, j) => {
        const current = rotation(graph, joint);
        const swing = angleBetween(start[j]!, goal[j]!);
        if (swing < 0.1) return;
        // Past the goal = moving away from the start by more than the swing.
        const beyond = angleBetween(start[j]!, current) - swing;
        peak[j] = Math.max(peak[j]!, beyond / swing);
      });
    }
    HERO_POSE_JOINTS.forEach((joint, j) => {
      expect(peak[j]!, joint).toBeLessThanOrEqual(0.05);
      // Additive layers are off in level cruise with no bank, steer or boost.
      expect(angleBetween(rotation(graph, joint), goal[j]!), joint).toBeLessThan(0.01);
    });
  });

  for (const name of HERO_POSE_NAMES) {
    test(`forcing "${name}" reaches the pose`, () => {
      const graph = new HeroPoseGraph(library);
      graph.force(name);
      run(graph, HOVER, 3);
      expect(graph.weights[poseIndex(name)]).toBeCloseTo(1, 12);
      const pose = library.poses[name];
      for (const joint of HERO_POSE_JOINTS) {
        const hand = joint.startsWith('fingers') || joint.startsWith('thumb') ? (joint.endsWith('L') ? pose.handL : pose.handR) : null;
        const defined = pose.full || joint in pose.joints || !!hand;
        // Upper-body poses leave the rest to the flight pose (here: hover).
        const expected = defined ? graph.poseRotation(name, joint) : graph.poseRotation('hover', joint);
        // Hover breathes and sways a little; everything else holds still.
        const tolerance = name === 'hover' || !pose.full ? 0.06 : 0.01;
        expect(angleBetween(rotation(graph, joint), expected), `${name}.${joint}`).toBeLessThan(tolerance);
      }
      const offset = pose.offset ?? [0, 0, 0];
      expect(graph.offset[1]).toBeCloseTo(offset[1]!, 1);
    });
  }

  test('flight state picks the flight poses', () => {
    const graph = new HeroPoseGraph(library);
    const weightsFor = (input: Partial<HeroPoseInput>): Record<HeroPoseName, number> => {
      graph.update(DT, { ...HOVER, ...input });
      return Object.fromEntries(HERO_POSE_NAMES.map((name, i) => [name, graph.weights[i]!])) as Record<HeroPoseName, number>;
    };
    expect(weightsFor({}).hover).toBe(1);
    expect(weightsFor({ hoverBlend: 0 }).cruise).toBe(1);
    expect(weightsFor({ hoverBlend: 0, boostBlend: 1 }).boost).toBe(1);
    expect(weightsFor({ hoverBlend: 0, boostBlend: 1, pitch: -1.2 }).dive).toBe(1);
    expect(weightsFor({ hoverBlend: 0, brake: 1 }).brake).toBe(1);
    const half = weightsFor({ hoverBlend: 0.5, boostBlend: 0.5 });
    expect(half.hover).toBeCloseTo(0.5);
    expect(half.boost).toBeCloseTo(0.25);
    expect(half.cruise).toBeCloseTo(0.25);
  });

  test('power phases override the flight poses; upper-body poses leave the legs to flight', () => {
    const graph = new HeroPoseGraph(library);
    graph.update(DT, { ...CRUISE, actions: { slam: 'impact', grab: 'empty' } });
    expect(graph.weights[poseIndex('slamLand')]).toBe(1);
    graph.update(DT, { ...CRUISE, actions: { slam: 'recover', grab: 'empty' } });
    expect(graph.weights[poseIndex('slamLand')]).toBeCloseTo(0.55);
    expect(graph.weights[poseIndex('cruise')]).toBeCloseTo(0.45);

    graph.snap({ ...CRUISE, actions: { slam: 'ready', grab: 'holding' } });
    expect(graph.weights[poseIndex('hold')]).toBe(1);
    expect(angleBetween(graph.targetRotation('shoulderL'), graph.poseRotation('hold', 'shoulderL'))).toBeLessThan(1e-9);
    expect(angleBetween(graph.targetRotation('kneeL'), graph.poseRotation('cruise', 'kneeL'))).toBeLessThan(1e-9);
    expect(angleBetween(graph.targetRotation('body'), graph.poseRotation('cruise', 'body'))).toBeLessThan(1e-9);
  });

  test('burst and glance are pulses that rise, hold and fade', () => {
    const { burst } = library.graph.events;
    expect(eventEnvelope(0, burst.duration, burst.rise, burst.hold)).toBe(0);
    expect(eventEnvelope(burst.duration * 0.3, burst.duration, burst.rise, burst.hold)).toBe(1);
    expect(eventEnvelope(burst.duration, burst.duration, burst.rise, burst.hold)).toBe(0);
    const graph = new HeroPoseGraph(library);
    graph.update(DT, CRUISE);
    graph.trigger('burst');
    let peak = 0;
    for (let t = 0; t < burst.duration + 0.1; t += DT) {
      graph.update(DT, CRUISE);
      peak = Math.max(peak, graph.weights[poseIndex('burst')]!);
    }
    expect(peak).toBeCloseTo(1, 6);
    expect(graph.weights[poseIndex('burst')]).toBe(0);
    expect(graph.weights[poseIndex('cruise')]).toBe(1);
  });

  test('the head turns toward a look target, within its limits', () => {
    const graph = new HeroPoseGraph(library);
    // Face direction in the root frame = body·spine·spine2·chest·neck·head applied to +Z.
    const faceYaw = (): number => {
      const chain = ['body', 'spine', 'spine2', 'chest', 'neck', 'head'] as const;
      const q = [0, 0, 0, 1];
      for (const joint of chain) quatMultiply(q, 0, q, 0, graph.rotations, jointIndex(joint) * 4);
      const [x, y, z, w] = q as [number, number, number, number];
      // Rotate (0, 0, 1) by q.
      const fx = 2 * (x * z + w * y);
      const fz = 1 - 2 * (x * x + y * y);
      return Math.atan2(fx, fz);
    };
    graph.snap(HOVER);
    const straight = faceYaw();
    run(graph, { ...HOVER, look: { x: 1, y: 0, z: 1, weight: 1 } }, 3);
    expect(faceYaw() - straight).toBeCloseTo(Math.PI / 4, 1);
    run(graph, { ...HOVER, look: { x: -1, y: 0, z: -0.2, weight: 1 } }, 3);
    expect(faceYaw() - straight).toBeCloseTo(-library.graph.look.maxYaw, 1);
    expect(graph.look[0]).toBeCloseTo(-library.graph.look.maxYaw, 2);
  });

  test('an update takes well under the rig budget', () => {
    const graph = new HeroPoseGraph(library);
    const input: HeroPoseInput = { ...CRUISE, bank: 0.3, steerX: 0.4, boostBlend: 0.6, look: { x: 0.3, y: 0.1, z: 1, weight: 1 } };
    for (let i = 0; i < 500; i++) graph.update(DT, input);
    const started = performance.now();
    const runs = 5000;
    for (let i = 0; i < runs; i++) graph.update(DT, input);
    const ms = (performance.now() - started) / runs;
    expect(ms).toBeLessThan(0.05);
  });
});
