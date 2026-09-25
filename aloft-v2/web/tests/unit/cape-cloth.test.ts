import { Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { CapeCloth } from '../../src/present/render/hero/cape-cloth';

// Ported from v1 (tests/cape-cloth.test.js), same assertions.

const DT = 1 / 60;

// Anchors across the shoulders, hero facing +Z, back toward -Z.
function shoulderAnchors(cols: number): Float32Array {
  const anchors = new Float32Array(cols * 3);
  for (let c = 0; c < cols; c++) {
    anchors[c * 3] = 0.18 - (0.36 * c) / (cols - 1);
    anchors[c * 3 + 1] = 0.45;
    anchors[c * 3 + 2] = -0.1;
  }
  return anchors;
}

function setup() {
  const cape = new CapeCloth();
  const anchors = shoulderAnchors(cape.cols);
  cape.drape(anchors, new Vector3(0, -1, 0), new Vector3(0, 0, -1));
  const capsule = { a: new Vector3(0, 0.42, -0.03), b: new Vector3(0, -0.95, -0.03), radius: 0.19 };
  return { cape, anchors, capsule };
}

function hemAverage(cape: CapeCloth): Vector3 {
  const row = cape.rows - 1;
  const sum = new Vector3();
  for (let c = 0; c < cape.cols; c++) {
    const i = (row * cape.cols + c) * 3;
    sum.add(new Vector3(cape.pos[i], cape.pos[i + 1], cape.pos[i + 2]));
  }
  return sum.divideScalar(cape.cols);
}

describe('cape cloth', () => {
  test('at rest the cape hangs down behind the shoulders', () => {
    const { cape, anchors, capsule } = setup();
    const still = new Vector3();
    for (let i = 0; i < 180; i++) {
      cape.setAnchors(anchors);
      cape.step(DT, still, still, capsule);
    }
    const hem = hemAverage(cape);
    expect(hem.y, `hem y ${hem.y}`).toBeLessThan(-0.7);
    expect(cape.isFinite()).toBe(true);
  });

  test('in fast forward flight the cape streams out behind', () => {
    const { cape, anchors, capsule } = setup();
    const velocity = new Vector3(0, 0, 100);
    const none = new Vector3();
    for (let i = 0; i < 240; i++) {
      cape.setAnchors(anchors);
      cape.step(DT, velocity, none, capsule);
    }
    const hem = hemAverage(cape);
    expect(hem.z, `hem z ${hem.z}`).toBeLessThan(-1);
    expect(cape.isFinite()).toBe(true);
  });

  test('violent manoeuvres at extreme speed never tear or explode the cloth', () => {
    const { cape, anchors, capsule } = setup();
    const velocity = new Vector3();
    const accel = new Vector3();
    const moving = new Float32Array(anchors.length);
    for (let i = 0; i < 900; i++) {
      const t = i * DT;
      velocity.set(Math.sin(t * 3) * 150, Math.cos(t * 5) * 80, Math.cos(t * 2) * 150);
      accel.set(Math.cos(t * 3) * 450, -Math.sin(t * 5) * 400, -Math.sin(t * 2) * 300);
      for (let k = 0; k < anchors.length; k++) moving[k] = anchors[k] + Math.sin(t * 7 + k) * 0.05;
      cape.setAnchors(moving);
      cape.step(i % 97 === 0 ? 0.05 : DT, velocity, accel, capsule);
    }
    expect(cape.isFinite(), 'positions stay finite').toBe(true);
    for (let i = cape.cols; i < cape.count; i++) {
      const c = i % cape.cols;
      const dx = cape.pos[i * 3] - cape.anchors[c * 3];
      const dy = cape.pos[i * 3 + 1] - cape.anchors[c * 3 + 1];
      const dz = cape.pos[i * 3 + 2] - cape.anchors[c * 3 + 2];
      expect(Math.hypot(dx, dy, dz), 'no point strays far past its tether').toBeLessThanOrEqual(cape.tether[i] + 0.25);
    }
  });
});
