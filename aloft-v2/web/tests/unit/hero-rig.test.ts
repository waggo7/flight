import { Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { HERO_POSE_JOINTS, HERO_POSE_NAMES, HeroPoseGraph, IDLE_ACTIONS, type HeroPoseInput } from '../../src/core/hero-pose-graph';
import { loadContent } from '../../src/engine/content-library';
import { CapeCloth } from '../../src/present/render/hero/cape-cloth';
import { buildHeroRig } from '../../src/present/render/hero/hero-rig';

const content = loadContent();
const DT = 1 / 60;
const CRUISE: HeroPoseInput = {
  hoverBlend: 0, boostBlend: 0.4, speedShare: 0.4, pitch: -0.2, bank: 0.3, yawRate: 0.4, steerX: 0.5, brake: 0, actions: { ...IDLE_ACTIONS }, look: { x: 0.3, y: 0, z: 1, weight: 1 },
};

describe('hero rig', () => {
  for (const hero of content.heroes) {
    test(`${hero.id}: ≤ 4 draw calls with the cape, ≤ 30k triangles, 25 bones, all weights valid`, () => {
      const rig = buildHeroRig(hero.look);
      const stats = rig.stats();
      expect(stats.bones).toBe(HERO_POSE_JOINTS.length);
      expect(stats.drawCalls + (hero.look.cape ? 1 : 0)).toBeLessThanOrEqual(4);
      const cape = hero.look.cape ? new CapeCloth({ topWidth: rig.capeTopWidth, bottomWidth: hero.look.cape.width, length: hero.look.cape.length }) : null;
      const capeTriangles = cape ? (cape.geometry.getIndex()?.count ?? 0) / 3 : 0;
      expect(stats.triangles + capeTriangles).toBeLessThanOrEqual(30_000);
      for (const mesh of rig.meshes) {
        const weights = mesh.geometry.getAttribute('skinWeight');
        const indices = mesh.geometry.getAttribute('skinIndex');
        for (let i = 0; i < weights.count; i++) {
          const sum = weights.getX(i) + weights.getY(i) + weights.getZ(i) + weights.getW(i);
          expect(sum).toBeCloseTo(1, 5);
          expect(indices.getX(i)).toBeLessThan(HERO_POSE_JOINTS.length);
          expect(indices.getY(i)).toBeLessThan(HERO_POSE_JOINTS.length);
        }
        const positions = mesh.geometry.getAttribute('position').array;
        expect(Array.from(positions).every(Number.isFinite)).toBe(true);
      }
      rig.dispose();
    });
  }

  test('the build follows the hero: height, shoulders, cape and parts', () => {
    const [aurora, bastion, swift] = ['aurora', 'bastion', 'swift'].map((id) => content.heroes.find((h) => h.id === id)!);
    const heightOf = (rig: ReturnType<typeof buildHeroRig>): number => {
      let min = Infinity;
      let max = -Infinity;
      for (const mesh of rig.meshes) {
        mesh.geometry.computeBoundingBox();
        min = Math.min(min, mesh.geometry.boundingBox!.min.y);
        max = Math.max(max, mesh.geometry.boundingBox!.max.y);
      }
      return max - min;
    };
    const rigs = [aurora, bastion, swift].map((hero) => buildHeroRig(hero!.look));
    rigs.forEach((rig, i) => expect(heightOf(rig)).toBeCloseTo([aurora, bastion, swift][i]!.look.build.height, 1));
    expect(rigs[1]!.capeTopWidth).toBeGreaterThan(rigs[2]!.capeTopWidth);
    const arms = buildHeroRig(aurora!.look, { parts: 'arms' });
    expect(arms.stats().triangles).toBeLessThan(rigs[0]!.stats().triangles / 2);
    expect(arms.stats().bones).toBe(HERO_POSE_JOINTS.length);
  });

  test('poses from the graph keep the cape frame finite and the update fast (< 0.2 ms)', () => {
    const hero = content.heroes[0]!;
    const rig = buildHeroRig(hero.look);
    const graph = new HeroPoseGraph(content.poses);
    rig.root.position.set(10, 50, -20);
    const step = (input: HeroPoseInput): void => {
      graph.update(DT, input);
      rig.applyPose(graph.rotations, graph.offset);
      rig.root.updateMatrixWorld(true);
      rig.skeleton.update();
    };
    for (const name of HERO_POSE_NAMES) {
      graph.force(name);
      for (let i = 0; i < 30; i++) step(CRUISE);
      const anchors = rig.refreshCapeFrame();
      expect(Array.from(anchors).every(Number.isFinite)).toBe(true);
      for (let i = 0; i < anchors.length; i += 3) expect(Math.hypot(anchors[i]!, anchors[i + 1]!, anchors[i + 2]!)).toBeLessThan(1.2);
    }
    graph.force(null);
    for (let i = 0; i < 200; i++) step(CRUISE);
    const runs = 2000;
    const started = performance.now();
    for (let i = 0; i < runs; i++) step(CRUISE);
    const ms = (performance.now() - started) / runs;
    expect(ms).toBeLessThan(0.2);
    const bone = new Vector3();
    rig.bones.head.getWorldPosition(bone);
    expect(Number.isFinite(bone.x + bone.y + bone.z)).toBe(true);
  });
});
