import { Quaternion, Vector3 } from '../core/math';

// Keeps the last two simulated poses of one object so rendering can interpolate between
// fixed steps (60 Hz sim on a 144 Hz display, or 0.12x slow motion, still looks smooth).

export class InterpolatedPose {
  readonly previousPosition = new Vector3();
  readonly currentPosition = new Vector3();
  readonly previousQuaternion = new Quaternion();
  readonly currentQuaternion = new Quaternion();

  /** Call once after every sim step. */
  capture(position: Vector3, quaternion: Quaternion): void {
    this.previousPosition.copy(this.currentPosition);
    this.previousQuaternion.copy(this.currentQuaternion);
    this.currentPosition.copy(position);
    this.currentQuaternion.copy(quaternion);
  }

  /** Jump without interpolating (spawn, restart, teleport). */
  snap(position: Vector3, quaternion: Quaternion): void {
    this.previousPosition.copy(position);
    this.currentPosition.copy(position);
    this.previousQuaternion.copy(quaternion);
    this.currentQuaternion.copy(quaternion);
  }

  sample(alpha: number, outPosition: Vector3, outQuaternion?: Quaternion): void {
    outPosition.lerpVectors(this.previousPosition, this.currentPosition, alpha);
    outQuaternion?.slerpQuaternions(this.previousQuaternion, this.currentQuaternion, alpha);
  }
}
