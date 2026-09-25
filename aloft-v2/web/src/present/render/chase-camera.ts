import { Spherical, Vector3 } from 'three';
import type { PerspectiveCamera, Quaternion } from 'three';
import type { CameraTuning } from '../../core/flight-tuning';
import { clamp, damp, dampAngle, easeInOutCubic, lerp, wrapAngle } from '../../core/scalar-math';
import { DEFAULT_COMFORT, viewRollShare, type ComfortSettings } from '../../core/view-state';
import type { CameraWorld } from '../../sim/world-contracts';

// Third-person chase camera with a first-person option and a showcase framing for the title
// screen. It follows the flight direction (not raw input), leans a little into turns, pulls back
// and widens with speed, and never ends up inside a wall. Ported from v1 (src/chase-camera.js);
// M8: free look, look-where-you-fly in first person, and comfort settings (roll, horizon lock, FOV).

/** The interpolated flight state the camera frames. */
export interface CameraSubject {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly forward: Vector3;
  readonly up: Vector3;
  readonly acceleration: Vector3;
  readonly yaw: number;
  readonly pitch: number;
  readonly bank: number;
  readonly yawRate: number;
  readonly speedShare: number;
  readonly hoverBlend: number;
  readonly boostBlend: number;
}

export type CameraMode = 'chase' | 'first';

const WORLD_UP = new Vector3(0, 1, 0);

function wobble(t: number, seed: number): number {
  return Math.sin(t * 1.9 + seed) * 0.5 + Math.sin(t * 3.7 + seed * 2.3) * 0.3 + Math.sin(t * 7.3 + seed * 5.1) * 0.2;
}

export class ChaseCamera {
  mode: CameraMode = 'chase';
  yaw = 0;
  pitch = 0;
  roll = 0;
  distance: number;
  trauma = 0;
  /** Low, slow sway from heavy collapses nearby (the second shake band). */
  rumbleAmount = 0;
  fovKick = 0;
  accelLag = 0;
  /** 1 = title-screen showcase framing, 0 = gameplay. */
  intro = 1;
  introAzimuth = 2.35;
  clearance = Infinity;
  time = 0;
  firstPersonBlend = 0;
  /** Free-look head turn (rad) on top of the flight direction; the course doesn't change. */
  lookYaw = 0;
  lookPitch = 0;
  comfort: ComfortSettings = { ...DEFAULT_COMFORT };
  /** A quick directional knock (glancing off a wall) that springs back. */
  private readonly joltOffset = new Vector3();

  private readonly dir = new Vector3();
  private readonly right = new Vector3();
  private readonly upAxis = new Vector3();
  private readonly chasePos = new Vector3();
  private readonly chaseTarget = new Vector3();
  private readonly introPos = new Vector3();
  private readonly introTarget = new Vector3();
  private readonly pos = new Vector3();
  private readonly target = new Vector3();
  private readonly camUp = new Vector3();
  private readonly offset = new Vector3();
  private readonly spherical = new Spherical();
  private readonly sphericalB = new Spherical();
  private lastNear = 0;

  constructor(
    readonly camera: PerspectiveCamera,
    private readonly tuning: CameraTuning,
  ) {
    this.distance = tuning.hoverDistance;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
  }

  snapTo(subject: CameraSubject): void {
    this.yaw = subject.yaw;
    this.pitch = subject.pitch * this.tuning.pitchShare;
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Low-frequency ground rumble: a slow, heavy sway that fades over a couple of seconds. */
  rumble(amount: number): void {
    this.rumbleAmount = Math.min(1, this.rumbleAmount + amount);
  }

  /** Knock the view along `direction` (a wall's normal): a directional jolt instead of random shake. */
  jolt(direction: { x: number; y: number; z: number }, amount: number): void {
    this.joltOffset.x += direction.x * amount * 0.45;
    this.joltOffset.y += direction.y * amount * 0.45;
    this.joltOffset.z += direction.z * amount * 0.45;
    this.joltOffset.clampLength(0, 0.6);
  }

  kick(amount: number): void {
    this.fovKick = Math.min(14, this.fovKick + amount);
  }

  update(dt: number, flight: CameraSubject, world: CameraWorld): void {
    const C = this.tuning;
    this.time += dt;
    const speedShare = flight.speedShare;
    const hover = flight.hoverBlend;

    // First person looks where you fly (all of the pitch) and rolls by the comfort setting.
    const pitchShare = lerp(C.pitchShare, C.firstPersonPitchShare, this.firstPersonBlend);
    this.yaw = dampAngle(this.yaw, flight.yaw + flight.yawRate * C.turnLead, C.yawFollow, dt);
    this.pitch = damp(this.pitch, flight.pitch * pitchShare, C.pitchFollow, dt);
    this.roll = damp(this.roll, flight.bank * viewRollShare(C.rollShare, this.firstPersonBlend, this.comfort), 3.2, dt);
    const targetDistance = lerp(lerp(C.distance, C.boostDistance, speedShare), C.hoverDistance, hover);
    this.distance = damp(this.distance, targetDistance, 2.2, dt);
    const forwardAccel = flight.acceleration.dot(flight.forward);
    this.accelLag = damp(this.accelLag, clamp(forwardAccel * 0.035, -1.2, 2.4), 3, dt);

    // Free look turns the head (first person) or swings the camera round the hero (chase).
    const viewYaw = this.yaw + this.lookYaw;
    const viewPitch = clamp(this.pitch + this.lookPitch, -1.45, 1.45);
    const cosPitch = Math.cos(viewPitch);
    const dir = this.dir.set(Math.sin(viewYaw) * cosPitch, Math.sin(viewPitch), Math.cos(viewYaw) * cosPitch);
    const right = this.right.set(-Math.cos(viewYaw), 0, Math.sin(viewYaw));
    const up = this.upAxis.crossVectors(right, dir);

    // Chase framing: hero in the lower-middle of the frame, horizon visible.
    const chasePos = this.chasePos
      .copy(flight.position)
      .addScaledVector(dir, -(this.distance + this.accelLag))
      .addScaledVector(up, C.height);
    const chaseTarget = this.chaseTarget.copy(flight.position).addScaledVector(dir, C.lookAhead).addScaledVector(up, C.lookLift);

    // First person: eyes at the head, which sits forward in flight and up in hover.
    this.firstPersonBlend = damp(this.firstPersonBlend, this.mode === 'first' ? 1 : 0, 6, dt);
    if (this.firstPersonBlend > 0.001) {
      const fly = 1 - hover;
      const eye = this.pos
        .copy(flight.position)
        .addScaledVector(flight.forward, 0.72 * fly)
        .addScaledVector(flight.up, 0.16 * fly + 0.72 * (1 - fly));
      const look = this.target.copy(eye).addScaledVector(dir, 20);
      chasePos.lerp(eye, this.firstPersonBlend);
      chaseTarget.lerp(look, this.firstPersonBlend);
    }

    // Showcase framing for the title screen: low, front three-quarter, hero off-centre.
    let position = chasePos;
    let target = chaseTarget;
    const introMix = easeInOutCubic(clamp(this.intro, 0, 1));
    if (introMix > 0.0005) {
      const azimuth = flight.yaw + this.introAzimuth + Math.sin(this.time * 0.07) * 0.16;
      const introPos = this.introPos.set(
        flight.position.x + Math.sin(azimuth) * 6.4,
        flight.position.y + 0.1,
        flight.position.z + Math.cos(azimuth) * 6.4,
      );
      // Landscape: hero on the right third. Portrait: hero centred low, under the title.
      const portrait = clamp((1.15 - this.camera.aspect) / 0.6, 0, 1);
      const side = this.offset.set(Math.cos(azimuth), 0, -Math.sin(azimuth)).multiplyScalar(-1.25 * (1 - portrait));
      const introTarget = this.introTarget.copy(flight.position).add(side);
      introTarget.y += lerp(0.45, 1.7, portrait);
      // Swing on a sphere around the hero so the move never passes through the body.
      this.spherical.setFromVector3(this.offset.copy(chasePos).sub(flight.position));
      this.sphericalB.setFromVector3(introPos.clone().sub(flight.position));
      const s = this.spherical;
      s.radius = lerp(s.radius, this.sphericalB.radius, introMix);
      s.phi = lerp(s.phi, this.sphericalB.phi, introMix);
      s.theta = s.theta + wrapAngle(this.sphericalB.theta - s.theta) * introMix;
      position = this.pos.setFromSpherical(s).add(flight.position);
      target = this.target.copy(chaseTarget).lerp(introTarget, introMix);
    }

    // Keep out of walls and the ground: cast from the hero toward the camera.
    const toCamera = this.offset.copy(position).sub(flight.position);
    const wanted = toCamera.length();
    if (wanted > 0.5 && this.firstPersonBlend < 0.5) {
      toCamera.divideScalar(wanted);
      const hit = world.raycast(flight.position, toCamera, wanted + 0.8);
      const allowed = Math.max(0.9, hit - 0.8);
      this.clearance = allowed < this.clearance ? damp(this.clearance, allowed, 30, dt) : damp(this.clearance, allowed, 2.5, dt);
      if (this.clearance < wanted) position = this.pos.copy(flight.position).addScaledVector(toCamera, this.clearance);
    }
    const ground = Math.max(world.groundHeight(position.x, position.z), 0) + 1.1;
    if (position.y < ground) position.y = ground;

    // Speed buffeting and impact shake: tiny, and gone quickly.
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const buffet = 0.1 * speedShare * flight.boostBlend * (1 - this.firstPersonBlend * 0.5);
    const shake = Math.pow(Math.min(1, this.trauma + buffet), 2);
    const t = this.time * 18;
    const camUp = this.camUp.copy(up).multiplyScalar(Math.cos(this.roll)).addScaledVector(right, Math.sin(this.roll));
    const rollShake = wobble(t, 3.1) * 0.04 * shake;
    camUp.applyAxisAngle(dir, rollShake * (1 - introMix));
    if (introMix > 0) camUp.lerp(WORLD_UP, introMix).normalize();

    this.camera.position.copy(position);
    this.camera.position.x += wobble(t, 0.3) * 0.25 * shake;
    this.camera.position.y += wobble(t, 1.7) * 0.25 * shake;
    this.joltOffset.multiplyScalar(Math.exp(-9 * dt));
    this.camera.position.add(this.joltOffset);
    // Band two: a heavy low sway (about 2–3 Hz) that outlasts the sharp shake.
    this.rumbleAmount = Math.max(0, this.rumbleAmount - dt * 0.45);
    const sway = this.rumbleAmount * this.rumbleAmount;
    const slow = this.time * 2.6;
    this.camera.position.y += wobble(slow, 5.3) * 0.55 * sway;
    this.camera.position.x += wobble(slow, 2.1) * 0.3 * sway;
    this.camera.up.copy(camUp);
    this.camera.lookAt(target);

    this.fovKick = damp(this.fovKick, 0, 2.2, dt);
    const chaseFov = lerp(C.fov, C.boostFov, speedShare);
    const baseFov = lerp(chaseFov, C.firstPersonFov + speedShare * 10, this.firstPersonBlend);
    const introFov = lerp(40, 52, clamp((1.15 - this.camera.aspect) / 0.6, 0, 1));
    const fov = Math.min(lerp(baseFov, introFov, introMix) + this.fovKick, Math.max(this.comfort.maxFov, 40));
    this.camera.near = this.firstPersonBlend > 0.5 ? 0.12 : 0.3;
    if (Math.abs(fov - this.camera.fov) > 0.01 || this.camera.near !== this.lastNear) {
      this.camera.fov = fov;
      this.lastNear = this.camera.near;
      this.camera.updateProjectionMatrix();
    }
  }
}
