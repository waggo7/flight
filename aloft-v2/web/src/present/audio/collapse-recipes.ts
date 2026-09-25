import type { AudioEngine, Point3, VoiceInput } from './audio-engine';

// Procedural collapse sounds, each one voice in the engine (so all of them are spatial, delayed
// by distance, and limited together):
//   modalImpact   noise excitation into four resonant modes; bigger = lower
//   crack         a 1–3 ms click with a bright tail, sometimes a steel ping (rebar)
//   groan         detuned low saws through a swept resonant filter, with stick-slip pulses
//   rubbleGrains  a Poisson rain of short grains
//   rumbleBed     looping brown + pink noise, low-passed, that outlasts its drive
//   glassCascade  a burst of glass modes, and "glass rain" landing √(2h/g) later
//   glassSmash    a curtain wall bursting: a bright broadband crash, then a glassCascade
//   metalShear    tearing steel: a screech sliding down in stick-slip grinds, then the member rings
//   groundBoom    a 55 → 24 Hz sub sweep with a thump and grain spray; ducks the mix
//   dustWhoosh    a band-passed pink swell as a dust front passes

export type Material = 'concrete' | 'glass' | 'steel';

const MODES: Record<Material, { ratios: readonly number[]; base: number; decay: number; exciterCutoff: number }> = {
  concrete: { ratios: [1, 1.7, 2.9, 4.1], base: 330, decay: 0.22, exciterCutoff: 1400 },
  glass: { ratios: [1, 2.32, 4.25, 6.63], base: 1500, decay: 0.55, exciterCutoff: 16000 },
  steel: { ratios: [1, 2.76, 5.4, 8.93], base: 320, decay: 1.1, exciterCutoff: 7000 },
};

const GRAVITY = 9.81;

/** Exponential attack/decay on a gain param from `start`. */
function envelope(param: AudioParam, start: number, attack: number, peak: number, decay: number): void {
  param.setValueAtTime(0.0001, start);
  param.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + attack);
  param.exponentialRampToValueAtTime(0.0001, start + attack + decay);
}

/** Resonant modes excited by a short noise burst, into `into`. */
function modes(v: VoiceInput, into: AudioNode, at: number, material: Material, size: number, strength: number): number {
  const { ctx, engine } = v;
  const spec = MODES[material];
  const f0 = spec.base / Math.sqrt(Math.max(size, 0.2));
  const decay = spec.decay * Math.pow(Math.max(size, 0.2), 0.3);
  const burst = engine.noiseSource('white');
  const exciter = ctx.createGain();
  envelope(exciter.gain, at, 0.001, strength, 0.012 + 0.01 * Math.min(size, 4));
  // Soft materials are struck dull: low-pass the excitation so broadband noise doesn't leak through.
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = Math.min(spec.exciterCutoff, ctx.sampleRate * 0.45);
  burst.connect(tone).connect(exciter);
  spec.ratios.forEach((ratio, i) => {
    const frequency = Math.min(f0 * ratio * (0.97 + engine.random() * 0.06), ctx.sampleRate * 0.45);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = frequency;
    band.Q.value = material === 'concrete' ? 12 : 28;
    const ring = ctx.createGain();
    envelope(ring.gain, at, 0.002, (1.6 / (i + 1)) * (material === 'concrete' ? 4 : 7), decay / Math.sqrt(ratio));
    exciter.connect(band).connect(ring).connect(into);
  });
  burst.start(at, engine.randomOffset());
  burst.stop(at + decay + 0.1);
  return decay + 0.1;
}

export function modalImpact(engine: AudioEngine, position: Point3 | null, material: Material, size: number, strength: number): void {
  const duration = MODES[material].decay * Math.pow(Math.max(size, 0.2), 0.3) + 0.2;
  const v = engine.voice({ position, bus: 'sfx', gain: 0.5 * strength, reference: 30 + size * 6, duration });
  if (v) modes(v, v.input, v.start, material, size, 1);
}

export function crack(engine: AudioEngine, position: Point3 | null, strength: number): void {
  const v = engine.voice({ position, bus: 'sfx', gain: 0.6 * strength, reference: 35, duration: 0.6 });
  if (!v) return;
  const { ctx, start } = v;
  const click = engine.noiseSource('white');
  const high = ctx.createBiquadFilter();
  high.type = 'highpass';
  high.frequency.value = 1800;
  const clickGain = ctx.createGain();
  envelope(clickGain.gain, start, 0.0005, 1.4, 0.0015 + engine.random() * 0.002);
  click.connect(high).connect(clickGain).connect(v.input);
  const tail = ctx.createGain();
  envelope(tail.gain, start + 0.002, 0.003, 0.35, 0.09);
  high.connect(tail).connect(v.input);
  click.start(start, engine.randomOffset());
  click.stop(start + 0.15);
  // Rebar: a steel ping about a third of the time.
  if (engine.random() < 0.3) modes(v, v.input, start + 0.01, 'steel', 0.4 + engine.random() * 0.6, 0.25);
}

export function groan(engine: AudioEngine, position: Point3 | null, duration: number, intensity: number): void {
  const v = engine.voice({ position, bus: 'sfx', gain: 0.45 * intensity, reference: 60, duration: duration + 0.5 });
  if (!v) return;
  const { ctx, start } = v;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 9;
  filter.frequency.setValueAtTime(110, start);
  filter.frequency.exponentialRampToValueAtTime(360, start + duration * 0.45);
  filter.frequency.exponentialRampToValueAtTime(140, start + duration);
  const body = ctx.createGain();
  body.gain.setValueAtTime(0.0001, start);
  body.gain.exponentialRampToValueAtTime(0.5, start + Math.min(0.6, duration * 0.3));
  // Stick-slip: the steel catches and lets go in uneven pulses.
  let t = start + 0.3;
  while (t < start + duration - 0.3) {
    const hold = 0.08 + engine.random() * 0.25;
    body.gain.setValueAtTime(0.25 + engine.random() * 0.35, t);
    body.gain.linearRampToValueAtTime(0.5 + engine.random() * 0.5, t + hold);
    t += hold + engine.random() * 0.2;
  }
  body.gain.setValueAtTime(0.5, start + duration - 0.3);
  body.gain.exponentialRampToValueAtTime(0.0001, start + duration + 0.4);
  filter.connect(body).connect(v.input);
  const base = 44 + engine.random() * 22;
  for (const detune of [-0.03, 0, 0.025]) {
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(base * (1 + detune), start);
    saw.frequency.linearRampToValueAtTime(base * (1 + detune) * 0.82, start + duration);
    saw.connect(filter);
    saw.start(start);
    saw.stop(start + duration + 0.5);
  }
  // A few faint high creaks.
  for (let i = 0; i < 3; i++) {
    const at = start + engine.random() * duration;
    const creak = engine.noiseSource('white');
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 900 + engine.random() * 900;
    band.Q.value = 20;
    const g = ctx.createGain();
    envelope(g.gain, at, 0.02, 0.05, 0.25);
    creak.connect(band).connect(g).connect(v.input);
    creak.start(at, engine.randomOffset());
    creak.stop(at + 0.35);
  }
}

export function rubbleGrains(engine: AudioEngine, position: Point3 | null, rate: number, duration: number, strength: number): void {
  const v = engine.voice({ position, bus: 'sfx', gain: 0.4 * strength, reference: 40, duration: duration + 0.3 });
  if (!v) return;
  const { ctx, start } = v;
  const count = Math.min(600, Math.round(Math.min(rate, 400) * duration));
  let t = start;
  for (let i = 0; i < count; i++) {
    t += -Math.log(1 - engine.random() * 0.999) / Math.min(rate, 400); // Poisson arrivals
    if (t > start + duration) break;
    const grain = engine.noiseSource(engine.random() < 0.5 ? 'white' : 'pink');
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 250 + engine.random() * 2200;
    band.Q.value = 3 + engine.random() * 5;
    const g = ctx.createGain();
    const fade = 1 - (t - start) / duration;
    envelope(g.gain, t, 0.001, (0.2 + engine.random() * 0.8) * (0.3 + 0.7 * fade), 0.005 + engine.random() * 0.03);
    grain.connect(band).connect(g).connect(v.input);
    grain.start(t, engine.randomOffset());
    grain.stop(t + 0.06);
  }
}

/** A low roar driven for `drive` seconds that keeps sounding for about two more. */
export function rumbleBed(engine: AudioEngine, position: Point3 | null, drive: number, strength: number): void {
  const release = 4.6;
  const v = engine.voice({ position, bus: 'sub', gain: 0.8 * strength, reference: 120, duration: drive + release + 0.5 });
  if (!v) return;
  const { ctx, start } = v;
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.setValueAtTime(260, start);
  low.frequency.linearRampToValueAtTime(140, start + drive + release);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(1, start + 0.4);
  g.gain.setValueAtTime(1, start + drive);
  g.gain.exponentialRampToValueAtTime(0.0001, start + drive + release);
  low.connect(g).connect(v.input);
  const brown = engine.noiseSource('brown');
  const pink = engine.noiseSource('pink');
  const pinkLevel = ctx.createGain();
  pinkLevel.gain.value = 0.35;
  brown.connect(low);
  pink.connect(pinkLevel).connect(low);
  for (const source of [brown, pink]) {
    source.start(start, engine.randomOffset());
    source.stop(start + drive + release + 0.1);
  }
}

/** Shattering glass, then glass rain landing √(2h/g) later from `height` m up. */
export function glassCascade(engine: AudioEngine, position: Point3 | null, count: number, height: number): void {
  const fall = Math.sqrt((2 * Math.max(height, 1)) / GRAVITY);
  const v = engine.voice({ position, bus: 'sfx', gain: 0.35, reference: 45, duration: fall + 2.2 });
  if (!v) return;
  const pings = Math.min(60, count);
  for (let i = 0; i < pings; i++) modes(v, v.input, v.start + engine.random() * 0.35, 'glass', 0.15 + engine.random() * 0.5, 0.5 + engine.random() * 0.5);
  const rain = Math.min(80, count * 2);
  for (let i = 0; i < rain; i++) modes(v, v.input, v.start + fall + engine.random() * 1.6, 'glass', 0.08 + engine.random() * 0.2, 0.15 + engine.random() * 0.25);
}

/** A curtain wall bursting right here: a bright crash, then the cascade and the rain. */
export function glassSmash(engine: AudioEngine, position: Point3 | null, strength: number, height: number): void {
  const v = engine.voice({ position, bus: 'sfx', gain: 0.55 * strength, reference: 35, duration: 0.7 });
  if (v) {
    const { ctx, start } = v;
    const crash = engine.noiseSource('white');
    const high = ctx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 2600;
    const g = ctx.createGain();
    envelope(g.gain, start, 0.002, 1.2, 0.32);
    crash.connect(high).connect(g).connect(v.input);
    crash.start(start, engine.randomOffset());
    crash.stop(start + 0.5);
  }
  glassCascade(engine, position, Math.round(24 + 36 * strength), height);
}

/**
 * Tearing steel: pink noise through two tight bands sliding down as the member yields, gated in
 * uneven stick-slip grinds, then the member rings as it lets go. `size` ≈ 1 for a floor beam,
 * more for a whole frame (lower and longer).
 */
export function metalShear(engine: AudioEngine, position: Point3 | null, strength: number, size = 1): void {
  const length = (0.45 + 0.7 * strength) * Math.sqrt(Math.max(size, 0.3));
  const v = engine.voice({ position, bus: 'sfx', gain: 0.4 * strength, reference: 40 + 20 * size, duration: length + 2 });
  if (!v) return;
  const { ctx, start } = v;
  const noise = engine.noiseSource('pink');
  const grind = ctx.createGain();
  grind.gain.setValueAtTime(0.0001, start);
  grind.gain.exponentialRampToValueAtTime(0.9, start + 0.03);
  let t = start + 0.05;
  while (t < start + length) {
    const hold = 0.025 + engine.random() * 0.08;
    grind.gain.setValueAtTime(0.2 + engine.random() * 0.4, t);
    grind.gain.linearRampToValueAtTime(0.6 + engine.random() * 0.4, t + hold);
    t += hold + engine.random() * 0.05;
  }
  grind.gain.setValueAtTime(0.5, start + length);
  grind.gain.exponentialRampToValueAtTime(0.0001, start + length + 0.15);
  const top = (1800 + engine.random() * 900) / Math.sqrt(Math.max(size, 0.3));
  for (const ratio of [1, 1.47]) {
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 16;
    band.frequency.setValueAtTime(top * ratio, start);
    band.frequency.exponentialRampToValueAtTime(top * ratio * 0.45, start + length);
    noise.connect(band).connect(grind);
  }
  grind.connect(v.input);
  noise.start(start, engine.randomOffset());
  noise.stop(start + length + 0.2);
  modes(v, v.input, start + length * 0.85, 'steel', 0.5 * size, 0.5 * strength);
}

export function groundBoom(engine: AudioEngine, position: Point3 | null, size: number): void {
  const length = 2.6 + Math.min(1.5, size / 150);
  const v = engine.voice({ position, bus: 'sub', gain: Math.min(1.2, 0.5 + size / 200), reference: 150, duration: length + 0.3 });
  if (!v) return;
  const { ctx, start } = v;
  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(55, start);
  sub.frequency.exponentialRampToValueAtTime(24, start + length * 0.8);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(1, start + 0.02);
  g.gain.setTargetAtTime(0.0001, start + 0.3, length / 5);
  sub.connect(g).connect(v.input);
  sub.start(start);
  sub.stop(start + length + 0.2);
  const thump = engine.noiseSource('brown');
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 90;
  const tg = ctx.createGain();
  envelope(tg.gain, start, 0.005, 1.5, 0.35);
  thump.connect(low).connect(tg).connect(v.input);
  thump.start(start, engine.randomOffset());
  thump.stop(start + 0.5);
  rubbleGrains(engine, position, 160, 1.4, 0.6);
  engine.duck(0.45, 1.4, start);
}

export function dustWhoosh(engine: AudioEngine, position: Point3 | null, strength: number): void {
  const v = engine.voice({ position, bus: 'ambience', gain: 0.35 * strength, reference: 30, duration: 2.6 });
  if (!v) return;
  const { ctx, start } = v;
  const pink = engine.noiseSource('pink');
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 0.8;
  band.frequency.setValueAtTime(380, start);
  band.frequency.linearRampToValueAtTime(900, start + 1.2);
  band.frequency.linearRampToValueAtTime(500, start + 2.4);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(1, start + 1);
  g.gain.exponentialRampToValueAtTime(0.0001, start + 2.5);
  pink.connect(band).connect(g).connect(v.input);
  pink.start(start, engine.randomOffset());
  pink.stop(start + 2.6);
}
