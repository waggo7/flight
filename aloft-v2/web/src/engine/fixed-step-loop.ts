// Fixed-timestep clock. Simulation always advances in equal steps; rendering interpolates
// between the last two with `alpha`. Hit-stop and slow motion scale sim time only.

export interface FixedStepOptions {
  /** Steps per simulated second (60). */
  stepsPerSecond: number;
  /** When a frame falls behind, run at most this many steps, then drop the rest of the backlog. */
  maxStepsPerFrame: number;
  /** Longer frames (tab switches, hitches) are clamped to this many seconds. */
  maxFrameDelta: number;
}

// Real time accumulates in floating point; this slack keeps 60 steps per simulated second
// exact regardless of the frame rate that delivered it.
const STEP_SLACK = 1e-9;

export class FixedStepLoop {
  readonly step: number;
  timeScale = 1;
  simTime = 0;
  stepCount = 0;
  private accumulator = 0;

  constructor(readonly options: FixedStepOptions) {
    this.step = 1 / options.stepsPerSecond;
  }

  /** Feed one frame of real time; runs `onStep(dt)` zero or more times; returns the interpolation alpha in [0, 1). */
  advance(realDt: number, onStep: (dt: number) => void): number {
    const frame = Math.min(Math.max(Number.isFinite(realDt) ? realDt : 0, 0), this.options.maxFrameDelta);
    this.accumulator += frame * Math.max(0, this.timeScale);
    let steps = 0;
    while (this.accumulator + STEP_SLACK >= this.step && steps < this.options.maxStepsPerFrame) {
      onStep(this.step);
      this.accumulator = Math.max(0, this.accumulator - this.step);
      this.simTime += this.step;
      this.stepCount++;
      steps++;
    }
    // Behind even after the cap: drop whole steps rather than spiral.
    if (this.accumulator + STEP_SLACK >= this.step) this.accumulator %= this.step;
    return Math.min(this.accumulator / this.step, 0.999999);
  }

  reset(): void {
    this.accumulator = 0;
    this.simTime = 0;
    this.stepCount = 0;
    this.timeScale = 1;
  }
}
