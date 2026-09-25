import type { GameContext } from './game-context';
import { FramePhase } from './system-phases';

// One rendered frame: input, then as many fixed sim steps as real time allows (events flushed
// after each), then presentation with the interpolation alpha (and one more flush). Driven by requestAnimationFrame
// in the browser and by the test API with a fixed dt.

export class GameLoop {
  frames = 0;

  constructor(private readonly ctx: GameContext) {}

  frame(realDt: number): number {
    const { systems, loop, events } = this.ctx;
    systems.runFrame(realDt, 0, FramePhase.BeforeSim, FramePhase.BeforeSim);
    const alpha = loop.advance(realDt, (dt) => {
      systems.runStep(dt);
      events.flush();
    });
    systems.runFrame(realDt, alpha, FramePhase.Present, FramePhase.Render);
    // Events from presentation (spark pickups, UI) arrive by the end of the frame, even when
    // paused and no step ran.
    events.flush();
    this.frames++;
    return alpha;
  }
}
