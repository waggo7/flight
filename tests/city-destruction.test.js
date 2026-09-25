import test from 'node:test';
import assert from 'node:assert/strict';
import { planSplit } from '../src/city-destruction.js';

// A stepped tower: two tiers, a crown, a spire and a beacon.
function tower() {
  return [
    { ref: { kind: 'box', index: 0 }, bottom: 0, top: 60 },
    { ref: { kind: 'box', index: 1 }, bottom: 60, top: 90 },
    { ref: { kind: 'box', index: 2 }, bottom: 90, top: 95 },
    { ref: { kind: 'spire', index: 0 }, bottom: 95, top: 130 },
    { ref: { kind: 'beacon', index: 0 }, bottom: 131, top: 131 },
  ];
}

test('a break through a tier leaves a stump and drops everything above it', () => {
  const plan = planSplit(tower(), 75);
  assert.deepEqual(plan.keep.map((p) => p.ref.index), [0]);
  assert.equal(plan.shorten.length, 1);
  assert.equal(plan.shorten[0].top, 75);
  assert.equal(plan.fall.length, 4);
  const upperPart = plan.fall.find((p) => p.ref.kind === 'box' && p.ref.index === 1);
  assert.deepEqual([upperPart.bottom, upperPart.top], [75, 90]);
  assert.ok(plan.fall.some((p) => p.ref.kind === 'spire'), 'the spire goes with the section');
  assert.ok(plan.fall.some((p) => p.ref.kind === 'beacon'), 'so does the beacon');
});

test('a break exactly on a joint never leaves a zero-height stump', () => {
  const plan = planSplit(tower(), 60);
  assert.equal(plan.shorten.length, 0);
  assert.deepEqual(plan.keep.map((p) => p.ref.index), [0]);
  assert.equal(plan.fall.length, 4);
});

test('a break at the base drops the whole building; one above the top drops nothing', () => {
  assert.equal(planSplit(tower(), 0).fall.length, 5);
  const above = planSplit(tower(), 500);
  assert.equal(above.fall.length, 0);
  assert.equal(above.keep.length, 5);
});

test('planning a split never mutates the building it describes', () => {
  const pieces = tower();
  const before = JSON.stringify(pieces);
  planSplit(pieces, 42);
  planSplit(pieces, 92.5);
  assert.equal(JSON.stringify(pieces), before);
});

test('every metre of the building is accounted for exactly once', () => {
  for (const height of [0.5, 17, 60, 60.004, 91, 94.99, 129]) {
    const plan = planSplit(tower(), height);
    const solid = (list) => list.filter((p) => p.ref.kind === 'box').reduce((sum, p) => sum + (p.top - p.bottom), 0);
    const total = solid(plan.keep) + solid(plan.shorten) + solid(plan.fall);
    assert.ok(Math.abs(total - 95) < 1e-6, `height ${height}: ${total}`);
  }
});
