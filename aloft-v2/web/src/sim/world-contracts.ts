import type { FlightWorld } from '../core/flight-model';
import type { Vector3 } from '../core/math';

// What the camera needs from the world. Implemented by the grey-box world now and the
// Rapier world from M2.
export interface CameraWorld {
  /** Distance along `direction` to the first solid surface, or `maxDistance` on a miss. */
  raycast(origin: Vector3, direction: Vector3, maxDistance: number): number;
  groundHeight(x: number, z: number): number;
}

export interface GameWorld<Hit = unknown> extends FlightWorld<Hit>, CameraWorld {}
