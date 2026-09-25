import { FlightModel, type FlightControls, type FlightEvent } from '../../src/core/flight-model';
import type { FlightTuning } from '../../src/core/flight-tuning';
import { Vector3 } from '../../src/core/math';
import { createBoxWorld, type BoxSpec, type SmashBehaviour, type Vec3Tuple } from './box-world';

// Golden vectors for the flight model: scripted inputs in, sampled state out. The web tests
// replay them against the TS model; godot/tests/conformance_runner.gd replays them against
// the GDScript port. Regenerate with `npm run conformance:write` only when behaviour changes
// on purpose.

export interface FlightCaseInput {
  name: string;
  tower: BoxSpec | null;
  smash: SmashBehaviour;
  start: { position: Vec3Tuple; yaw: number; launch: boolean };
  segments: { steps: number; controls: FlightControls }[];
}

export interface FlightSample {
  step: number;
  position: Vec3Tuple;
  velocity: Vec3Tuple;
  yaw: number;
  pitch: number;
  bank: number;
  yawRate: number;
  speed: number;
  mode: string;
  hoverBlend: number;
  boostBlend: number;
  surfaceRush: number;
  groundClearance: number;
  overWater: boolean;
}

export interface FlightEventSample {
  step: number;
  type: FlightEvent['type'];
  detail?: string;
}

export interface FlightCase extends FlightCaseInput {
  samples: FlightSample[];
  events: FlightEventSample[];
}

export interface FlightConformanceFile {
  module: 'flight-model';
  version: 1;
  dt: number;
  sampleEvery: number;
  tolerance: { absolute: number; relative: number };
  tuning: FlightTuning;
  cases: FlightCase[];
}

export const DT = 1 / 60;
export const SAMPLE_EVERY = 30;

const idle: FlightControls = { steerX: 0, steerY: 0, boost: false, brake: false };
const withControls = (c: Partial<FlightControls>): FlightControls => ({ ...idle, ...c });
const TOWER: BoxSpec = { min: [-20, 0, 60], max: [20, 400, 100] };

export const FLIGHT_CASES: FlightCaseInput[] = [
  { name: 'launch-cruise', tower: null, smash: 'none', start: { position: [0, 300, 0], yaw: 0, launch: true }, segments: [{ steps: 360, controls: idle }] },
  {
    name: 'boost-boom-glide', tower: null, smash: 'none', start: { position: [0, 300, 0], yaw: 0.4, launch: true },
    segments: [{ steps: 120, controls: idle }, { steps: 240, controls: withControls({ boost: true }) }, { steps: 360, controls: idle }],
  },
  {
    name: 'turn-right-bank', tower: null, smash: 'none', start: { position: [0, 300, 0], yaw: 0, launch: true },
    segments: [{ steps: 120, controls: idle }, { steps: 90, controls: withControls({ steerX: 1 }) }, { steps: 120, controls: idle }],
  },
  {
    name: 'pitch-and-level', tower: null, smash: 'none', start: { position: [0, 300, 0], yaw: -1, launch: true },
    segments: [{ steps: 180, controls: withControls({ steerY: 1 }) }, { steps: 180, controls: idle }],
  },
  {
    name: 'dive-then-climb', tower: null, smash: 'none', start: { position: [0, 2300, 0], yaw: 2, launch: true },
    segments: [{ steps: 300, controls: withControls({ steerY: -1 }) }, { steps: 300, controls: withControls({ steerY: 1, steerX: -0.4 }) }],
  },
  {
    name: 'brake-hover-relaunch', tower: null, smash: 'none', start: { position: [0, 300, 0], yaw: 0, launch: true },
    segments: [
      { steps: 180, controls: withControls({ boost: true }) },
      { steps: 300, controls: withControls({ brake: true }) },
      { steps: 6, controls: withControls({ boost: true }) },
      { steps: 120, controls: idle },
    ],
  },
  {
    name: 'hover-climb-turn', tower: null, smash: 'none', start: { position: [0, 80, 0], yaw: 0.3, launch: false },
    segments: [{ steps: 120, controls: withControls({ steerY: 1, steerX: 0.5 }) }, { steps: 90, controls: withControls({ steerY: -0.6 }) }],
  },
  {
    name: 'sea-skim', tower: null, smash: 'none', start: { position: [0, 60, 0], yaw: 0, launch: true },
    segments: [{ steps: 360, controls: withControls({ steerY: -1, boost: true }) }, { steps: 120, controls: idle }],
  },
  {
    name: 'tower-glance', tower: TOWER, smash: 'none', start: { position: [5, 100, 0], yaw: 0, launch: true },
    segments: [{ steps: 240, controls: withControls({ boost: true }) }],
  },
  {
    name: 'tower-burst', tower: TOWER, smash: 'burst', start: { position: [0, 100, -300], yaw: 0, launch: true },
    segments: [{ steps: 300, controls: withControls({ boost: true }) }],
  },
  {
    name: 'tower-dent', tower: TOWER, smash: 'dent', start: { position: [0, 100, 20], yaw: 0, launch: true },
    segments: [{ steps: 180, controls: idle }],
  },
  {
    name: 'world-edge', tower: null, smash: 'none', start: { position: [0, 300, 5800], yaw: 0, launch: true },
    segments: [{ steps: 900, controls: withControls({ boost: true }) }],
  },
];

const tuple = (v: Vector3): Vec3Tuple => [v.x, v.y, v.z];

function eventDetail(event: FlightEvent): string | undefined {
  if (event.type === 'smash') return event.kind;
  if (event.type === 'impact') return event.dented ? 'dented' : 'glanced';
  return undefined;
}

export function runFlightCase(input: FlightCaseInput, tuning: FlightTuning): { samples: FlightSample[]; events: FlightEventSample[] } {
  const world = createBoxWorld(input.tower ? { min: [...input.tower.min], max: [...input.tower.max] } : null, input.smash);
  const model = new FlightModel(world, tuning);
  model.reset(new Vector3(...input.start.position), input.start.yaw);
  if (input.start.launch) model.launch();
  const samples: FlightSample[] = [];
  const events: FlightEventSample[] = [];
  const record = (step: number): void => {
    for (const event of model.takeEvents()) {
      const detail = eventDetail(event);
      events.push(detail ? { step, type: event.type, detail } : { step, type: event.type });
    }
  };
  record(0);
  let step = 0;
  for (const segment of input.segments) {
    for (let i = 0; i < segment.steps; i++) {
      model.update(DT, segment.controls);
      step++;
      record(step);
      if (step % SAMPLE_EVERY === 0) {
        samples.push({
          step,
          position: tuple(model.position),
          velocity: tuple(model.velocity),
          yaw: model.yaw,
          pitch: model.pitch,
          bank: model.bank,
          yawRate: model.yawRate,
          speed: model.speed,
          mode: model.mode,
          hoverBlend: model.hoverBlend,
          boostBlend: model.boostBlend,
          surfaceRush: model.surfaceRush,
          groundClearance: model.groundClearance,
          overWater: model.overWater,
        });
      }
    }
  }
  return { samples, events };
}

export function buildFlightConformance(tuning: FlightTuning): FlightConformanceFile {
  return {
    module: 'flight-model',
    version: 1,
    dt: DT,
    sampleEvery: SAMPLE_EVERY,
    tolerance: { absolute: 1e-6, relative: 1e-6 },
    tuning,
    cases: FLIGHT_CASES.map((input) => ({ ...input, ...runFlightCase(input, tuning) })),
  };
}
