import { beforeAll, describe, expect, test } from 'vitest';
import { FacadeStyle } from '../../src/core/city-blueprint';
import { FlightModel } from '../../src/core/flight-model';
import { Vector3 } from '../../src/core/math';
import { loadRapier, type Rapier } from '../../src/sim/physics-world';
import { PowerSystem } from '../../src/sim/power-system';
import { syntheticCity, type BoxSpec } from '../fixtures/synthetic-city';
import { content, DT, destructionScene } from './destruction-scene';

let rapier: Rapier;
beforeAll(async () => {
  rapier = await loadRapier();
});

function powerScene(boxes: BoxSpec[]) {
  const city = syntheticCity({ boxes });
  // Each box its own building.
  city.boxes.forEach((b, i) => (b.building = i));
  city.buildings = city.boxes.map((b, i) => ({ id: i, x: b.x, z: b.z, pieces: [{ kind: 'box' as const, index: i }], colliders: [] }));
  const scene = destructionScene(rapier, city);
  const flight = new FlightModel(scene.world, content.flight);
  const powers = new PowerSystem(scene.physics, scene.world, scene.system, city, flight, content.flight, content.powers, scene.events);
  scene.world.smash = (hit, point, _n, velocity, impact) => powers.smash(hit, point, velocity, impact);
  const log: string[] = [];
  let maxGeneration = 0;
  scene.events.on('power:slam', (e) => log.push(`slam r=${e.radius.toFixed(0)}`));
  scene.events.on('destruction:damage', (e) => (maxGeneration = Math.max(maxGeneration, e.generation)));
  const step = (frames: number): void => {
    for (let i = 0; i < frames; i++) {
      powers.step(DT);
      if (!powers.moveHero(DT)) flight.update(DT, { steerX: 0, steerY: 0, boost: false, brake: true });
      scene.step();
    }
  };
  return { ...scene, flight, powers, step, log, get maxGeneration() { return maxGeneration; } };
}

describe('powers', () => {
  test('a full-speed slam in a ring of towers brings down at least three, knock-ons within generation 2', () => {
    const ring: BoxSpec[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ring.push({ w: 20, d: 20, h: 90, x: Math.cos(a) * 32, z: Math.sin(a) * 32, style: FacadeStyle.glass });
    }
    const s = powerScene(ring);
    s.flight.reset(new Vector3(0, 160, 0), 0);
    s.powers.pressSlam();
    expect(s.powers.slam.phase).toBe('windup');
    s.step(60 * 4);
    expect(s.log).toHaveLength(1);
    const failed = [...Array(6).keys()].filter((b) => s.system.structureOf(b)?.nodes.some((n) => n.state === 2));
    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(s.maxGeneration).toBeLessThanOrEqual(content.destruction.motion.maxGeneration);
    // The hero ends the slam standing in the street, not sunk into it.
    expect(s.flight.position.y).toBeGreaterThan(3);
    expect(['recover', 'cooldown', 'ready']).toContain(s.powers.slam.phase);
  });

  test('an 80 m/s throw topples a 15 m block', () => {
    const s = powerScene([
      { w: 30, d: 30, h: 120, x: 0, z: 0, style: FacadeStyle.glass },
      { w: 15, d: 15, h: 60, x: 0, z: 150, style: FacadeStyle.stone },
    ]);
    // Bring the tower down, then pick the heaviest piece of rubble the hero can lift.
    s.heroHit({ x: 0.7, y: 52, z: -80 }, { x: 0, y: 0, z: 1 }, 108);
    s.step(60 * 12);
    const pieces = s.system.fragmentsNear({ x: 0, y: 20, z: 60 }, 200).filter((p) => p.level > 0 && !p.debris && p.massReal <= content.powers.grab.maxMass);
    pieces.sort((a, b) => b.massReal - a.massReal);
    const piece = pieces[0]!;
    expect(piece.massReal).toBeGreaterThan(20000);
    s.flight.reset(new Vector3(piece.centre.x, piece.centre.y + 2, piece.centre.z - 6), 0);
    s.powers.pressGrab();
    expect(s.powers.held).toBe(piece.body);
    s.step(30);
    const from = s.physics.world.getRigidBody(piece.body).worldCom();
    s.powers.aim.copy(new Vector3(0, 40, 150).sub(new Vector3(from.x, from.y, from.z)).normalize());
    s.powers.pressGrab();
    s.step(60 * 6);
    const block = s.system.structureOf(1);
    expect(block).not.toBeNull();
    expect(block!.nodes.some((n) => n.state === 2)).toBe(true); // its top came loose
  });

  test('ramming a building with a held piece shatters the piece and adds its weight', () => {
    const s = powerScene([
      { w: 30, d: 30, h: 120, x: 0, z: 0, style: FacadeStyle.glass },
      { w: 22, d: 22, h: 100, x: 0, z: 120, style: FacadeStyle.glass },
    ]);
    s.heroHit({ x: 0.7, y: 52, z: -80 }, { x: 0, y: 0, z: 1 }, 108);
    s.step(10);
    const piece = s.system.fragmentsNear({ x: 0, y: 52, z: 15 }, 40).filter((p) => p.level > 0 && p.massReal < content.powers.grab.maxMass)[0]!;
    s.flight.reset(new Vector3(piece.centre.x, piece.centre.y, piece.centre.z - 6), 0);
    s.powers.pressGrab();
    const held = s.powers.held!;
    expect(held).not.toBeNull();
    const collider = s.physics.world.castRay(new rapier.Ray({ x: 0, y: 44, z: 60 }, { x: 0, y: 0, z: 1 }), 100, true, undefined, s.physics.groups.heroQuery)!.collider;
    const outcome = s.powers.smash({ collider, owner: s.physics.ownerOf(collider)! }, { x: 0, y: 44, z: 109 }, { x: 0, y: 0, z: 60 }, 60);
    expect(outcome?.brokeThrough).toBe(true);
    expect(s.system.isLoose(held)).toBe(false);
    expect(s.powers.held).toBeNull();
  });
});
