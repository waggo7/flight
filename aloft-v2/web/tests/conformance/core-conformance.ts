import { BuildingStructure } from '../../src/core/building-structure';
import { FacadeStyle } from '../../src/core/city-blueprint';
import { applyDamage } from '../../src/core/crush-planner';
import type { DestructionTuning } from '../../src/core/destruction-tuning';
import { GrabTimeline, SlamTimeline, type PowersTuning } from '../../src/core/power-timelines';
import { boxStoreyLayout, roundStoreyLayout } from '../../src/core/storey-layout';
import { checkSupport } from '../../src/core/support-check';
import { syntheticCity } from '../fixtures/synthetic-city';

// Golden vectors for the portable destruction and power modules: storey layouts, crush plans and
// support verdicts for a matrix of hits, and power timelines under scripted presses. The Godot
// port replays the same inputs (at pivot time) and must reproduce these outputs.

const round = (v: number): number => Math.round(v * 1e9) / 1e9;

export interface CoreConformanceFile {
  storeyLayouts: { input: Record<string, number>; shape: 'box' | 'round'; layout: ReturnType<typeof boxStoreyLayout> }[];
  hits: {
    tower: { w: number; d: number; h: number; style: number; yaw: number };
    hit: { speed: number; y: number; dirYaw: number; offset: number };
    outcome: string;
    crushed: number[];
    storeys: { segment: number; storey: number }[];
    failure: null | { kind: string; segment: number; storey: number; lean: [number, number] | null };
    strain: null | { storey: number; loadRatio: number };
  }[];
  timelines: { name: string; steps: string[] }[];
}

export function buildCoreConformance(destruction: DestructionTuning, powers: PowersTuning): CoreConformanceFile {
  const storeyLayouts: CoreConformanceFile['storeyLayouts'] = [];
  for (const style of [FacadeStyle.glass, FacadeStyle.stone, FacadeStyle.plain]) {
    for (const [w, d, h] of [[15, 15, 60], [22.4, 26.1, 101.3], [30, 30, 120], [46, 38, 212]] as const) {
      storeyLayouts.push({ input: { w, d, h, style }, shape: 'box', layout: boxStoreyLayout({ w, d, h, style }) });
    }
    storeyLayouts.push({ input: { radius: 16.3, h: 187, style }, shape: 'round', layout: roundStoreyLayout({ radius: 16.3, h: 187, style }) });
  }

  const hits: CoreConformanceFile['hits'] = [];
  const towers = [
    { w: 15, d: 15, h: 60, style: FacadeStyle.stone, yaw: 0 },
    { w: 22, d: 22, h: 100, style: FacadeStyle.glass, yaw: 0 },
    { w: 30, d: 30, h: 120, style: FacadeStyle.glass, yaw: 0 },
    { w: 22, d: 26, h: 100, style: FacadeStyle.glass, yaw: 0.35 },
  ];
  for (const tower of towers) {
    for (const speed of [40, 55, 70, 108]) {
      const dirYaw = tower.yaw === 0 ? 0 : 0.9;
      const hit = { speed, y: 4 + tower.h * 0.4, dirYaw, offset: 0.7 };
      const structure = new BuildingStructure(0, syntheticCity({ boxes: [tower] }), destruction);
      const dir = { x: Math.sin(dirYaw), z: Math.cos(dirYaw) };
      const right = { x: dir.z, z: -dir.x };
      const report = applyDamage(structure, {
        kind: 'blunt',
        shape: { type: 'sweep', from: { x: -dir.x * 80 + right.x * hit.offset, y: hit.y, z: -dir.z * 80 + right.z * hit.offset }, direction: { x: dir.x, y: 0, z: dir.z }, radius: 1.2 + destruction.tunnelClearance },
        energy: 0.5 * destruction.punchMass * speed * speed,
        speed,
        impulse: destruction.punchMass * speed,
        generation: 0,
      }, destruction);
      const verdict = checkSupport(structure, report.storeys, destruction, report.push);
      hits.push({
        tower, hit, outcome: report.outcome,
        crushed: [...report.crushed, ...verdict.crushed].sort((a, b) => a - b),
        storeys: report.storeys,
        failure: verdict.failure && {
          kind: verdict.failure.kind, segment: verdict.failure.segment, storey: verdict.failure.storey,
          lean: verdict.failure.hinge ? [round(verdict.failure.hinge.lean.x), round(verdict.failure.hinge.lean.z)] : null,
        },
        strain: verdict.strain && { storey: verdict.strain.storey, loadRatio: round(verdict.strain.loadRatio) },
      });
    }
  }

  const DT = 1 / 60;
  const timelines: CoreConformanceFile['timelines'] = [];
  const slamScript = (name: string, clearance: number, landAt: number | null, frames: number): void => {
    const slam = new SlamTimeline(powers.slam);
    const steps: string[] = [];
    slam.press(clearance);
    for (let i = 0; i < frames; i++) {
      if (landAt !== null && i === landAt) slam.landed();
      const events = slam.step(DT).map((e) => e.type).join('+');
      if (i % 30 === 29) slam.press(clearance); // presses during a slam are ignored until it is ready again
      steps.push(events ? `${slam.phase}:${events}` : slam.phase);
    }
    timelines.push({ name, steps });
  };
  slamScript('slam from high, lands on frame 60', 150, 60, 240);
  slamScript('slam near the ground', 5, null, 200);
  slamScript('slam that never lands', 400, null, 420);
  const grab = new GrabTimeline(powers.grab);
  const grabSteps: string[] = [];
  for (let i = 0; i < 60; i++) {
    if (i === 3) grab.press();
    if (i === 5) grab.press();
    if (i === 6) grab.grabbed();
    if (i === 20) grab.press();
    if (i === 22) grab.press();
    const events = grab.step(DT).map((e) => e.type).join('+');
    grabSteps.push(events ? `${grab.phase}:${events}` : grab.phase);
  }
  timelines.push({ name: 'grab, hold, throw', steps: grabSteps });
  return { storeyLayouts, hits, timelines };
}
