import { clamp } from '../core/scalar-math';
import type { Feature } from '../engine/game-context';
import { FramePhase, StepPhase } from '../engine/system-phases';
import { AudioToken } from './audio-feature';
import { CameraToken } from './camera-feature';
import { ControlsToken } from './controls-feature';
import { EffectsToken } from './effects-feature';
import { FlightToken } from './flight-feature';
import { TimeScaleToken } from './time-scale-feature';

// Buildings push back. Every hero hit reports the share of the punch's energy the target soaked up
// (content/tuning/combat.json): the more it took, the more speed the hero loses bursting through
// (or, bouncing off, the harder it is knocked off line), the harder it rolls, the longer the
// stagger (boost cut, weak steering) and the heavier the hit-stop and camera punch. When the stagger ends the hero surges free. A section
// landing nearby rocks the hero with its air blast. The flight model itself is untouched (its
// conformance vectors stand); this nudges its state between steps.

export const impactRecoilFeature: Feature = {
  name: 'impact-recoil',
  install(ctx) {
    const flight = ctx.services.require(FlightToken);
    const controls = ctx.services.require(ControlsToken);
    const rig = ctx.services.require(CameraToken);
    const time = ctx.services.require(TimeScaleToken);
    const fx = ctx.services.require(EffectsToken);
    const audio = ctx.services.require(AudioToken);
    const tuning = ctx.content.combat;
    const { minFlightSpeed } = ctx.content.flight;
    const random = (): number => ctx.random.stream('recoil').next();

    let stagger = 0;
    let surge = false;
    let pitchKick = 0;
    let blastCooldown = 0;

    ctx.events.on('destruction:hero-hit', ({ kind, brokeThrough, soaked, direction }) => {
      const model = flight.model;
      if (!flight.active) return;
      const soak = clamp(soaked, 0, 1);
      const side = random() < 0.5 ? -1 : 1;
      const motion = fx.motion;
      if (model.mode === 'flying') {
        if (brokeThrough) {
          // Through the hole the hero keeps its line (a knock off it would hit the tunnel's walls
          // and hit the building again): the building takes speed instead.
          model.speed = Math.max(minFlightSpeed, model.speed * (1 - tuning.speedLoss * soak));
        } else {
          // Bounced off: knocked off line as well.
          model.yawRate += tuning.deflect * soak * side * (0.3 + 0.7 * random());
          pitchKick += tuning.deflect * soak * (0.4 + 0.6 * random());
        }
        model.bank += tuning.tumble * soak * side;
        stagger = Math.max(stagger, (brokeThrough ? tuning.stagger.burst : tuning.stagger.dent) * soak);
        surge = brokeThrough;
      }
      const h = tuning.hitStop;
      time.hitStop((h.base + h.perSoak * soak + (kind === 'topple' ? h.topple : 0)) * motion, ctx.content.simulation.hitStop.timeScale);
      rig.jolt(direction, tuning.cameraPunch.jolt * soak * motion);
      rig.kick(-tuning.cameraPunch.fov * soak * motion);
    });

    ctx.events.on('destruction:impact', ({ position, energy }) => {
      if (!flight.active || blastCooldown > 0) return;
      const model = flight.model;
      const b = tuning.blast;
      const dx = model.position.x - position.x;
      const dz = model.position.z - position.z;
      const distance = Math.hypot(dx, model.position.y - position.y, dz);
      if (distance > b.radius) return;
      const roll = Math.min(b.max, (energy / b.reference) * (1 - distance / b.radius) ** 2);
      if (roll < 0.02) return;
      // Rolled away from the blast: positive bank leans right (level right = (−cos yaw, 0, sin yaw)).
      const away = -dx * Math.cos(model.yaw) + dz * Math.sin(model.yaw) >= 0 ? 1 : -1;
      model.bank += roll * away * fx.motion;
      blastCooldown = b.cooldown;
    });

    ctx.events.on('game:restart', () => {
      stagger = 0;
      surge = false;
      pitchKick = 0;
      blastCooldown = 0;
    });

    // Before the flight model runs: the knock to the nose decays over a few steps (pitch is
    // attitude-controlled, so it's applied as a short-lived rate).
    ctx.systems.addStep({
      name: 'impact-recoil',
      phase: StepPhase.Powers,
      step(dt) {
        blastCooldown = Math.max(0, blastCooldown - dt);
        if (Math.abs(pitchKick) > 1e-4) {
          const model = flight.model;
          if (model.mode === 'flying') model.pitch = clamp(model.pitch + pitchKick * dt, -1.3, 1.3);
          pitchKick *= Math.exp(-7 * dt);
        }
        if (stagger <= 0) return;
        stagger = Math.max(0, stagger - dt);
        if (stagger === 0 && surge) {
          surge = false;
          rig.kick(tuning.cameraPunch.surge * fx.motion);
          audio.flight?.whoosh(0.7);
        }
      },
    });

    // After the devices are read: a staggered hero can't boost and barely steers.
    ctx.systems.addFrame({
      name: 'impact-recoil-stagger',
      phase: FramePhase.BeforeSim,
      frame() {
        if (stagger <= 0) return;
        const c = controls.current;
        controls.current = { ...c, boost: false, steerX: c.steerX * tuning.staggerSteer, steerY: c.steerY * tuning.staggerSteer };
      },
    });
  },
};
