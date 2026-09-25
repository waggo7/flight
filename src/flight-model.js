import * as THREE from 'three';
import { FLIGHT } from './flight-tuning.js';
import { clamp, lerp, smoothstep, damp, approach, wrapAngle } from './scalar-math.js';

const finiteAxis = (value) => (Number.isFinite(value) ? clamp(value, -1, 1) : 0);
const sanitizeInput = (input) => ({
  steerX: finiteAxis(input?.steerX),
  steerY: finiteAxis(input?.steerY),
  boost: !!input?.boost,
  brake: !!input?.brake,
});

// Arcade superhero flight: yaw is rate-controlled (hold to keep turning), pitch is
// attitude-controlled (release to level out). Speed has three calm levels — hover,
// cruise, boost — with gravity trading altitude for speed in dives and climbs.
export class FlightModel {
  constructor(world) {
    // world: { groundHeight(x, z), collideSphere(p, r, outNormal) → collider | null,
    //         nearestSurface(p, maxDist), smash?(collider, point, normal, velocity, impact) }
    this.world = world;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.acceleration = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, 1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.right = new THREE.Vector3(-1, 0, 0);
    this.quaternion = new THREE.Quaternion();

    this.yaw = 0;
    this.pitch = 0;
    this.bank = 0;
    this.yawRate = 0;
    this.speed = 0;
    this.mode = 'hover';
    this.hoverBlend = 1; // 1 = upright hover pose, 0 = horizontal flight pose
    this.boostBlend = 0;
    this.groundClearance = Infinity;
    this.overWater = false;
    this.surfaceRush = 0; // 0..1: skimming walls or water at speed

    this.events = [];
    this._boomArmed = true;
    this._impactCooldown = 0;
    this._edgeWarned = false;
    this._prevVelocity = new THREE.Vector3();
    this._normal = new THREE.Vector3();
    this._levelRight = new THREE.Vector3();
    this._levelUp = new THREE.Vector3();
    this._left = new THREE.Vector3();
    this._basis = new THREE.Matrix4();
  }

  reset(position, yaw = 0) {
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
    this._boomArmed = true;
    this.#updateBasis();
  }

  launch() {
    if (this.mode === 'flying') return;
    this.mode = 'flying';
    this.speed = Math.max(this.speed, FLIGHT.launchSpeed);
    this.events.push({ type: 'launch' });
  }

  takeEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  get speedShare() {
    return smoothstep(FLIGHT.cruiseSpeed, FLIGHT.boostSpeed, this.speed);
  }

  update(dt, rawInput) {
    const input = sanitizeInput(rawInput);
    this._prevVelocity.copy(this.velocity);
    this._impactCooldown = Math.max(0, this._impactCooldown - dt);

    if (this.mode === 'hover') this.#updateHover(dt, input);
    else this.#updateFlight(dt, input);

    this.#resolveWorld(dt);
    this.#updateBasis();

    if (dt > 0) {
      this.acceleration.subVectors(this.velocity, this._prevVelocity).divideScalar(dt);
      if (this.acceleration.lengthSq() > 240 * 240) this.acceleration.setLength(240);
    }
    const boosting = input.boost && !input.brake && this.mode === 'flying';
    this.boostBlend = damp(this.boostBlend, boosting ? 1 : 0, boosting ? 3 : 1.5, dt);
  }

  #ceilingLimit() {
    return smoothstep(FLIGHT.maxAltitude - 200, FLIGHT.maxAltitude + 150, this.position.y);
  }

  #updateHover(dt, input) {
    this.yawRate = damp(this.yawRate, -input.steerX * FLIGHT.hoverYawRate, 5, dt);
    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);
    this.pitch = damp(this.pitch, 0, 3, dt);
    this.bank = damp(this.bank, clamp(-this.yawRate * 0.25, -0.3, 0.3), 4, dt);

    const drift = Math.exp(-2.2 * dt);
    this.velocity.x *= drift;
    this.velocity.z *= drift;
    const climb = input.steerY * FLIGHT.hoverClimb * (input.steerY > 0 ? 1 - this.#ceilingLimit() : 1);
    this.velocity.y = damp(this.velocity.y, climb, 3, dt);
    this.position.addScaledVector(this.velocity, dt);
    this.speed = this.velocity.length();
    this.hoverBlend = damp(this.hoverBlend, 1, 3.2, dt);

    if (input.boost && !input.brake) this.launch();
  }

  #updateFlight(dt, input) {
    const F = FLIGHT;
    const maxYawRate = lerp(F.yawRateSlow, F.yawRateFast, this.speedShare);
    this.yawRate = damp(this.yawRate, -input.steerX * maxYawRate, F.yawResponse, dt);
    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);

    const ceilingPitch = lerp(F.pitchMax, -0.35, this.#ceilingLimit());
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
    rate += 9.81 * F.gravityShare * Math.max(0, gaining ? -sinPitch : sinPitch);
    this.speed = approach(this.speed, target, rate * dt);

    const cosPitch = Math.cos(this.pitch);
    this.velocity
      .set(Math.sin(this.yaw) * cosPitch, sinPitch, Math.cos(this.yaw) * cosPitch)
      .multiplyScalar(this.speed);
    this.position.addScaledVector(this.velocity, dt);

    // Coordinated-turn bank: lean into the turn in proportion to lateral acceleration.
    const lateral = this.speed * -this.yawRate;
    const targetBank = clamp(Math.atan2(lateral * F.bankGain, 9.81), -F.bankMax, F.bankMax);
    this.bank = damp(this.bank, targetBank, F.bankResponse, dt);

    const upright = braking ? 1 - smoothstep(F.hoverThreshold, F.cruiseSpeed * 0.9, this.speed) : 0;
    this.hoverBlend = damp(this.hoverBlend, upright, braking ? 3.5 : 5, dt);

    if (braking && this.speed <= F.hoverThreshold) {
      this.mode = 'hover';
      this.events.push({ type: 'hover' });
    }

    if (boosting && this._boomArmed && this.speed > F.boostSpeed * F.boomSpeedShare) {
      this._boomArmed = false;
      this.events.push({ type: 'boom' });
    }
    if (this.speed < F.boostSpeed * 0.7) this._boomArmed = true;
  }

  #resolveWorld(dt) {
    const p = this.position;
    const radius = FLIGHT.radius;

    // World edge: a gentle hand that turns you back toward the city.
    const horizontal = Math.hypot(p.x, p.z);
    if (horizontal > FLIGHT.worldRadius) {
      const push = smoothstep(FLIGHT.worldRadius, FLIGHT.worldRadius + 700, horizontal);
      const homeYaw = Math.atan2(-p.x, -p.z);
      this.yaw = wrapAngle(this.yaw + wrapAngle(homeYaw - this.yaw) * Math.min(1, push * 1.8 * dt));
      const hardLimit = FLIGHT.worldRadius + 900;
      if (horizontal > hardLimit) {
        p.x *= hardLimit / horizontal;
        p.z *= hardLimit / horizontal;
      }
      if (!this._edgeWarned) {
        this._edgeWarned = true;
        this.events.push({ type: 'edge' });
      }
    } else if (horizontal < FLIGHT.worldRadius - 400) {
      this._edgeWarned = false;
    }
    p.y = Math.min(p.y, FLIGHT.maxAltitude + 300);

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
      if (verticalSpeed > 10 && this._impactCooldown <= 0) {
        this._impactCooldown = 0.5;
        this.events.push({
          type: this.overWater ? 'splash' : 'impact',
          strength: clamp(verticalSpeed / 70, 0.15, 1),
          point: p.clone(),
          normal: new THREE.Vector3(0, 1, 0),
        });
      }
      this.groundClearance = radius;
    }

    // Buildings: hit hard enough and the building gives way — burst through, keeping
    // most of your speed. Otherwise glance off and slide along it.
    const normal = this._normal;
    const collider = this.world.collideSphere(p, radius, normal);
    if (collider) {
      const into = this.velocity.dot(normal);
      const outcome = into < 0 && this.world.smash ? this.world.smash(collider, p, normal, this.velocity, -into) : null;
      if (outcome?.brokeThrough && this.mode === 'flying') {
        this.speed = Math.max(FLIGHT.minFlightSpeed, this.speed * FLIGHT.smashSpeedKept);
        this.yawRate *= 0.5;
        this.events.push({ type: 'smash', kind: outcome.kind, strength: outcome.strength, point: p.clone(), normal: normal.clone() });
      } else if (into < 0) {
        this.velocity.addScaledVector(normal, -into * 1.15);
        if (this.mode === 'flying') {
          const slideSpeed = this.velocity.length();
          this.speed = Math.max(FLIGHT.minFlightSpeed, slideSpeed * 0.9);
          if (slideSpeed > 1e-3) {
            this.yaw = Math.atan2(this.velocity.x, this.velocity.z);
            this.pitch = Math.asin(clamp(this.velocity.y / slideSpeed, -1, 1));
            this.yawRate *= 0.3;
          }
        }
        if (-into > 6 && this._impactCooldown <= 0) {
          this._impactCooldown = 0.35;
          this.events.push({
            type: 'impact', strength: clamp(-into / 60, 0.1, 1), point: p.clone(), normal: normal.clone(), dented: outcome?.kind === 'dent',
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

  #updateBasis() {
    const cosPitch = Math.cos(this.pitch);
    const sinPitch = Math.sin(this.pitch);
    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);
    this.forward.set(sinYaw * cosPitch, sinPitch, cosYaw * cosPitch);
    const levelRight = this._levelRight.set(-cosYaw, 0, sinYaw);
    const levelUp = this._levelUp.crossVectors(levelRight, this.forward);
    const cosBank = Math.cos(this.bank);
    const sinBank = Math.sin(this.bank);
    this.up.copy(levelUp).multiplyScalar(cosBank).addScaledVector(levelRight, sinBank);
    this.right.copy(levelRight).multiplyScalar(cosBank).addScaledVector(levelUp, -sinBank);
    // Hero root: local +X = the hero's left, +Y = up (the back, in flight), +Z = forward.
    this._left.copy(this.right).negate();
    this._basis.makeBasis(this._left, this.up, this.forward);
    this.quaternion.setFromRotationMatrix(this._basis);
  }
}
