import { Matrix4, Quaternion, Vector3 } from './math';
import type { FlightTuning } from './flight-tuning';
import { approach, clamp, damp, lerp, smoothstep, wrapAngle } from './scalar-math';

// Arcade superhero flight: yaw is rate-controlled (hold to keep turning), pitch is
// attitude-controlled (release to level out). Speed has three calm levels — hover,
// cruise, boost — with gravity trading altitude for speed in dives and climbs.
// Ported from v1 (src/flight-model.js); the Godot twin is godot/core/flight_model.gd and
// both must reproduce conformance/flight-model.json.

export interface FlightControls {
  steerX: number;
  steerY: number;
  boost: boolean;
  brake: boolean;
}

export const IDLE_CONTROLS: Readonly<FlightControls> = Object.freeze({ steerX: 0, steerY: 0, boost: false, brake: false });

export interface SmashOutcome {
  brokeThrough: boolean;
  strength: number;
  kind: 'dent' | 'shatter' | 'burst' | 'topple';
}

/**
 * What the flight model needs from the world. `Hit` is whatever the world uses to identify
 * the thing that was hit (a collider, a chunk); the flight model only hands it back to `smash`.
 */
export interface FlightWorld<Hit = unknown> {
  groundHeight(x: number, z: number): number;
  /**
   * Push `position` out of solid geometry. `previous` is the position at the start of the step,
   * so sweep-based worlds can find the first hit along the path. Writes the push normal into
   * `outNormal` and returns the deepest hit, or null.
   */
  resolveSphere(position: Vector3, previous: Vector3, radius: number, outNormal: Vector3): Hit | null;
  /** Distance to the nearest solid surface, or Infinity beyond `maxDistance`. */
  nearestSurface(position: Vector3, maxDistance: number): number;
  /** Optional: decide whether a hit breaks the building. `impact` is the speed into the wall. */
  smash?(hit: Hit, point: Vector3, normal: Vector3, velocity: Vector3, impact: number): SmashOutcome | null;
}

export type FlightEvent =
  | { type: 'launch' }
  | { type: 'boom' }
  | { type: 'hover' }
  | { type: 'edge' }
  | { type: 'impact'; strength: number; point: Vector3; normal: Vector3; dented: boolean }
  | { type: 'splash'; strength: number; point: Vector3; normal: Vector3 }
  | { type: 'smash'; kind: SmashOutcome['kind']; strength: number; point: Vector3; normal: Vector3 };

export type FlightMode = 'hover' | 'flying';

const finiteAxis = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? clamp(value, -1, 1) : 0);

export function sanitizeControls(input: Partial<FlightControls> | null | undefined): FlightControls {
  return {
    steerX: finiteAxis(input?.steerX),
    steerY: finiteAxis(input?.steerY),
    boost: !!input?.boost,
    brake: !!input?.brake,
  };
}

const GRAVITY = 9.81;
const UP = new Vector3(0, 1, 0);

export class FlightModel<Hit = unknown> {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly acceleration = new Vector3();
  readonly forward = new Vector3(0, 0, 1);
  readonly up = new Vector3(0, 1, 0);
  readonly right = new Vector3(-1, 0, 0);
  readonly quaternion = new Quaternion();

  yaw = 0;
  pitch = 0;
  bank = 0;
  yawRate = 0;
  speed = 0;
  mode: FlightMode = 'hover';
  /** 1 = upright hover pose, 0 = horizontal flight pose. */
  hoverBlend = 1;
  boostBlend = 0;
  groundClearance = Infinity;
  overWater = false;
  /** 0..1: skimming walls or water at speed. */
  surfaceRush = 0;

  private events: FlightEvent[] = [];
  private boomArmed = true;
  private impactCooldown = 0;
  private edgeWarned = false;
  private readonly previousVelocity = new Vector3();
  private readonly previousPosition = new Vector3();
  private readonly normal = new Vector3();
  private readonly levelRight = new Vector3();
  private readonly levelUp = new Vector3();
  private readonly left = new Vector3();
  private readonly basis = new Matrix4();

  constructor(
    public world: FlightWorld<Hit>,
    public tuning: FlightTuning,
  ) {}

  reset(position: Vector3, yaw = 0): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.acceleration.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.bank = 0;
    this.yawRate = 0;
    this.speed = 0;
    this.mode = 'hover';
    this.hoverBlend = 1;
    this.boostBlend = 0;
    this.surfaceRush = 0;
    this.boomArmed = true;
    this.impactCooldown = 0;
    this.edgeWarned = false;
    this.events = [];
    this.updateBasis();
  }

  launch(): void {
    if (this.mode === 'flying') return;
    this.mode = 'flying';
    this.speed = Math.max(this.speed, this.tuning.launchSpeed);
    this.events.push({ type: 'launch' });
  }

  takeEvents(): FlightEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  get speedShare(): number {
    return smoothstep(this.tuning.cruiseSpeed, this.tuning.boostSpeed, this.speed);
  }

  update(dt: number, rawInput: Partial<FlightControls> | null | undefined): void {
    const input = sanitizeControls(rawInput);
    this.previousVelocity.copy(this.velocity);
    this.previousPosition.copy(this.position);
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);

    if (this.mode === 'hover') this.updateHover(dt, input);
    else this.updateFlight(dt, input);

    this.resolveWorld(dt);
    this.updateBasis();

    if (dt > 0) {
      this.acceleration.subVectors(this.velocity, this.previousVelocity).divideScalar(dt);
      if (this.acceleration.lengthSq() > 240 * 240) this.acceleration.setLength(240);
    }
    const boosting = input.boost && !input.brake && this.mode === 'flying';
    this.boostBlend = damp(this.boostBlend, boosting ? 1 : 0, boosting ? 3 : 1.5, dt);
  }

  private ceilingLimit(): number {
    return smoothstep(this.tuning.maxAltitude - 200, this.tuning.maxAltitude + 150, this.position.y);
  }

  private updateHover(dt: number, input: FlightControls): void {
    const F = this.tuning;
    this.yawRate = damp(this.yawRate, -input.steerX * F.hoverYawRate, 5, dt);
    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);
    this.pitch = damp(this.pitch, 0, 3, dt);
    this.bank = damp(this.bank, clamp(-this.yawRate * 0.25, -0.3, 0.3), 4, dt);

    const drift = Math.exp(-2.2 * dt);
    this.velocity.x *= drift;
    this.velocity.z *= drift;
    const climb = input.steerY * F.hoverClimb * (input.steerY > 0 ? 1 - this.ceilingLimit() : 1);
    this.velocity.y = damp(this.velocity.y, climb, 3, dt);
    this.position.addScaledVector(this.velocity, dt);
    this.speed = this.velocity.length();
    this.hoverBlend = damp(this.hoverBlend, 1, 3.2, dt);

    if (input.boost && !input.brake) this.launch();
  }

  private updateFlight(dt: number, input: FlightControls): void {
    const F = this.tuning;
    const maxYawRate = lerp(F.yawRateSlow, F.yawRateFast, this.speedShare);
    this.yawRate = damp(this.yawRate, -input.steerX * maxYawRate, F.yawResponse, dt);
    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);

    const ceilingPitch = lerp(F.pitchMax, -0.35, this.ceilingLimit());
    const targetPitch = Math.min(input.steerY * F.pitchMax, ceilingPitch);
    this.pitch = damp(this.pitch, targetPitch, F.pitchResponse, dt);

    const sinPitch = Math.sin(this.pitch);
    const braking = input.brake;
    const boosting = input.boost && !braking;
    let target = boosting ? F.boostSpeed : F.cruiseSpeed;
    target += F.diveBonus * Math.max(0, -sinPitch) * (boosting ? 1 : 0.75);
    target -= F.climbPenalty * Math.max(0, sinPitch);
    target = braking ? 0 : Math.max(target, F.minFlightSpeed);

    const gaining = this.speed < target;
    let rate = gaining ? (boosting ? F.boostAccel : F.cruiseAccel) : braking ? F.brakeDecel : F.coastDecel;
    rate += GRAVITY * F.gravityShare * Math.max(0, gaining ? -sinPitch : sinPitch);
    this.speed = approach(this.speed, target, rate * dt);

    const cosPitch = Math.cos(this.pitch);
    this.velocity.set(Math.sin(this.yaw) * cosPitch, sinPitch, Math.cos(this.yaw) * cosPitch).multiplyScalar(this.speed);
    this.position.addScaledVector(this.velocity, dt);

    // Coordinated-turn bank: lean into the turn in proportion to lateral acceleration.
    const lateral = this.speed * -this.yawRate;
    const targetBank = clamp(Math.atan2(lateral * F.bankGain, GRAVITY), -F.bankMax, F.bankMax);
    this.bank = damp(this.bank, targetBank, F.bankResponse, dt);

    const upright = braking ? 1 - smoothstep(F.hoverThreshold, F.cruiseSpeed * 0.9, this.speed) : 0;
    this.hoverBlend = damp(this.hoverBlend, upright, braking ? 3.5 : 5, dt);

    if (braking && this.speed <= F.hoverThreshold) {
      this.mode = 'hover';
      this.events.push({ type: 'hover' });
    }

    if (boosting && this.boomArmed && this.speed > F.boostSpeed * F.boomSpeedShare) {
      this.boomArmed = false;
      this.events.push({ type: 'boom' });
    }
    if (this.speed < F.boostSpeed * 0.7) this.boomArmed = true;
  }

  private resolveWorld(dt: number): void {
    const F = this.tuning;
    const p = this.position;
    const radius = F.radius;

    // World edge: a gentle hand that turns you back toward the city.
    const horizontal = Math.hypot(p.x, p.z);
    if (horizontal > F.worldRadius) {
      const push = smoothstep(F.worldRadius, F.worldRadius + 700, horizontal);
      const homeYaw = Math.atan2(-p.x, -p.z);
      this.yaw = wrapAngle(this.yaw + wrapAngle(homeYaw - this.yaw) * Math.min(1, push * 1.8 * dt));
      const hardLimit = F.worldRadius + 900;
      if (horizontal > hardLimit) {
        p.x *= hardLimit / horizontal;
        p.z *= hardLimit / horizontal;
      }
      if (!this.edgeWarned) {
        this.edgeWarned = true;
        this.events.push({ type: 'edge' });
      }
    } else if (horizontal < F.worldRadius - 400) {
      this.edgeWarned = false;
    }
    p.y = Math.min(p.y, F.maxAltitude + 300);

    // Ground and sea: never a crash, just a skim.
    const ground = this.world.groundHeight(p.x, p.z);
    const surface = Math.max(ground, 0);
    this.overWater = ground < 0.5;
    this.groundClearance = p.y - surface;
    if (p.y < surface + radius) {
      const verticalSpeed = -this.velocity.y;
      p.y = surface + radius;
      if (this.velocity.y < 0) this.velocity.y = 0;
      if (this.mode === 'flying' && this.pitch < 0) this.pitch = Math.max(this.pitch, -0.04);
      if (verticalSpeed > 10 && this.impactCooldown <= 0) {
        this.impactCooldown = 0.5;
        const strength = clamp(verticalSpeed / 70, 0.15, 1);
        const point = p.clone();
        const normal = UP.clone();
        this.events.push(this.overWater ? { type: 'splash', strength, point, normal } : { type: 'impact', strength, point, normal, dented: false });
      }
      this.groundClearance = radius;
    }

    // Buildings: hit hard enough and the building gives way — burst through, keeping
    // most of your speed. Otherwise glance off and slide along it.
    const normal = this.normal;
    const hit = this.world.resolveSphere(p, this.previousPosition, radius, normal);
    if (hit !== null) {
      const into = this.velocity.dot(normal);
      const outcome = into < 0 && this.world.smash ? this.world.smash(hit, p, normal, this.velocity, -into) : null;
      if (outcome?.brokeThrough && this.mode === 'flying') {
        this.speed = Math.max(F.minFlightSpeed, this.speed * F.smashSpeedKept);
        this.yawRate *= 0.5;
        this.events.push({ type: 'smash', kind: outcome.kind, strength: outcome.strength, point: p.clone(), normal: normal.clone() });
      } else if (into < 0) {
        this.velocity.addScaledVector(normal, -into * 1.15);
        if (this.mode === 'flying') {
          const slideSpeed = this.velocity.length();
          this.speed = Math.max(F.minFlightSpeed, slideSpeed * 0.9);
          if (slideSpeed > 1e-3) {
            this.yaw = Math.atan2(this.velocity.x, this.velocity.z);
            this.pitch = Math.asin(clamp(this.velocity.y / slideSpeed, -1, 1));
            this.yawRate *= 0.3;
          }
        }
        if (-into > 6 && this.impactCooldown <= 0) {
          this.impactCooldown = 0.35;
          this.events.push({
            type: 'impact',
            strength: clamp(-into / 60, 0.1, 1),
            point: p.clone(),
            normal: normal.clone(),
            dented: outcome?.kind === 'dent',
          });
        }
      }
    }

    // Skimming close to walls or water at speed feeds the rush effects.
    const wallDistance = this.world.nearestSurface(p, 16);
    const wallRush = 1 - smoothstep(radius + 1, 16, wallDistance);
    const waterRush = this.overWater ? 1 - smoothstep(radius + 1, 12, this.groundClearance) : 0;
    const rushTarget = Math.max(wallRush, waterRush) * smoothstep(20, 70, this.speed);
    this.surfaceRush = damp(this.surfaceRush, rushTarget, 6, dt);
  }

  private updateBasis(): void {
    const cosPitch = Math.cos(this.pitch);
    const sinPitch = Math.sin(this.pitch);
    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);
    this.forward.set(sinYaw * cosPitch, sinPitch, cosYaw * cosPitch);
    const levelRight = this.levelRight.set(-cosYaw, 0, sinYaw);
    const levelUp = this.levelUp.crossVectors(levelRight, this.forward);
    const cosBank = Math.cos(this.bank);
    const sinBank = Math.sin(this.bank);
    this.up.copy(levelUp).multiplyScalar(cosBank).addScaledVector(levelRight, sinBank);
    this.right.copy(levelRight).multiplyScalar(cosBank).addScaledVector(levelUp, -sinBank);
    // Hero root: local +X = the hero's left, +Y = up (the back, in flight), +Z = forward.
    this.left.copy(this.right).negate();
    this.basis.makeBasis(this.left, this.up, this.forward);
    this.quaternion.setFromRotationMatrix(this.basis);
  }
}
