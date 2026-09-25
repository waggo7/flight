import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { HERO_POSE_JOINTS, HERO_POSE_NAMES } from '../../src/core/hero-pose-graph';
import { loadContent } from '../../src/engine/content-library';
import { POSE_CASES, runPoseCase, withoutNotes, type PoseConformanceFile } from '../conformance/hero-pose-conformance';

// The committed vectors are the contract the Godot port (godot/core/hero_pose_graph.gd) must
// also meet. If this fails after an intended change, run `npm run conformance:write`.

const file = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../conformance/hero-pose-graph.json', import.meta.url)), 'utf8'),
) as PoseConformanceFile;

describe('hero pose graph conformance vectors', () => {
  test('the vectors were generated from the shipped pose library and the current case list', () => {
    expect(file.library).toEqual(withoutNotes(loadContent().poses));
    expect(file.joints).toEqual([...HERO_POSE_JOINTS]);
    expect(file.poses).toEqual([...HERO_POSE_NAMES]);
    expect(file.cases.map((c) => c.name)).toEqual(POSE_CASES.map((c) => c.name));
  });

  for (const recorded of file.cases) {
    test(`replays "${recorded.name}" exactly`, () => {
      expect(runPoseCase(recorded, file.library, file.dt)).toEqual(recorded.samples);
    });
  }
});
