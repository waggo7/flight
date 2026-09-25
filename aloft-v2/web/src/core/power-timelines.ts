// The two powers as pure state machines: when each phase starts and ends, and which button
// presses count. The sim moves the hero and the world; these only keep time. Engine-neutral (Godot
// ports them against conformance vectors).
//
//   Slam: ready → windup → dive → impact → recover → cooldown → ready
//         (pressed within `instantBelow` m of the ground, it skips straight to impact)
//   Grab: empty → holding → windup → release → empty
//         (the first press grabs if the sim finds something; the second throws)

export interface SlamTuning {
  windup: number;
  recover: number;
  cooldown: number;
  /** Metres: pressed closer to the ground than this, the slam lands at once. */
  instantBelow: number;
  /** Seconds a dive may last before it counts as landed (safety). */
  maxDive: number;
}

export interface GrabTuning {
  throwWindup: number;
}

/** Shape of content/tuning/powers.json (validated in engine/content-library.ts). */
export interface PowersTuning {
  slam: SlamTuning & { diveSpeedScale: number; radius: { min: number; max: number }; mass: number; nudge: number };
  grab: GrabTuning & { reach: number; maxMass: number; holdDistance: number; holdHeight: number; holdResponse: number; throwSpeed: number; projectileSeconds: number; carrySpeedShare: number };
}

export type SlamPhase = 'ready' | 'windup' | 'dive' | 'impact' | 'recover' | 'cooldown';
export type GrabPhase = 'empty' | 'holding' | 'windup' | 'release';

export type PowerEvent = { type: 'slam-dive' } | { type: 'slam-impact'; instant: boolean } | { type: 'grab-throw' };

export class SlamTimeline {
  phase: SlamPhase = 'ready';
  /** Seconds in the current phase. */
  time = 0;
  private landedFlag = false;
  private instant = false;

  constructor(private readonly tuning: SlamTuning) {}

  /** The slam button; `clearance` = metres above whatever is below the hero. Returns true if it started. */
  press(clearance: number): boolean {
    if (this.phase !== 'ready') return false;
    this.instant = clearance < this.tuning.instantBelow;
    this.enter(this.instant ? 'impact' : 'windup');
    return true;
  }

  /** The sim reports the dive reached the ground (or a roof). */
  landed(): void {
    if (this.phase === 'dive') this.landedFlag = true;
  }

  /** Share of the cooldown still to go (1 just after landing, 0 when ready), for the HUD ring. */
  get cooldownShare(): number {
    if (this.phase === 'ready') return 0;
    if (this.phase === 'cooldown') return 1 - this.time / this.tuning.cooldown;
    return 1;
  }

  step(dt: number): PowerEvent[] {
    const events: PowerEvent[] = [];
    this.time += dt;
    const t = this.tuning;
    switch (this.phase) {
      case 'windup':
        if (this.time >= t.windup) {
          this.enter('dive');
          events.push({ type: 'slam-dive' });
        }
        break;
      case 'dive':
        if (this.landedFlag || this.time >= t.maxDive) this.enter('impact');
        break;
      case 'impact':
        // One step long: the impact event fires, then the hero recovers.
        events.push({ type: 'slam-impact', instant: this.instant });
        this.enter('recover');
        break;
      case 'recover':
        if (this.time >= t.recover) this.enter('cooldown');
        break;
      case 'cooldown':
        if (this.time >= t.cooldown) this.enter('ready');
        break;
      default:
        break;
    }
    return events;
  }

  /** The hero's motion belongs to the slam (not the flight model) in these phases. */
  get controlsHero(): boolean {
    return this.phase === 'windup' || this.phase === 'dive' || this.phase === 'impact' || this.phase === 'recover';
  }

  reset(): void {
    this.enter('ready');
  }

  private enter(phase: SlamPhase): void {
    this.phase = phase;
    this.time = 0;
    this.landedFlag = false;
  }
}

export class GrabTimeline {
  phase: GrabPhase = 'empty';
  time = 0;

  constructor(private readonly tuning: GrabTuning) {}

  /**
   * The grab button. Empty: returns 'grab' (the sim should look for something to hold, then call
   * `grabbed()`). Holding: starts the throw windup and returns 'throw'. Otherwise null.
   */
  press(): 'grab' | 'throw' | null {
    if (this.phase === 'empty') return 'grab';
    if (this.phase === 'holding') {
      this.enter('windup');
      return 'throw';
    }
    return null;
  }

  grabbed(): void {
    if (this.phase === 'empty') this.enter('holding');
  }

  /** What was held is gone (shattered, culled, Restart). */
  lost(): void {
    this.enter('empty');
  }

  step(dt: number): PowerEvent[] {
    this.time += dt;
    if (this.phase === 'windup' && this.time >= this.tuning.throwWindup) {
      this.enter('release');
      return [{ type: 'grab-throw' }];
    }
    if (this.phase === 'release') this.enter('empty');
    return [];
  }

  reset(): void {
    this.enter('empty');
  }

  private enter(phase: GrabPhase): void {
    this.phase = phase;
    this.time = 0;
  }
}
