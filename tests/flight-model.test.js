import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FlightModel } from '../src/flight-model.js';
import { FLIGHT } from '../src/flight-tuning.js';

const DT = 1 / 60;

// Open sea at y = 0, optionally with one box-shaped tower.
function makeWorld({ tower = null } = {}) {
  return {
    groundHeight: () => -40,
    nearestSurface: () => Infinity,
    collideSphere(p, r, normal) {
      if (!tower) return false;
      const q = new THREE.Vector3(
        THREE.MathUtils.clamp(p.x, tower.min.x, tower.max.x),
        THREE.MathUtils.clamp(p.y, tower.min.y, tower.max.y),
        THREE.MathUtils.clamp(p.z, tower.min.z, tower.max.z),
      );
      const d = p.clone().sub(q);
      const dist = d.length();
      if (dist >= r || dist === 0) return false;
      normal.copy(d).divideScalar(dist);
      p.addScaledVector(normal, r - dist);
      return true;
    },
  };
}

function fly(model, seconds, input = {}) {
  const controls = { steerX: 0, steerY: 0, boost: false, brake: false, ...input };
  for (let t = 0; t < seconds; t += DT) model.update(DT, controls);
}

function launched(position = new THREE.Vector3(0, 300, 0)) {
  const model = new FlightModel(makeWorld());
  model.reset(position, 0);
  model.launch();
  return model;
}

test('launch leaves hover and settles at cruise speed', () => {
  const model = launched();
  assert.equal(model.mode, 'flying');
  fly(model, 6);
  assert.ok(Math.abs(model.speed - FLIGHT.cruiseSpeed) < 1, `speed ${model.speed}`);
});

test('boost reaches boost speed within four seconds and fires one shockwave', () => {
  const model = launched();
  fly(model, 2);
  model.takeEvents();
  fly(model, 4, { boost: true });
  assert.ok(model.speed > FLIGHT.boostSpeed * 0.97, `speed ${model.speed}`);
  const booms = model.takeEvents().filter((e) => e.type === 'boom');
  assert.equal(booms.length, 1);
});

test('releasing boost glides back down to cruise, not to a stop', () => {
  const model = launched();
  fly(model, 4, { boost: true });
  fly(model, 12);
  assert.ok(Math.abs(model.speed - FLIGHT.cruiseSpeed) < 1.5, `speed ${model.speed}`);
});

test('full right stick turns right and banks right, within limits', () => {
  const model = launched();
  fly(model, 2);
  const startYaw = model.yaw;
  fly(model, 1.5, { steerX: 1 });
  assert.ok(model.yaw < startYaw - 0.8, 'yaw decreases when turning right');
  assert.ok(model.bank > 0.5, `bank ${model.bank}`);
  assert.ok(model.bank <= FLIGHT.bankMax + 1e-6, 'bank is capped');
  assert.ok(model.right.y < 0, 'right side dips into the turn');
});

test('pitch follows the stick and levels out on release', () => {
  const model = launched();
  fly(model, 3, { steerY: 1 });
  assert.ok(model.pitch > FLIGHT.pitchMax * 0.9, `pitch ${model.pitch}`);
  fly(model, 3);
  assert.ok(Math.abs(model.pitch) < 0.03, `pitch ${model.pitch}`);
});

test('a steep dive builds speed; a steep climb bleeds it but never stalls', () => {
  const diver = launched(new THREE.Vector3(0, 2300, 0));
  fly(diver, 5, { steerY: -1 });
  assert.ok(diver.speed > FLIGHT.cruiseSpeed + 15, `dive speed ${diver.speed}`);

  const climber = launched();
  fly(climber, 8, { steerY: 1 });
  assert.ok(climber.speed < FLIGHT.cruiseSpeed, `climb speed ${climber.speed}`);
  assert.ok(climber.speed >= FLIGHT.minFlightSpeed - 1e-6, 'never below minimum flight speed');
});

test('holding brake settles into a hover; boost launches again', () => {
  const model = launched();
  fly(model, 3, { boost: true });
  fly(model, 5, { brake: true });
  assert.equal(model.mode, 'hover');
  assert.ok(model.speed < 1, `hover speed ${model.speed}`);
  fly(model, 0.1, { boost: true });
  assert.equal(model.mode, 'flying');
});

test('diving into the sea skims the surface instead of going under', () => {
  const model = launched(new THREE.Vector3(0, 60, 0));
  fly(model, 6, { steerY: -1, boost: true });
  assert.ok(model.position.y >= FLIGHT.radius - 1e-6, `y ${model.position.y}`);
  assert.ok(model.speed > FLIGHT.cruiseSpeed, 'keeps its momentum');
  assert.ok(model.takeEvents().some((e) => e.type === 'splash'), 'a splash is reported');
});

test('flying into a tower glances off without passing through', () => {
  const tower = { min: new THREE.Vector3(-20, 0, 60), max: new THREE.Vector3(20, 400, 100) };
  const model = new FlightModel(makeWorld({ tower }));
  model.reset(new THREE.Vector3(5, 100, 0), 0);
  model.launch();
  fly(model, 4, { boost: true });
  const p = model.position;
  const inside = p.x > tower.min.x && p.x < tower.max.x && p.z > tower.min.z && p.z < tower.max.z && p.y < tower.max.y;
  assert.ok(!inside, `ended inside the tower at ${p.toArray()}`);
  assert.ok(model.speed >= FLIGHT.minFlightSpeed, 'keeps flying after the hit');
});

test('the world edge turns the hero back toward the city', () => {
  const model = launched(new THREE.Vector3(0, 300, FLIGHT.worldRadius - 200));
  fly(model, 60, { boost: true });
  const distance = Math.hypot(model.position.x, model.position.z);
  assert.ok(distance < FLIGHT.worldRadius + 950, `distance ${distance}`);
});

test('garbage input and frame spikes never produce NaN', () => {
  const model = launched();
  const inputs = [
    { steerX: NaN, steerY: Infinity, boost: true },
    { steerX: 7, steerY: -9 },
    null,
    { steerX: -1, steerY: 1, brake: true, boost: true },
  ];
  for (let i = 0; i < 400; i++) {
    const dt = i % 50 === 0 ? 0.5 : DT;
    model.update(dt, inputs[i % inputs.length]);
  }
  for (const value of [...model.position.toArray(), ...model.velocity.toArray(), model.yaw, model.pitch, model.bank, model.speed]) {
    assert.ok(Number.isFinite(value), 'state stays finite');
  }
  assert.ok(Math.abs(model.pitch) <= FLIGHT.pitchMax + 1e-6);
});
