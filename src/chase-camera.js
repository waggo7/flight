import * as THREE from 'three';
import { CAMERA } from './flight-tuning.js';
import { clamp, damp, dampAngle, lerp, easeInOutCubic, wrapAngle } from './scalar-math.js';

// Third-person chase camera with a first-person option and a showcase framing for the
// title screen. It follows the flight direction (not raw input), leans a little into
// turns, pulls back and widens with speed, and never ends up inside a wall.

const WORLD_UP = new THREE.Vector3(0, 1, 0);

function wobble(t, seed) {
  return Math.sin(t * 1.9 + seed) * 0.5 + Math.sin(t * 3.7 + seed * 2.3) * 0.3 + Math.sin(t * 7.3 + seed * 5.1) * 0.2;
}

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.distance = CAMERA.hoverDistance;
    this.fov = 42;
    this.trauma = 0;
    this.fovKick = 0;
    this.accelLag = 0;
    this.intro = 1;
    this.introAzimuth = 2.35;
    this.clearance = Infinity;
    this.time = 0;
    this.firstPersonBlend = 0;

    this._dir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._chasePos = new THREE.Vector3();
    this._chaseTarget = new THREE.Vector3();
    this._introPos = new THREE.Vector3();
    this._introTarget = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._camUp = new THREE.Vector3();
    this._offset = new THREE.Vector3();
    this._spherical = new THREE.Spherical();
    this._sphericalB = new THREE.Spherical();
  }

  setMode(mode) {
    this.mode = mode;
  }

  snapTo(flight) {
    this.yaw = flight.yaw;
    this.pitch = flight.pitch * CAMERA.pitchShare;
  }

  shake(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  kick(amount) {
    this.fovKick = Math.min(14, this.fovKick + amount);
  }

  update(dt, flight, world) {
    this.time += dt;
    const speedShare = flight.speedShare;
    const hover = flight.hoverBlend;

    this.yaw = dampAngle(this.yaw, flight.yaw + flight.yawRate * CAMERA.turnLead, CAMERA.yawFollow, dt);
    this.pitch = damp(this.pitch, flight.pitch * CAMERA.pitchShare, CAMERA.pitchFollow, dt);
    this.roll = damp(this.roll, flight.bank * CAMERA.rollShare, 3.2, dt);
    const targetDistance = lerp(lerp(CAMERA.distance, CAMERA.boostDistance, speedShare), CAMERA.hoverDistance, hover);
    this.distance = damp(this.distance, targetDistance, 2.2, dt);
    const forwardAccel = flight.acceleration.dot(flight.forward);
    this.accelLag = damp(this.accelLag, clamp(forwardAccel * 0.035, -1.2, 2.4), 3, dt);

    const cosPitch = Math.cos(this.pitch);
    const dir = this._dir.set(Math.sin(this.yaw) * cosPitch, Math.sin(this.pitch), Math.cos(this.yaw) * cosPitch);
    const right = this._right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const up = this._up.crossVectors(right, dir);

    // Chase framing: hero in the lower-middle of the frame, horizon visible.
    const chasePos = this._chasePos
      .copy(flight.position)
      .addScaledVector(dir, -(this.distance + this.accelLag))
      .addScaledVector(up, CAMERA.height);
    const chaseTarget = this._chaseTarget
      .copy(flight.position)
      .addScaledVector(dir, CAMERA.lookAhead)
      .addScaledVector(up, CAMERA.lookLift);

    // First person: eyes at the head, which sits forward in flight and up in hover.
    this.firstPersonBlend = damp(this.firstPersonBlend, this.mode === 'first' ? 1 : 0, 6, dt);
    if (this.firstPersonBlend > 0.001) {
      const fly = 1 - hover;
      const eye = this._pos
        .copy(flight.position)
        .addScaledVector(flight.forward, 0.72 * fly)
        .addScaledVector(flight.up, 0.16 * fly + 0.72 * (1 - fly));
      const look = this._target.copy(eye).addScaledVector(dir, 20);
      chasePos.lerp(eye, this.firstPersonBlend);
      chaseTarget.lerp(look, this.firstPersonBlend);
    }

    // Showcase framing for the title screen: low, front three-quarter, hero off-centre.
    let position = chasePos;
    let target = chaseTarget;
    const introMix = easeInOutCubic(clamp(this.intro, 0, 1));
    if (introMix > 0.0005) {
      const azimuth = flight.yaw + this.introAzimuth + Math.sin(this.time * 0.07) * 0.16;
      const introPos = this._introPos.set(
        flight.position.x + Math.sin(azimuth) * 6.4,
        flight.position.y + 0.1,
        flight.position.z + Math.cos(azimuth) * 6.4,
      );
      // Landscape: hero on the right third. Portrait: hero centred low, under the title.
      const portrait = clamp((1.15 - this.camera.aspect) / 0.6, 0, 1);
      const side = this._offset.set(Math.cos(azimuth), 0, -Math.sin(azimuth)).multiplyScalar(-1.25 * (1 - portrait));
      const introTarget = this._introTarget.copy(flight.position).add(side);
      introTarget.y += lerp(0.45, 1.7, portrait);
      // Swing on a sphere around the hero so the move never passes through the body.
      this._spherical.setFromVector3(this._offset.copy(chasePos).sub(flight.position));
      this._sphericalB.setFromVector3(introPos.clone().sub(flight.position));
      const s = this._spherical;
      s.radius = lerp(s.radius, this._sphericalB.radius, introMix);
      s.phi = lerp(s.phi, this._sphericalB.phi, introMix);
      s.theta = s.theta + wrapAngle(this._sphericalB.theta - s.theta) * introMix;
      position = this._pos.setFromSpherical(s).add(flight.position);
      target = this._target.copy(chaseTarget).lerp(introTarget, introMix);
    }

    // Keep out of walls and the ground: cast from the hero toward the camera.
    const toCamera = this._offset.copy(position).sub(flight.position);
    const wanted = toCamera.length();
    if (wanted > 0.5 && this.firstPersonBlend < 0.5) {
      toCamera.divideScalar(wanted);
      const hit = world.raycast(flight.position, toCamera, wanted + 0.8);
      const allowed = Math.max(0.9, hit - 0.8);
      this.clearance = allowed < this.clearance ? damp(this.clearance, allowed, 30, dt) : damp(this.clearance, allowed, 2.5, dt);
      if (this.clearance < wanted) position = this._pos.copy(flight.position).addScaledVector(toCamera, this.clearance);
    }
    const ground = Math.max(world.groundHeight(position.x, position.z), 0) + 1.1;
    if (position.y < ground) position.y = ground;

    // Speed buffeting and impact shake: tiny, and gone quickly.
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const buffet = 0.1 * speedShare * flight.boostBlend * (1 - this.firstPersonBlend * 0.5);
    const shake = Math.pow(Math.min(1, this.trauma + buffet), 2);
    const t = this.time * 18;
    const camUp = this._camUp.copy(up).multiplyScalar(Math.cos(this.roll)).addScaledVector(right, Math.sin(this.roll));
    const rollShake = wobble(t, 3.1) * 0.04 * shake;
    camUp.applyAxisAngle(dir, rollShake * (1 - introMix));
    if (introMix > 0) camUp.lerp(WORLD_UP, introMix).normalize();

    this.camera.position.copy(position);
    this.camera.position.x += wobble(t, 0.3) * 0.25 * shake;
    this.camera.position.y += wobble(t, 1.7) * 0.25 * shake;
    this.camera.up.copy(camUp);
    this.camera.lookAt(target);

    this.fovKick = damp(this.fovKick, 0, 2.2, dt);
    const chaseFov = lerp(CAMERA.fov, CAMERA.boostFov, speedShare);
    const baseFov = lerp(chaseFov, CAMERA.firstPersonFov + speedShare * 10, this.firstPersonBlend);
    const introFov = lerp(40, 52, clamp((1.15 - this.camera.aspect) / 0.6, 0, 1));
    const fov = lerp(baseFov, introFov, introMix) + this.fovKick;
    this.camera.near = this.firstPersonBlend > 0.5 ? 0.12 : 0.3;
    if (Math.abs(fov - this.camera.fov) > 0.01 || this.camera.near !== this._lastNear) {
      this.camera.fov = fov;
      this._lastNear = this.camera.near;
      this.camera.updateProjectionMatrix();
    }
  }
}
