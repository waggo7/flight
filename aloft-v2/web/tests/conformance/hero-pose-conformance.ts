import {
  HERO_POSE_JOINTS, HERO_POSE_NAMES, HeroPoseGraph, IDLE_ACTIONS,
  type HeroPoseEvent, type HeroPoseInput, type HeroPoseLibrary, type HeroPoseName,
} from '../../src/core/hero-pose-graph';

// Golden vectors for the hero pose graph: scripted flight / power state, events and forced
// poses in; weights, joint rotations, body offset and look angles out. The web tests replay them
// against the TS graph; godot/tests/conformance_runner.gd replays them against the GDScript port.
// Regenerate with `npm run conformance:write` only when behaviour changes on purpose.

export interface PoseSegment {
  steps: number;
  /** Step size for this segment (default: the file's dt). */
  dt?: number;
  input: HeroPoseInput;
  /** Fired before the segment's first step. */
  event?: HeroPoseEvent;
  /** Set before the segment's first step (null releases a forced pose). */
  force?: HeroPoseName | null;
}

export interface PoseCaseInput {
  name: string;
  /** Jump the springs to the first segment's input before stepping. */
  snap: boolean;
  segments: PoseSegment[];
}

export interface PoseSample {
  step: number;
  weights: number[];
  rotations: number[];
  offset: number[];
  look: number[];
}

export interface PoseCase extends PoseCaseInput {
  samples: PoseSample[];
}

export interface PoseConformanceFile {
  module: 'hero-pose-graph';
  version: 1;
  dt: number;
  sampleEvery: number;
  tolerance: { absolute: number; relative: number };
  joints: string[];
  poses: string[];
  library: HeroPoseLibrary;
  cases: PoseCase[];
}

export const POSE_DT = 1 / 60;
export const POSE_SAMPLE_EVERY = 15;

const HOVER: HeroPoseInput = {
  hoverBlend: 1, boostBlend: 0, speedShare: 0, pitch: 0, bank: 0, yawRate: 0, steerX: 0, brake: 0, actions: { ...IDLE_ACTIONS }, look: null,
};
const input = (changes: Partial<HeroPoseInput>): HeroPoseInput => ({ ...HOVER, ...changes });
const CRUISE = input({ hoverBlend: 0, speedShare: 0.31 });
const withActions = (base: HeroPoseInput, slam: HeroPoseInput['actions']['slam'], grab: HeroPoseInput['actions']['grab']): HeroPoseInput => ({ ...base, actions: { slam, grab } });

export const POSE_CASES: PoseCaseInput[] = [
  { name: 'hover-breathing', snap: true, segments: [{ steps: 180, input: HOVER }] },
  {
    name: 'launch-cruise-steer', snap: true,
    segments: [{ steps: 30, input: HOVER }, { steps: 90, input: CRUISE }, { steps: 90, input: { ...CRUISE, steerX: 0.7, bank: 0.35, yawRate: 0.6 } }],
  },
  {
    name: 'boost-bank-flutter', snap: true,
    segments: [{ steps: 60, input: CRUISE }, { steps: 150, input: { ...CRUISE, boostBlend: 1, speedShare: 1, bank: -0.8, steerX: -1, yawRate: -0.9 } }],
  },
  {
    name: 'dive-and-pull-up', snap: true,
    segments: [{ steps: 45, input: CRUISE }, { steps: 120, input: { ...CRUISE, pitch: -1.1, speedShare: 0.8 } }, { steps: 90, input: { ...CRUISE, pitch: 0.8 } }],
  },
  {
    name: 'brake-into-hover', snap: true,
    segments: [
      { steps: 60, input: { ...CRUISE, boostBlend: 1 } },
      { steps: 45, input: { ...CRUISE, brake: 1 } },
      { steps: 30, input: input({ hoverBlend: 0.5, brake: 1 }) },
      { steps: 90, input: HOVER },
    ],
  },
  {
    name: 'burst-then-glance', snap: true,
    segments: [
      { steps: 30, input: CRUISE },
      { steps: 60, input: CRUISE, event: 'burst' },
      { steps: 20, input: CRUISE, event: 'glance' },
      { steps: 20, input: CRUISE, event: 'burst' },
      { steps: 60, input: CRUISE },
    ],
  },
  {
    name: 'slam-sequence', snap: true,
    segments: [
      { steps: 40, input: withActions(input({ hoverBlend: 0.6 }), 'windup', 'empty') },
      { steps: 30, input: withActions({ ...CRUISE, pitch: -1.3 }, 'dive', 'empty') },
      { steps: 30, input: withActions(HOVER, 'impact', 'empty') },
      { steps: 45, input: withActions(HOVER, 'recover', 'empty') },
      { steps: 45, input: withActions(HOVER, 'cooldown', 'empty') },
    ],
  },
  {
    name: 'grab-hold-throw', snap: true,
    segments: [
      { steps: 30, input: withActions(input({ hoverBlend: 0.3 }), 'ready', 'reaching') },
      { steps: 60, input: withActions(CRUISE, 'ready', 'holding') },
      { steps: 30, input: withActions(input({ hoverBlend: 0.8 }), 'ready', 'windup') },
      { steps: 30, input: withActions(input({ hoverBlend: 0.8 }), 'ready', 'release') },
      { steps: 45, input: withActions(input({ hoverBlend: 0.8 }), 'ready', 'empty') },
    ],
  },
  {
    name: 'look-around', snap: true,
    segments: [
      { steps: 45, input: input({ look: { x: 1, y: 0.2, z: 1, weight: 1 } }) },
      { steps: 45, input: input({ look: { x: -3, y: -1, z: 0.5, weight: 0.7 } }) },
      { steps: 45, input: { ...CRUISE, yawRate: 1.2, look: { x: 0.1, y: 2, z: 1, weight: 1 } } },
      { steps: 45, input: { ...CRUISE, yawRate: -0.8 } },
    ],
  },
  {
    name: 'forced-poses', snap: false,
    segments: [
      { steps: 30, input: HOVER, force: 'slamLand' },
      { steps: 30, input: HOVER, force: 'hold' },
      { steps: 30, input: CRUISE, force: 'throwWindup' },
      { steps: 30, input: CRUISE, force: 'glance' },
      { steps: 30, input: CRUISE, force: null },
    ],
  },
  {
    name: 'coarse-steps', snap: true,
    segments: [
      { steps: 20, dt: 1 / 20, input: { ...CRUISE, boostBlend: 0.7, bank: 0.5 } },
      { steps: 30, dt: 1 / 144, input: withActions(HOVER, 'windup', 'empty') },
      { steps: 10, dt: 0.25, input: withActions(CRUISE, 'impact', 'holding') },
    ],
  },
];

export function runPoseCase(input: PoseCaseInput, library: HeroPoseLibrary, dt = POSE_DT): PoseSample[] {
  const graph = new HeroPoseGraph(library);
  if (input.snap) graph.snap(input.segments[0]!.input);
  const samples: PoseSample[] = [];
  let step = 0;
  for (const segment of input.segments) {
    if (segment.force !== undefined) graph.force(segment.force);
    if (segment.event) graph.trigger(segment.event);
    for (let i = 0; i < segment.steps; i++) {
      graph.update(segment.dt ?? dt, segment.input);
      step++;
      if (step % POSE_SAMPLE_EVERY === 0) {
        samples.push({
          step,
          weights: Array.from(graph.weights),
          rotations: Array.from(graph.rotations),
          offset: Array.from(graph.offset),
          look: Array.from(graph.look),
        });
      }
    }
  }
  return samples;
}

/** A deep copy without "$notes" keys (the vectors carry data only). */
export function withoutNotes<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutNotes) as T;
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('$')).map(([key, child]) => [key, withoutNotes(child)])) as T;
}

export function buildPoseConformance(library: HeroPoseLibrary): PoseConformanceFile {
  return {
    module: 'hero-pose-graph',
    version: 1,
    dt: POSE_DT,
    sampleEvery: POSE_SAMPLE_EVERY,
    tolerance: { absolute: 1e-8, relative: 1e-8 },
    joints: [...HERO_POSE_JOINTS],
    poses: [...HERO_POSE_NAMES],
    library: withoutNotes(library),
    cases: POSE_CASES.map((c) => ({ ...c, samples: runPoseCase(c, library) })),
  };
}
