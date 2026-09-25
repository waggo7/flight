// Systems run in fixed, named phases so a new feature slots in without editing anything else.

/** Phases of one fixed simulation step, in order. */
export const StepPhase = {
  Input: 0,
  Powers: 1,
  Hero: 2,
  DestructionApply: 3,
  Physics: 4,
  Contacts: 5,
  Fracture: 6,
  Governor: 7,
  SyncPoses: 8,
} as const;
export type StepPhase = (typeof StepPhase)[keyof typeof StepPhase];

/** Phases of one rendered frame, in order. BeforeSim runs before the frame's fixed steps. */
export const FramePhase = {
  BeforeSim: 0,
  Present: 1,
  Audio: 2,
  Render: 3,
} as const;
export type FramePhase = (typeof FramePhase)[keyof typeof FramePhase];

export interface StepSystem {
  name: string;
  phase: StepPhase;
  step(dt: number): void;
  reset?(): void;
}

export interface FrameSystem {
  name: string;
  phase: FramePhase;
  /** `realDt` is wall-clock seconds; `alpha` interpolates between the last two sim steps. */
  frame(realDt: number, alpha: number): void;
  reset?(): void;
}

export class SystemRegistry {
  private readonly stepSystems: StepSystem[] = [];
  private readonly frameSystems: FrameSystem[] = [];

  addStep(system: StepSystem): void {
    this.stepSystems.push(system);
    // Stable: systems keep insertion order within a phase.
    this.stepSystems.sort((a, b) => a.phase - b.phase);
  }

  addFrame(system: FrameSystem): void {
    this.frameSystems.push(system);
    this.frameSystems.sort((a, b) => a.phase - b.phase);
  }

  runStep(dt: number): void {
    for (const system of this.stepSystems) system.step(dt);
  }

  runFrame(realDt: number, alpha: number, from: FramePhase, to: FramePhase): void {
    for (const system of this.frameSystems) {
      if (system.phase >= from && system.phase <= to) system.frame(realDt, alpha);
    }
  }

  reset(): void {
    for (const system of this.stepSystems) system.reset?.();
    for (const system of this.frameSystems) system.reset?.();
  }

  names(): string[] {
    return [...this.stepSystems.map((s) => `step:${s.name}`), ...this.frameSystems.map((s) => `frame:${s.name}`)];
  }
}
