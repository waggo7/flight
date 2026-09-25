import type { WorldPoint } from '../core/building-structure';
import type { CityBlueprint } from '../core/city-blueprint';
import type { FlightModel, SmashOutcome } from '../core/flight-model';
import type { FlightTuning } from '../core/flight-tuning';
import { Vector3 } from '../core/math';
import { GrabTimeline, SlamTimeline, type PowersTuning } from '../core/power-timelines';
import type { EventBus, GameEventMap } from '../engine/event-bus';
import type { DestructionSystem } from './destruction-system';
import type { PhysicsWorld } from './physics-world';
import type { RapierCityWorld, WorldHit } from './rapier-city-world';

// The hero's powers in the world. Ground slam: a short windup, a dive at 1.6× boost speed (or an
// instant slam near the ground), then a blast — buildings in the radius take a base crush with an
// outward push (so they topple away), loose pieces are shoved out, and the street shakes.
// Grab and throw: the best piece within reach ahead rides a spring-damped hold point; a second
// press throws it at the hero's velocity plus 80 m/s along the view, and for 5 s whatever
// building it hits takes the blow. Ramming a building while holding adds the piece's mass to the
// smash and shatters it.

declare module '../engine/event-bus' {
  interface GameEventMap {
    'power:slam': { position: WorldPoint; radius: number; speed: number; instant: boolean };
    'power:grab': { position: WorldPoint; mass: number };
    'power:throw': { position: WorldPoint; velocity: WorldPoint };
    'power:dive': { position: WorldPoint };
  }
}

const DOWN = new Vector3(0, -1, 0);
const scratch = new Vector3();
const normal = new Vector3();
const previous = new Vector3();

export class PowerSystem {
  readonly slam: SlamTimeline;
  readonly grab: GrabTimeline;
  /** Body handle of the piece being carried, or null. */
  held: number | null = null;
  /** Where the camera looks (throws follow it). */
  readonly aim = new Vector3(0, 0, 1);
  private readonly dive = new Vector3();
  private diveSpeed = 0;
  private readonly impactPoint = new Vector3();
  private impactSpeed = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly world: RapierCityWorld,
    private readonly destruction: DestructionSystem,
    private readonly blueprint: CityBlueprint,
    private readonly flight: FlightModel,
    private readonly flightTuning: FlightTuning,
    private readonly tuning: PowersTuning,
    private readonly events: EventBus<GameEventMap>,
  ) {
    this.slam = new SlamTimeline(tuning.slam);
    this.grab = new GrabTimeline(tuning.grab);
  }

  // ----- input ----------------------------------------------------------------------------

  pressSlam(): void {
    const p = this.flight.position;
    const floor = this.world.floorAt(p.x, p.z, p.y);
    if (!this.slam.press(p.y - this.flightTuning.radius - floor)) return;
    if (this.slam.phase === 'impact') {
      this.impactPoint.set(p.x, floor + this.flightTuning.radius, p.z);
      this.impactSpeed = Math.max(this.flight.speed, 20);
    }
  }

  pressGrab(): void {
    const action = this.grab.press();
    if (action !== 'grab') return;
    const hero = this.flight.position;
    const forward = this.flight.forward;
    const reach = this.tuning.grab.reach;
    const centre = { x: hero.x + forward.x * reach * 0.5, y: hero.y + forward.y * reach * 0.5, z: hero.z + forward.z * reach * 0.5 };
    let best: { body: number; score: number; mass: number } | null = null;
    for (const piece of this.destruction.fragmentsNear(centre, reach)) {
      if (piece.level === 0 || piece.massReal > this.tuning.grab.maxMass) continue;
      scratch.set(piece.centre.x - hero.x, piece.centre.y - hero.y, piece.centre.z - hero.z);
      const distance = scratch.length();
      if (distance > reach + 4) continue;
      const ahead = distance > 1e-3 ? scratch.dot(forward) / distance : 1;
      if (ahead < 0.2) continue;
      const score = distance - ahead * 6 - Math.min(piece.massReal / 50000, 4);
      if (!best || score < best.score) best = { body: piece.body, score, mass: piece.massReal };
    }
    if (!best || !this.destruction.hold(best.body)) return;
    this.held = best.body;
    this.grab.grabbed();
    this.events.emit('power:grab', { position: { x: hero.x, y: hero.y, z: hero.z }, mass: best.mass });
  }

  /** The flight model's smash hook while powers are active: ramming with a held piece adds its mass. */
  smash(hit: WorldHit, point: WorldPoint, velocity: WorldPoint, impact: number): SmashOutcome | null {
    const extra = this.held !== null ? this.destruction.massOf(this.held) : 0;
    const outcome = this.destruction.heroHit(hit, point, velocity, impact, extra);
    if (outcome && this.held !== null && hit.owner.kind === 'building') {
      this.destruction.shatter(this.held);
      this.held = null;
      this.grab.lost();
    }
    return outcome;
  }

  // ----- stepping -------------------------------------------------------------------------

  /** Powers phase: advance the timelines and carry what's held. */
  step(dt: number): void {
    for (const event of this.slam.step(dt)) {
      if (event.type === 'slam-dive') this.startDive();
      else if (event.type === 'slam-impact') this.blast(event.instant);
    }
    for (const event of this.grab.step(dt)) if (event.type === 'grab-throw') this.throwHeld();
    this.carry();
  }

  /**
   * Hero phase, instead of the flight model while the slam owns the hero. Returns false when the
   * flight model should run as usual.
   */
  moveHero(dt: number): boolean {
    if (!this.slam.controlsHero) {
      if (this.held !== null) this.flight.speed = Math.min(this.flight.speed, this.flightTuning.boostSpeed * this.tuning.grab.carrySpeedShare);
      return false;
    }
    const model = this.flight;
    const p = model.position;
    const radius = this.flightTuning.radius;
    switch (this.slam.phase) {
      case 'windup':
        // Hang for a beat: speed bleeds off, a small rise.
        model.velocity.multiplyScalar(Math.exp(-6 * dt));
        model.velocity.y += 6 * dt;
        p.addScaledVector(model.velocity, dt);
        break;
      case 'dive': {
        previous.copy(p);
        p.addScaledVector(this.dive, this.diveSpeed * dt);
        model.velocity.copy(this.dive).multiplyScalar(this.diveSpeed);
        // Walls only push the hero aside (it slides down them); the slam lands on a floor, a roof,
        // or any ledge that holds it up (a push-out pointing up, or no progress down).
        const pushed = this.world.resolveSphere(p, previous, radius, normal) !== null;
        const floor = this.world.floorAt(p.x, p.z, previous.y);
        const onLedge = pushed && (normal.y > 0.5 || previous.y - p.y < this.diveSpeed * dt * 0.25);
        if (p.y - radius <= floor || onLedge) {
          if (p.y - radius < floor) p.y = floor + radius;
          this.impactPoint.copy(p);
          this.impactSpeed = this.diveSpeed;
          this.slam.landed();
        }
        break;
      }
      default:
        // Impact and recover: the superhero landing, still.
        model.velocity.set(0, 0, 0);
        break;
    }
    model.speed = model.velocity.length();
    model.mode = this.slam.phase === 'dive' || this.slam.phase === 'windup' ? 'flying' : 'hover';
    model.hoverBlend = this.slam.phase === 'dive' ? 0 : 1;
    model.pitch = this.slam.phase === 'dive' ? -1.3 : 0;
    if (this.slam.phase === 'recover') model.speed = 0;
    return true;
  }

  reset(): void {
    this.slam.reset();
    this.grab.reset();
    this.held = null;
  }

  // ----- slam -----------------------------------------------------------------------------

  private startDive(): void {
    const forward = this.flight.forward;
    this.dive.set(forward.x * 0.08, 0, forward.z * 0.08).add(DOWN).normalize();
    this.diveSpeed = this.tuning.slam.diveSpeedScale * this.flightTuning.boostSpeed;
    const p = this.flight.position;
    this.events.emit('power:dive', { position: { x: p.x, y: p.y, z: p.z } });
  }

  private blast(instant: boolean): void {
    const s = this.tuning.slam;
    const point = { x: this.impactPoint.x, y: this.impactPoint.y, z: this.impactPoint.z };
    const speed = this.impactSpeed;
    const boost = this.flightTuning.boostSpeed;
    const full = s.diveSpeedScale * boost;
    const share = instant ? 0 : Math.min(1, Math.max(0, (speed - boost * 0.5) / (full - boost * 0.5)));
    const radius = s.radius.min + (s.radius.max - s.radius.min) * share;
    const energy = 0.5 * s.mass * speed * speed;
    for (const target of this.buildingsWithin(point, radius)) {
      const falloff = (1 - target.distance / radius) ** 2;
      const away = { x: target.centre.x - point.x, z: target.centre.z - point.z };
      const length = Math.hypot(away.x, away.z) || 1;
      this.destruction.damageBuilding(target.building, {
        kind: 'blast',
        // The base crush reaches in from the side facing the slam, wider for bigger blasts.
        shape: { type: 'sphere', centre: target.base, radius: radius * 0.35 * (0.4 + 0.6 * falloff) },
        energy: energy * falloff * 0.6,
        speed: 0,
        impulse: 0,
        generation: 0,
        push: { x: away.x / length, z: away.z / length, impulse: s.mass * speed * falloff },
      }, target.base);
    }
    this.destruction.nudge(point, radius * 1.3, s.nudge);
    this.events.emit('power:slam', { position: point, radius, speed, instant });
  }

  /** Buildings whose structural footprint comes within `radius` of `point` (ground plane). */
  private buildingsWithin(point: WorldPoint, radius: number): { building: number; distance: number; base: WorldPoint; centre: WorldPoint }[] {
    const out: { building: number; distance: number; base: WorldPoint; centre: WorldPoint }[] = [];
    for (const building of this.blueprint.buildings) {
      if (Math.hypot(building.x - point.x, building.z - point.z) > radius + 90) continue;
      let best: { distance: number; base: WorldPoint; centre: WorldPoint } | null = null;
      for (const ref of building.pieces) {
        if (ref.kind !== 'box') continue;
        const box = this.blueprint.boxes[ref.index]!;
        if (box.role !== 'tower') continue;
        // Nearest point of the rotated footprint to the slam, in the box's frame.
        const cos = Math.cos(box.yaw);
        const sin = Math.sin(box.yaw);
        const dx = point.x - box.x;
        const dz = point.z - box.z;
        const lx = dx * cos - dz * sin;
        const lz = dx * sin + dz * cos;
        const cx = Math.max(-box.w / 2 + 2, Math.min(box.w / 2 - 2, lx));
        const cz = Math.max(-box.d / 2 + 2, Math.min(box.d / 2 - 2, lz));
        const distance = Math.hypot(lx - Math.max(-box.w / 2, Math.min(box.w / 2, lx)), lz - Math.max(-box.d / 2, Math.min(box.d / 2, lz)));
        if (distance > radius || (best && distance >= best.distance)) continue;
        const base = { x: box.x + cx * cos + cz * sin, y: Math.max(point.y, box.y0 + 2), z: box.z - cx * sin + cz * cos };
        best = { distance, base, centre: { x: box.x, y: box.y0, z: box.z } };
      }
      if (best) out.push({ building: building.id, ...best });
    }
    return out;
  }

  // ----- grab and throw -------------------------------------------------------------------

  private carry(): void {
    if (this.held === null) return;
    if (!this.destruction.isLoose(this.held)) {
      this.held = null;
      this.grab.lost();
      return;
    }
    const g = this.tuning.grab;
    const hero = this.flight.position;
    const forward = this.flight.forward;
    const body = this.physics.world.getRigidBody(this.held);
    const com = body.worldCom();
    const target = scratch.set(hero.x + forward.x * g.holdDistance, hero.y + g.holdHeight, hero.z + forward.z * g.holdDistance);
    const hv = this.flight.velocity;
    const vx = (target.x - com.x) / g.holdResponse + hv.x;
    const vy = (target.y - com.y) / g.holdResponse + hv.y;
    const vz = (target.z - com.z) / g.holdResponse + hv.z;
    body.setLinvel({ x: vx, y: vy, z: vz }, true);
    const w = body.angvel();
    body.setAngvel({ x: w.x * 0.85, y: w.y * 0.85, z: w.z * 0.85 }, true);
  }

  private throwHeld(): void {
    if (this.held === null) return;
    const hv = this.flight.velocity;
    const speed = this.tuning.grab.throwSpeed;
    const velocity = { x: hv.x + this.aim.x * speed, y: hv.y + this.aim.y * speed, z: hv.z + this.aim.z * speed };
    const body = this.physics.world.getRigidBody(this.held);
    const com = body.worldCom();
    this.destruction.throwHeld(this.held, velocity, this.tuning.grab.projectileSeconds);
    this.events.emit('power:throw', { position: { x: com.x, y: com.y, z: com.z }, velocity });
    this.held = null;
  }
}
