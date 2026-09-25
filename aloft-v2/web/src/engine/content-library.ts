import cameraJson from '@content/tuning/camera.json';
import flightJson from '@content/tuning/flight.json';
import actionsJson from '@content/input/actions.json';
import inputJson from '@content/tuning/input.json';
import simulationJson from '@content/tuning/simulation.json';
import destructionJson from '@content/tuning/destruction.json';
import type { DestructionTuning } from '../core/destruction-tuning';
import type { CameraTuning, FlightTuning, InputBindings, InputTuning, SimulationTuning } from '../core/flight-tuning';
import { arr, bool, int, num, obj, optional, str, validated, type Rule, type Shape } from './content-validation';

// All engine-neutral content (aloft-v2/content/*.json), validated once at boot. The Godot
// scaffold loads the same files.

export const FLIGHT_SHAPE: Shape = {
  cruiseSpeed: num(1, 400), boostSpeed: num(1, 600), minFlightSpeed: num(0, 200), launchSpeed: num(0, 400),
  hoverThreshold: num(0, 50), diveBonus: num(0, 200), climbPenalty: num(0, 200),
  boostAccel: num(0.1, 500), cruiseAccel: num(0.1, 500), coastDecel: num(0.1, 500), brakeDecel: num(0.1, 500), gravityShare: num(0, 2),
  yawRateSlow: num(0.05, 10), yawRateFast: num(0.05, 10), yawResponse: num(0.1, 50),
  pitchMax: num(0.1, 1.55), pitchResponse: num(0.1, 50), bankMax: num(0, 1.55), bankResponse: num(0.1, 50), bankGain: num(0, 5),
  hoverClimb: num(0, 100), hoverYawRate: num(0, 10),
  radius: num(0.2, 5), maxAltitude: num(100, 20000), worldRadius: num(500, 50000),
  boomSpeedShare: num(0.1, 1), smashSpeedKept: num(0, 1),
};

export const CAMERA_SHAPE: Shape = {
  distance: num(1, 50), boostDistance: num(1, 50), hoverDistance: num(1, 50), height: num(-5, 20),
  lookAhead: num(0, 200), lookLift: num(-10, 10), fov: num(20, 120), boostFov: num(20, 130), firstPersonFov: num(20, 130),
  yawFollow: num(0.1, 50), pitchFollow: num(0.1, 50), pitchShare: num(0, 1), turnLead: num(0, 2), rollShare: num(0, 1),
};

export const INPUT_SHAPE: Shape = {
  mouseRadius: num(0.05, 1), deadZone: num(0, 0.5), curve: num(0.5, 4), keyRise: num(0.1, 50), keyFall: num(0.1, 50),
  touchRadius: num(8, 400), gamepadDeadZone: num(0, 0.6), authorityRamp: num(0, 5),
};

export const SIMULATION_SHAPE: Shape = {
  stepsPerSecond: int(20, 240),
  maxStepsPerFrame: obj({ desktop: int(1, 16), phone: int(1, 16) }),
  maxFrameDelta: num(0.01, 1),
  hitStop: obj({ seconds: num(0, 2), timeScale: num(0, 1) }),
  seed: int(0, 2 ** 31),
  physics: obj({ gravity: num(0, 50), solverIterations: int(1, 16), debrisHitsDebris: obj({ desktop: bool(), phone: bool() }) }),
};

const perStyle = (min: number, max: number): Rule => obj({ glass: num(min, max), stone: num(min, max), plain: num(min, max) });

const perProfile = (min: number, max: number): Rule => obj({ desktop: num(min, max), phone: num(min, max) });
const perProfileInt = (min: number, max: number): Rule => obj({ desktop: int(min, max), phone: int(min, max) });

export const DESTRUCTION_SHAPE: Shape = {
  punchMass: num(1000, 1e6), dentSpeed: num(0, 100),
  crushEnergy: perStyle(1000, 1e7), reserve: perStyle(1, 10), density: perStyle(50, 3000),
  roundToughness: num(1, 20), tunnelClearance: num(0, 10), pushLever: num(0, 20), maxPushShift: num(0, 2),
  blowOut: obj({ minHalfAngle: num(0, 1.5), maxHalfAngle: num(0, 1.5), minSpeed: num(0, 300), maxSpeed: num(1, 400), maxDepthShare: num(0, 1) }),
  strainRatio: num(0.1, 1), offCentreShare: num(0, 1), maxCrushPasses: int(0, 64),
  motion: obj({
    solverMassReference: num(100, 1e7), spawnClearance: num(0, 0.5), maxPushSpeed: num(0, 100), hingeTilt: num(0, 1), toppleSpin: num(0, 2), edgeCrushInterval: num(0, 2), edgeReserveShare: num(0.1, 1),
    breakupFraction: num(0, 10), bandStoreys: int(1, 40), chunkRadius: num(0, 100), pancakeAccretion: num(0, 1),
    pancakeMaxStoreys: perProfileInt(0, 200), generationDecay: num(0, 1), maxGeneration: int(0, 8), buildingCooldown: num(0, 30),
    impactEnergy: num(0, 1e10), freezeAfter: num(0.1, 60), debrisLife: perProfile(1, 600), debrisBodies: perProfileInt(0, 5000),
    chunkBodies: perProfileInt(0, 5000), debrisPerCrushed: int(0, 8), friction: num(0, 2),
  }),
};

const binding: Rule = obj({
  keys: arr(str(), 0, 8),
  mouse: optional(arr(str(['left', 'right']), 0, 2)),
  gamepadButtons: optional(arr(int(0, 16), 0, 6)),
});

export const ACTIONS_SHAPE: Shape = {
  axes: obj({ 'steer-left': binding, 'steer-right': binding, 'steer-up': binding, 'steer-down': binding }),
  holds: obj({ boost: binding, brake: binding }),
  presses: obj({
    pause: binding, 'toggle-view': binding, 'toggle-sound': binding, restart: binding,
    'toggle-keys': binding, 'toggle-dev': binding, confirm: binding,
  }),
};

export interface ContentLibrary {
  flight: FlightTuning;
  camera: CameraTuning;
  input: InputTuning;
  simulation: SimulationTuning;
  actions: InputBindings;
  destruction: DestructionTuning;
}

export function loadContent(): ContentLibrary {
  return {
    flight: validated<FlightTuning>(flightJson, FLIGHT_SHAPE, 'content/tuning/flight.json'),
    camera: validated<CameraTuning>(cameraJson, CAMERA_SHAPE, 'content/tuning/camera.json'),
    input: validated<InputTuning>(inputJson, INPUT_SHAPE, 'content/tuning/input.json'),
    simulation: validated<SimulationTuning>(simulationJson, SIMULATION_SHAPE, 'content/tuning/simulation.json'),
    actions: validated<InputBindings>(actionsJson, ACTIONS_SHAPE, 'content/input/actions.json'),
    destruction: validated<DestructionTuning>(destructionJson, DESTRUCTION_SHAPE, 'content/tuning/destruction.json'),
  };
}
