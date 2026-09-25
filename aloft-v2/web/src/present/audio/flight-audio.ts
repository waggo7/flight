import { clamp } from '../../core/scalar-math';
import type { RandomSource } from '../../core/seeded-noise';

// All sound is synthesised with Web Audio — nothing to download. Wind that rises
// with speed, a soft evolving pad, and one-shots for boost, shockwave, chimes and bumps.
// Ported from v1 (src/flight-audio.js), same recipes, with fixes:
// - every noise layer loops a 4 s noise buffer from a random point and stops only once its
//   duration and its envelope are both over (v1 never looped its 2 s buffer, so long layers such
//   as the 5.5 s collapse rumble died after 0.8–2 s);
// - distant collapses are heard distance / 343 s late, up to 5 s (v1: 0.6 s, impact only);
// - it can drive any BaseAudioContext, so an OfflineAudioContext renders the same recipes.
// M5 replaces this with the spatial audio engine; these sounds become its presets.

const PENTATONIC: readonly number[] = [587.33, 659.25, 739.99, 880.0, 987.77, 1174.66, 1318.51, 1479.98, 1760.0, 1975.53];
const CHORDS: readonly (readonly number[])[] = [
  [146.83, 220.0, 329.63, 369.99], // D add9-ish
  [123.47, 185.0, 277.18, 293.66], // Bm
  [98.0, 146.83, 246.94, 369.99], // Gmaj7
  [110.0, 164.81, 277.18, 329.63], // A
];

const MASTER_LEVEL = 0.85;
const NOISE_SECONDS = 4;
const SPEED_OF_SOUND = 343; // m/s
const MAX_SOUND_DELAY = 5; // s
/** Envelopes start and end here (exponential ramps can't reach zero). */
const ENVELOPE_FLOOR = 0.0001;
/** Noise layers keep running this long after their duration and envelope are over. */
const STOP_MARGIN = 0.05;

// Soft-clipping curve: turns clean noise bursts into gritty crunches.
function makeCrunchCurve(amount = 60): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i * 2) / curve.length - 1;
    curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

// Distant events get quieter and duller.
const falloff = (distance: number): number => 1 / (1 + distance / 260);

// Sound arrives after the sight: distance / speed of sound, capped so a far collapse is still heard.
const soundDelay = (distance: number): number => Math.min(MAX_SOUND_DELAY, Math.max(0, distance) / SPEED_OF_SOUND);

function makeImpulse(ctx: BaseAudioContext, random: RandomSource, seconds = 2.8, decay = 3.2): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (random() * 2 - 1) * Math.pow(1 - i / length, decay);
  }
  return buffer;
}

function createOscillator(ctx: BaseAudioContext, type: OscillatorType): OscillatorNode {
  const oscillator = ctx.createOscillator();
  oscillator.type = type;
  return oscillator;
}

/**
 * Silence → `peak` in `attack` → silence after `decay`, from `when`. Returns when it ends.
 * The peak is floored at ENVELOPE_FLOOR: an exponential ramp to 0 throws (v1: whoosh(0)).
 */
function envelope(gainNode: GainNode, peak: number, attack: number, decay: number, when: number): number {
  const end = when + attack + decay;
  gainNode.gain.setValueAtTime(ENVELOPE_FLOOR, when);
  gainNode.gain.exponentialRampToValueAtTime(Math.max(peak, ENVELOPE_FLOOR), when + attack);
  gainNode.gain.exponentialRampToValueAtTime(ENVELOPE_FLOOR, end);
  return end;
}

type AudioContextConstructor = new () => AudioContext;

function findAudioContext(): AudioContextConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  const legacy = window as Window & { webkitAudioContext?: AudioContextConstructor };
  return window.AudioContext ?? legacy.webkitAudioContext;
}

function isLiveContext(context: BaseAudioContext): context is AudioContext {
  return typeof AudioContext !== 'undefined' && context instanceof AudioContext;
}

/** A filtered noise layer, built but silent until `play` gives it an envelope. */
interface NoiseLayer {
  readonly source: AudioBufferSourceNode;
  readonly filter: BiquadFilterNode;
  readonly gain: GainNode;
  readonly when: number;
  /** How long it should sound, seconds. */
  readonly duration: number;
}

/** The continuous layers: wind, air hiss and the pad. */
interface AmbienceNodes {
  readonly windBand: BiquadFilterNode;
  readonly windGain: GainNode;
  readonly hissLow: BiquadFilterNode;
  readonly hissGain: GainNode;
  readonly padGain: GainNode;
  /** Per chord voice: a sine and a detuned triangle. */
  readonly voices: readonly (readonly OscillatorNode[])[];
}

interface MixGraph {
  readonly ctx: BaseAudioContext;
  readonly master: GainNode;
  readonly reverb: ConvolverNode;
  readonly noise: AudioBuffer;
  readonly ambience: AmbienceNodes | null;
}

export interface FlightAudioOptions {
  /**
   * Build on this context now instead of creating an AudioContext in start(): an
   * OfflineAudioContext renders the same recipes to a buffer.
   */
  context?: BaseAudioContext;
  /** Where the mix goes (default: the context's destination). Used with `context`. */
  destination?: AudioNode;
  /** Numbers in [0, 1) for the noise, reverb tail and variation (default Math.random). */
  random?: RandomSource;
  /**
   * Build the continuous wind, air hiss and pad (default true). Turn off to render a single
   * recipe on its own.
   */
  ambience?: boolean;
}

/** What the wind and pad follow each frame. */
export interface FlightAudioInput {
  /** Hero speed, m/s. */
  speed?: number;
  /** 0..1 rush of skimming close to a surface. */
  rush?: number;
  /** 0..1 how deep inside a cloud the hero is (muffles the wind). */
  cloud?: number;
  /** False on the title and pause screens: the wind drops to a whisper. */
  active?: boolean;
}

export class FlightAudio {
  muted = false;
  chordIndex = 0;
  chordTimer = 0;

  private graph: MixGraph | null = null;
  /** The context start() resumes; null for offline contexts. */
  private live: AudioContext | null = null;
  private crunchCurve: Float32Array<ArrayBuffer> | null = null;
  private readonly random: RandomSource;
  private readonly withAmbience: boolean;

  constructor({ context, destination, random = Math.random, ambience = true }: FlightAudioOptions = {}) {
    this.random = random;
    this.withAmbience = ambience;
    if (context) {
      if (isLiveContext(context)) this.live = context;
      this.build(context, destination ?? context.destination);
    }
  }

  get ctx(): BaseAudioContext | null {
    return this.graph?.ctx ?? null;
  }

  get ready(): boolean {
    return this.graph !== null;
  }

  /** Creates the AudioContext on the first call (call from a user gesture), resumes it after. */
  async start(): Promise<void> {
    if (this.graph) {
      const live = this.live;
      if (live && live.state !== 'running') await live.resume().catch(() => {});
      return;
    }
    const AudioContextClass = findAudioContext();
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    this.live = ctx;
    this.build(ctx, ctx.destination);
  }

  private build(ctx: BaseAudioContext, destination: AudioNode): void {
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : MASTER_LEVEL;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.25;
    master.connect(compressor).connect(destination);

    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx, this.random);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.32;
    reverb.connect(reverbReturn).connect(master);

    const noise = ctx.createBuffer(1, ctx.sampleRate * NOISE_SECONDS, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = this.random() * 2 - 1;

    const ambience = this.withAmbience ? this.buildAmbience(ctx, noise, master, reverb) : null;
    this.graph = { ctx, master, reverb, noise, ambience };
  }

  private buildAmbience(ctx: BaseAudioContext, noise: AudioBuffer, master: GainNode, reverb: ConvolverNode): AmbienceNodes {
    // Wind body: band-passed noise whose pitch and level climb with speed.
    const windBand = ctx.createBiquadFilter();
    windBand.type = 'bandpass';
    windBand.Q.value = 0.55;
    windBand.frequency.value = 300;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    this.loopNoise(ctx, noise).connect(windBand).connect(windGain).connect(master);

    // Air hiss: the high edge of the wind, strongest at full speed and near surfaces.
    const hissHigh = ctx.createBiquadFilter();
    hissHigh.type = 'highpass';
    hissHigh.frequency.value = 1900;
    const hissLow = ctx.createBiquadFilter();
    hissLow.type = 'lowpass';
    hissLow.frequency.value = 7000;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0;
    this.loopNoise(ctx, noise).connect(hissHigh).connect(hissLow).connect(hissGain).connect(master);

    // Pad: four soft voices gliding through a slow I–vi–IV–V.
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 850;
    padFilter.Q.value = 0.3;
    const padGain = ctx.createGain();
    padGain.gain.value = 0;
    padFilter.connect(padGain);
    padGain.connect(master);
    const padSend = ctx.createGain();
    padSend.gain.value = 0.55;
    padGain.connect(padSend).connect(reverb);
    const voices = CHORDS[0].map((frequency) => {
      const sine = createOscillator(ctx, 'sine');
      const triangle = createOscillator(ctx, 'triangle');
      const voiceGain = ctx.createGain();
      voiceGain.gain.value = 0.22;
      sine.frequency.value = frequency;
      triangle.frequency.value = frequency;
      triangle.detune.value = 5;
      for (const oscillator of [sine, triangle]) {
        oscillator.connect(voiceGain);
        oscillator.start();
      }
      voiceGain.connect(padFilter);
      return [sine, triangle];
    });
    padGain.gain.setTargetAtTime(0.05, ctx.currentTime, 2.5);
    return { windBand, windGain, hissLow, hissGain, padGain, voices };
  }

  private loopNoise(ctx: BaseAudioContext, noise: AudioBuffer): AudioBufferSourceNode {
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    source.loopStart = this.random();
    source.start(0, this.random() * 1.5);
    return source;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const g = this.graph;
    if (g) g.master.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, g.ctx.currentTime, 0.08);
  }

  update(dt: number, { speed = 0, rush = 0, cloud = 0, active = true }: FlightAudioInput = {}): void {
    const g = this.graph;
    const a = g?.ambience;
    if (!g || !a) return;
    const t = g.ctx.currentTime;
    const s = active ? clamp(speed / 140, 0, 1) : 0;
    const muffle = 1 - cloud * 0.6;
    a.windGain.gain.setTargetAtTime((active ? 0.03 : 0.01) + (0.34 * s * s + 0.12 * rush) * muffle, t, 0.15);
    a.windBand.frequency.setTargetAtTime(240 + 1300 * s + 500 * rush - 160 * cloud, t, 0.2);
    a.hissGain.gain.setTargetAtTime((0.008 + 0.15 * Math.pow(s, 2.2) + 0.1 * rush) * (1 - cloud * 0.8), t, 0.12);
    a.hissLow.frequency.setTargetAtTime(7000 - cloud * 5000, t, 0.2);
    a.padGain.gain.setTargetAtTime(0.05 * (1 - 0.45 * s), t, 0.8);

    this.chordTimer += dt;
    if (this.chordTimer > 9) {
      this.chordTimer = 0;
      this.chordIndex = (this.chordIndex + 1) % CHORDS.length;
      CHORDS[this.chordIndex].forEach((frequency, i) => {
        for (const oscillator of a.voices[i]) oscillator.frequency.setTargetAtTime(frequency, t, 1.4);
      });
    }
  }

  /** Noise → filter → gain, not yet playing: route `gain`, then give it an envelope with `play`. */
  private burst(g: MixGraph, duration: number, filterType: BiquadFilterType, frequency: number, q = 0.7, when = g.ctx.currentTime): NoiseLayer {
    const source = g.ctx.createBufferSource();
    source.buffer = g.noise;
    source.loop = true;
    const filter = g.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const gain = g.ctx.createGain();
    gain.gain.value = ENVELOPE_FLOOR;
    source.connect(filter).connect(gain);
    return { source, filter, gain, when, duration };
  }

  /**
   * Shape a layer's gain and play it: the loop starts at a random point in the noise and stops
   * only after both its duration and its envelope are over, so every layer sounds in full.
   */
  private play(layer: NoiseLayer, peak: number, attack: number, decay: number): void {
    const end = envelope(layer.gain, peak, attack, decay, layer.when);
    layer.source.start(layer.when, this.random() * NOISE_SECONDS);
    layer.source.stop(Math.max(layer.when + layer.duration, end) + STOP_MARGIN);
  }

  chime(step = 0, delay = 0): void {
    const g = this.graph;
    if (!g) return;
    const ctx = g.ctx;
    const when = ctx.currentTime + delay;
    const frequency = PENTATONIC[Math.min(step, PENTATONIC.length - 1)];
    const gain = ctx.createGain();
    gain.connect(g.master);
    const send = ctx.createGain();
    send.gain.value = 0.6;
    gain.connect(send).connect(g.reverb);
    const partials: readonly [number, OscillatorType, number][] = [
      [frequency, 'sine', 1],
      [frequency * 2, 'sine', 0.25],
      [frequency * 3.01, 'triangle', 0.06],
    ];
    for (const [f, type, level] of partials) {
      const oscillator = createOscillator(ctx, type);
      oscillator.frequency.value = f;
      const partial = ctx.createGain();
      partial.gain.value = level;
      oscillator.connect(partial).connect(gain);
      oscillator.start(when);
      oscillator.stop(when + 2);
    }
    envelope(gain, 0.22, 0.006, 1.6, when);
  }

  whoosh(strength = 1): void {
    const g = this.graph;
    if (!g) return;
    const layer = this.burst(g, 0.9, 'bandpass', 300, 0.9);
    const t = g.ctx.currentTime;
    layer.filter.frequency.setValueAtTime(260, t);
    layer.filter.frequency.exponentialRampToValueAtTime(2400, t + 0.55);
    layer.gain.connect(g.master);
    this.play(layer, 0.3 * strength, 0.18, 0.6);
  }

  boom(): void {
    const g = this.graph;
    if (!g) return;
    const ctx = g.ctx;
    const t = ctx.currentTime;
    const thump = createOscillator(ctx, 'sine');
    thump.frequency.setValueAtTime(78, t);
    thump.frequency.exponentialRampToValueAtTime(32, t + 0.7);
    const thumpGain = ctx.createGain();
    thump.connect(thumpGain).connect(g.master);
    envelope(thumpGain, 0.9, 0.008, 1.1, t);
    thump.start(t);
    thump.stop(t + 1.3);

    const crack = this.burst(g, 0.2, 'highpass', 900);
    crack.gain.connect(g.master);
    this.play(crack, 0.45, 0.002, 0.14);

    const rumble = this.burst(g, 2.2, 'lowpass', 190);
    rumble.gain.connect(g.master);
    rumble.gain.connect(g.reverb);
    this.play(rumble, 0.5, 0.03, 2);
  }

  thud(strength = 0.5): void {
    const g = this.graph;
    if (!g) return;
    const hit = this.burst(g, 0.35, 'lowpass', 420);
    hit.gain.connect(g.master);
    this.play(hit, 0.2 + 0.5 * strength, 0.004, 0.28);
  }

  private crunch(g: MixGraph, level: number, duration: number, frequency = 700, when = g.ctx.currentTime): void {
    const layer = this.burst(g, duration + 0.1, 'bandpass', frequency, 0.8, when);
    const shaper = g.ctx.createWaveShaper();
    shaper.curve = this.crunchCurve ??= makeCrunchCurve();
    shaper.oversample = '2x';
    layer.filter.disconnect();
    layer.filter.connect(shaper).connect(layer.gain);
    layer.gain.connect(g.master);
    this.play(layer, level, 0.004, duration);
  }

  private glassTinkle(g: MixGraph, count: number, level: number): void {
    for (let i = 0; i < count; i++) {
      const when = g.ctx.currentTime + this.random() * 0.9;
      const tink = this.burst(g, 0.08, 'bandpass', 4200 + this.random() * 3800, 6, when);
      tink.gain.connect(g.master);
      this.play(tink, level * (0.4 + this.random() * 0.6), 0.002, 0.05 + this.random() * 0.08);
    }
  }

  /** Bursting through a building: sub hit, distorted crunch, glass, rumble tail. */
  smash(strength = 1): void {
    const g = this.graph;
    if (!g) return;
    const ctx = g.ctx;
    const t = ctx.currentTime;
    const sub = createOscillator(ctx, 'sine');
    sub.frequency.setValueAtTime(66, t);
    sub.frequency.exponentialRampToValueAtTime(28, t + 0.9);
    const subGain = ctx.createGain();
    sub.connect(subGain).connect(g.master);
    envelope(subGain, 0.9, 0.005, 1.2, t);
    sub.start(t);
    sub.stop(t + 1.4);
    this.crunch(g, 0.55 + 0.3 * strength, 0.55, 620);
    this.crunch(g, 0.3, 0.9, 260, t + 0.05);
    this.glassTinkle(g, 14, 0.22);
    const rumble = this.burst(g, 2.6, 'lowpass', 160);
    rumble.gain.connect(g.master);
    rumble.gain.connect(g.reverb);
    this.play(rumble, 0.45, 0.05, 2.4);
  }

  /** A scar in a wall: short crunch and a little glass. */
  dent(strength = 0.5): void {
    const g = this.graph;
    if (!g) return;
    this.crunch(g, 0.25 + 0.35 * strength, 0.3, 900);
    this.glassTinkle(g, Math.round(3 + strength * 6), 0.14);
  }

  /** A tower section tipping and breaking up: a long groaning rumble, heard distance / 343 s late. */
  collapse(distance = 0, size = 100): void {
    const g = this.graph;
    if (!g) return;
    const level = falloff(distance) * Math.min(1, 0.4 + size / 250);
    const when = g.ctx.currentTime + soundDelay(distance);
    const rumble = this.burst(g, 5.5, 'lowpass', 120, 0.9, when);
    rumble.gain.connect(g.master);
    rumble.gain.connect(g.reverb);
    this.play(rumble, 0.55 * level, 0.6, 4.6);
    const groan = this.burst(g, 3.5, 'bandpass', 210, 3, when);
    groan.filter.frequency.setValueAtTime(260, when);
    groan.filter.frequency.exponentialRampToValueAtTime(120, when + 3);
    groan.gain.connect(g.master);
    this.play(groan, 0.2 * level, 0.4, 2.8);
  }

  /** The section hitting the street. */
  collapseImpact(distance = 0, size = 100): void {
    const g = this.graph;
    if (!g) return;
    const ctx = g.ctx;
    const level = falloff(distance) * Math.min(1, 0.45 + size / 220);
    const when = ctx.currentTime + soundDelay(distance); // sound arrives a beat after the sight
    const boom = createOscillator(ctx, 'sine');
    boom.frequency.setValueAtTime(52, when);
    boom.frequency.exponentialRampToValueAtTime(24, when + 1.2);
    const boomGain = ctx.createGain();
    boom.connect(boomGain).connect(g.master);
    envelope(boomGain, 0.9 * level, 0.01, 1.6, when);
    boom.start(when);
    boom.stop(when + 1.8);
    this.crunch(g, 0.45 * level, 0.8, 320, when);
    const tail = this.burst(g, 3.5, 'lowpass', 140, 0.7, when);
    tail.gain.connect(g.master);
    tail.gain.connect(g.reverb);
    this.play(tail, 0.5 * level, 0.08, 3.2);
  }

  splash(strength = 0.5): void {
    const g = this.graph;
    if (!g) return;
    const wash = this.burst(g, 0.9, 'bandpass', 1300, 0.6);
    wash.gain.connect(g.master);
    this.play(wash, 0.15 + 0.35 * strength, 0.01, 0.75);
  }
}
