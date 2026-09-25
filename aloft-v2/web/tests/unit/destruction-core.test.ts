import { describe, expect, it } from 'vitest';
import { BuildingStructure, NodeState } from '../../src/core/building-structure';
import { FacadeStyle } from '../../src/core/city-blueprint';
import { applyDamage, type DamageReport } from '../../src/core/crush-planner';
import { checkSupport, loadRatio, type SupportVerdict } from '../../src/core/support-check';
import { loadContent } from '../../src/engine/content-library';
import { syntheticCity, type BoxSpec, type RoundSpec } from '../fixtures/synthetic-city';

const tuning = loadContent().destruction;
const HERO_RADIUS = 1.2;

function tower(spec: BoxSpec | { round: RoundSpec }): BuildingStructure {
  const city = 'round' in spec ? syntheticCity({ rounds: [spec.round] }) : syntheticCity({ boxes: [spec] });
  return new BuildingStructure(0, city, tuning);
}

/** A hero hit: flying along `dir` (unit, horizontal) at `speed`, passing `offset` metres right of the centre line, at height `y`. */
function punch(structure: BuildingStructure, speed: number, y: number, dir = { x: 0, z: 1 }, offset = 0.7): { report: DamageReport; verdict: SupportVerdict } {
  const right = { x: dir.z, z: -dir.x };
  const from = { x: -dir.x * 80 + right.x * offset, y, z: -dir.z * 80 + right.z * offset };
  const report = applyDamage(structure, {
    kind: 'blunt',
    shape: { type: 'sweep', from, direction: { x: dir.x, y: 0, z: dir.z }, radius: HERO_RADIUS + tuning.tunnelClearance },
    energy: 0.5 * tuning.punchMass * speed * speed,
    speed,
    impulse: tuning.punchMass * speed,
    generation: 0,
  }, tuning);
  return { report, verdict: checkSupport(structure, report.storeys, tuning, report.push) };
}

const leanAlong = (verdict: SupportVerdict, dir: { x: number; z: number }): number => {
  const lean = verdict.failure?.hinge?.lean;
  return lean ? lean.x * dir.x + lean.z * dir.z : NaN;
};

describe('building structure', () => {
  it('stacks storeys one window row high and carries the load above each', () => {
    const s = tower({ w: 30, d: 30, h: 120, style: FacadeStyle.glass });
    const layout = s.segments[0]!.layout;
    expect(layout.storeys).toBe(Math.round(120 / 3.45));
    const loads = s.intactLoad[0]!;
    expect(loads[layout.storeys - 1]).toBe(0);
    for (let i = 1; i < loads.length; i++) expect(loads[i]!).toBeLessThan(loads[i - 1]!);
    const total = s.nodes.reduce((m, n) => m + n.mass, 0);
    expect(loads[0]! + s.nodes[s.storeys[0]![0]![0]!]!.mass).toBeCloseTo(total, 0);
    // An intact storey uses 1/reserve of its capacity.
    expect(loadRatio(s, 0, 10)).toBeCloseTo(1 / tuning.reserve.glass, 6);
  });

  it('expands a storey into bays lazily, keeping its mass and damage', () => {
    const s = tower({ w: 30, d: 30, h: 120, style: FacadeStyle.glass });
    const whole = s.nodes[s.storeys[0]![5]![0]!]!;
    whole.health *= 0.5;
    const ids = s.expandStorey(0, 5);
    const layout = s.segments[0]!.layout;
    expect(ids).toHaveLength(layout.baysX * layout.baysZ);
    const bays = ids.map((id) => s.nodes[id]!);
    expect(bays.reduce((m, n) => m + n.mass, 0)).toBeCloseTo(whole.mass, 3);
    expect(bays.reduce((m, n) => m + n.health, 0)).toBeCloseTo(whole.health, 0);
    expect(whole.state).toBe(NodeState.Expanded);
    expect(s.expandStorey(0, 5)).toEqual(ids);
  });

  it('only moves node states forward (a crushed node never comes back)', () => {
    const s = tower({ w: 22, d: 22, h: 80, style: FacadeStyle.glass });
    const id = s.expandStorey(0, 3)[0]!;
    s.crush(id);
    s.detach({ nodes: [], ornaments: [] });
    s.crush(id);
    expect(s.nodes[id]!.state).toBe(NodeState.Crushed);
    punch(s, 108, 4 + 3.5 * s.segments[0]!.layout.storeyHeight);
    expect(s.nodes[id]!.state).toBe(NodeState.Crushed);
  });

  it('stands a tower on its podium, and podiums never break', () => {
    const city = syntheticCity({ boxes: [
      { w: 40, d: 40, h: 12, role: 'podium', style: FacadeStyle.stone },
      { w: 20, d: 20, h: 90, y0: 16, style: FacadeStyle.glass },
    ] });
    const s = new BuildingStructure(0, city, tuning);
    const [podium, shaft] = s.segments;
    expect(podium!.sturdy).toBe(true);
    expect(shaft!.below).toBe(podium!.index);
    const shaftMass = s.storeys[shaft!.index]!.flat().reduce((m, id) => m + s.nodes[id]!.mass, 0);
    expect(s.intactLoad[podium!.index]![podium!.layout.storeys - 1]).toBeCloseTo(shaftMass, 0);
    const { report, verdict } = punch(s, 108, 10);
    expect(report.crushed).toHaveLength(0);
    expect(report.outcome).toBe('dent');
    expect(verdict.failure).toBeNull();
  });
});

describe('crush planner + support check: the outcome matrix', () => {
  const forward = { x: 0, z: 1 };

  it('30 m glass tower: a hole at 40, stands and groans at 55, topples forward at 70 and 108', () => {
    const at = (speed: number) => punch(tower({ w: 30, d: 30, h: 120, style: FacadeStyle.glass }), speed, 52);
    const slow = at(40);
    expect(slow.report.outcome).toBe('crush');
    expect(slow.verdict.failure).toBeNull();
    const groan = at(55);
    expect(groan.report.outcome).toBe('burst');
    expect(groan.verdict.failure).toBeNull();
    expect(groan.verdict.strain).not.toBeNull();
    for (const speed of [70, 108]) {
      const { verdict } = at(speed);
      expect(verdict.failure?.kind, `${speed} m/s`).toBe('topple');
      expect(leanAlong(verdict, forward), `${speed} m/s`).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('15 m stone block: stands at 40, topples forward from 55', () => {
    expect(punch(tower({ w: 15, d: 15, h: 60, style: FacadeStyle.stone }), 40, 28).verdict.failure).toBeNull();
    for (const speed of [55, 70, 108]) {
      const { verdict } = punch(tower({ w: 15, d: 15, h: 60, style: FacadeStyle.stone }), speed, 28);
      expect(verdict.failure?.kind, `${speed} m/s`).toBe('topple');
      expect(leanAlong(verdict, forward), `${speed} m/s`).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('typical 22 m tower topples along the flight path from 55 m/s', () => {
    for (const speed of [55, 70, 108]) {
      const { verdict } = punch(tower({ w: 22, d: 22, h: 100, style: FacadeStyle.glass }), speed, 44);
      expect(verdict.failure?.kind, `${speed} m/s`).toBe('topple');
      expect(leanAlong(verdict, forward), `${speed} m/s`).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('follows a yawed tower and a diagonal flight path', () => {
    const dir = { x: Math.sin(0.9), z: Math.cos(0.9) };
    const { verdict } = punch(tower({ w: 22, d: 26, h: 100, yaw: 0.35, style: FacadeStyle.glass }), 90, 44, dir);
    expect(verdict.failure?.kind).toBe('topple');
    expect(leanAlong(verdict, dir)).toBeGreaterThanOrEqual(0.7);
  });

  it('keeps the entry side as the hinge even at full boost', () => {
    const s = tower({ w: 30, d: 30, h: 120, style: FacadeStyle.glass });
    const { report } = punch(s, 108, 52);
    for (const { segment, storey } of report.storeys) {
      const entrySide = s.presentNodes(segment, storey).filter((n) => (n.z0 + n.z1) / 2 < 30 * (1 - tuning.blowOut.maxDepthShare));
      expect(entrySide.length).toBeGreaterThan(0);
    }
  });

  it('never spends more energy than it had, and crushed and weakened nodes are distinct', () => {
    for (const speed of [30, 55, 108]) {
      const { report } = punch(tower({ w: 22, d: 22, h: 100, style: FacadeStyle.glass }), speed, 44);
      expect(report.energyUsed).toBeLessThanOrEqual(0.5 * tuning.punchMass * speed * speed + 1e-6);
      const crushed = new Set(report.crushed);
      expect(report.weakened.some((id) => crushed.has(id))).toBe(false);
    }
  });

  it('a centred blast pancakes instead of toppling', () => {
    const s = tower({ w: 22, d: 22, h: 100, style: FacadeStyle.glass });
    const report = applyDamage(s, { kind: 'blast', shape: { type: 'sphere', centre: { x: 0, y: 30, z: 0 }, radius: 9 }, energy: 4e8, speed: 0, impulse: 0, generation: 0 }, tuning);
    const verdict = checkSupport(s, report.storeys, tuning, report.push);
    expect(report.outcome).toBe('crush');
    expect(verdict.failure?.kind).toBe('pancake');
  });

  it('round towers soak up boost hits and give way on the second or third', () => {
    const s = tower({ round: { radius: 16, h: 180, style: FacadeStyle.glass } });
    let failedOn = 0;
    for (let hit = 1; hit <= 4 && !failedOn; hit++) {
      const { verdict } = punch(s, 108, 70, { x: 0, z: 1 }, 0);
      if (verdict.failure) failedOn = hit;
    }
    expect(failedOn).toBeGreaterThanOrEqual(2);
    expect(failedOn).toBeLessThanOrEqual(3);
  });
});
