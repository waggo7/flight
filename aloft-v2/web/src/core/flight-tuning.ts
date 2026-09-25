// Shapes of the tuning data in content/tuning/*.json. The JSON is the source of truth
// (the Godot port reads the same files); engine/content-library.ts validates it against these.

export interface FlightTuning {
  cruiseSpeed: number;
  boostSpeed: number;
  minFlightSpeed: number;
  launchSpeed: number;
  hoverThreshold: number;
  diveBonus: number;
  climbPenalty: number;
  boostAccel: number;
  cruiseAccel: number;
  coastDecel: number;
  brakeDecel: number;
  gravityShare: number;
  yawRateSlow: number;
  yawRateFast: number;
  yawResponse: number;
  pitchMax: number;
  pitchResponse: number;
  bankMax: number;
  bankResponse: number;
  bankGain: number;
  hoverClimb: number;
  hoverYawRate: number;
  radius: number;
  maxAltitude: number;
  worldRadius: number;
  boomSpeedShare: number;
  smashSpeedKept: number;
}

export interface CameraTuning {
  distance: number;
  boostDistance: number;
  hoverDistance: number;
  height: number;
  lookAhead: number;
  lookLift: number;
  fov: number;
  boostFov: number;
  firstPersonFov: number;
  yawFollow: number;
  pitchFollow: number;
  pitchShare: number;
  turnLead: number;
  rollShare: number;
}

export interface InputTuning {
  mouseRadius: number;
  deadZone: number;
  curve: number;
  keyRise: number;
  keyFall: number;
  touchRadius: number;
  gamepadDeadZone: number;
  authorityRamp: number;
}

export interface SimulationTuning {
  stepsPerSecond: number;
  maxStepsPerFrame: { desktop: number; phone: number };
  maxFrameDelta: number;
  hitStop: { seconds: number; timeScale: number };
  seed: number;
  physics: { gravity: number; solverIterations: number; debrisHitsDebris: { desktop: boolean; phone: boolean } };
}

/** One-shot input actions (content/input/actions.json → presses). */
export type PressAction =
  | 'pause' | 'toggle-view' | 'toggle-sound' | 'restart' | 'toggle-keys' | 'toggle-dev' | 'confirm'
  | 'hero-previous' | 'hero-next';

export interface KeyBinding {
  keys: string[];
  mouse?: ('left' | 'right')[];
  gamepadButtons?: number[];
}

export interface InputBindings {
  axes: { 'steer-left': KeyBinding; 'steer-right': KeyBinding; 'steer-up': KeyBinding; 'steer-down': KeyBinding };
  holds: { boost: KeyBinding; brake: KeyBinding };
  presses: Record<PressAction, KeyBinding>;
}
