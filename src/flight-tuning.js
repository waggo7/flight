// Every number that shapes how flight feels lives here, so tuning happens in one place.
// Units: metres, seconds, radians.

export const FLIGHT = {
  // Speeds (m/s)
  cruiseSpeed: 34,
  boostSpeed: 108,
  minFlightSpeed: 16,
  launchSpeed: 44,
  hoverThreshold: 4,
  diveBonus: 38, // extra speed a steep dive can add
  climbPenalty: 12, // speed a steep climb costs

  // Speed change (m/s²)
  boostAccel: 44,
  cruiseAccel: 16,
  coastDecel: 11,
  brakeDecel: 40,
  gravityShare: 0.5, // how strongly gravity speeds dives and slows climbs

  // Steering
  yawRateSlow: 1.3, // rad/s at full stick, cruise speed
  yawRateFast: 0.72, // rad/s at full stick, boost speed
  yawResponse: 4.2, // how quickly the turn rate follows the stick (1/s)
  pitchMax: 1.2, // ~69°: the attitude reached at full stick
  pitchResponse: 2.5,
  bankMax: 1.15,
  bankResponse: 4.6,
  bankGain: 0.5, // scales the coordinated-turn bank angle

  // Hover
  hoverClimb: 10,
  hoverYawRate: 1.15,

  // Body and world limits
  radius: 1.2,
  maxAltitude: 2400,
  worldRadius: 6000,
  boomSpeedShare: 0.95, // shockwave fires when boosting past this share of boostSpeed
};

export const CAMERA = {
  distance: 6.1,
  boostDistance: 8.8,
  hoverDistance: 5.4,
  height: 1.35,
  lookAhead: 16,
  lookLift: 0.9,
  fov: 58,
  boostFov: 76,
  firstPersonFov: 74,
  yawFollow: 5.2,
  pitchFollow: 4,
  pitchShare: 0.82, // camera follows this share of the hero's pitch, keeping the horizon readable
  turnLead: 0.22, // seconds of yaw rate the camera looks ahead into a turn
  rollShare: 0.28,
};

export const INPUT = {
  mouseRadius: 0.34, // share of the shorter viewport side for full stick deflection
  deadZone: 0.075,
  curve: 1.55, // >1 keeps small movements gentle
  keyRise: 4.6, // keyboard stick ramp (1/s)
  keyFall: 7,
  touchRadius: 64, // px for full deflection
  gamepadDeadZone: 0.15,
  authorityRamp: 0.7, // seconds for steering to fade in after start/resume
};
