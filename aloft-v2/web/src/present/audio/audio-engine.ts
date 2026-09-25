import type { RandomSource } from '../../core/seeded-noise';

// The sound engine for everything that isn't the hero's own wind: buses into a limiter, a
// procedural "street canyon" reverb, and spatial voices. A voice is a recipe's output routed
// through air absorption (a low-pass that closes with distance), an equal-power pan from the
// listener's point of view, 1/(1 + d/ref) gain, and a start delayed by the speed of sound. The
// voice limiter keeps the loudest few; the noise bank holds looping seeded noise so no layer can
// run out early (v1's truncation bug class). Works on any BaseAudioContext, so an offline context
// renders exactly what the game plays.

export const SPEED_OF_SOUND = 343;
export const MAX_SOUND_DELAY = 5;

export type BusName = 'sfx' | 'sub' | 'ambience';
export type NoiseColour = 'white' | 'pink' | 'brown';

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface VoiceSpec {
  /** Where the sound starts (null = at the listener, unpanned). */
  position: Point3 | null;
  bus: BusName;
  /** Loudness at the reference distance (linear gain). */
  gain: number;
  /** Metres at which the voice is at `gain`. */
  reference?: number;
  /** Seconds the voice lasts after it starts (for the limiter). */
  duration: number;
}

/** What a recipe builds into: a node to connect to, and when (context time) it starts. */
export interface VoiceInput {
  readonly ctx: BaseAudioContext;
  readonly input: AudioNode;
  readonly start: number;
  readonly engine: AudioEngine;
}

interface ActiveVoice {
  priority: number;
  end: number;
  output: GainNode;
}

export interface AudioEngineOptions {
  random: RandomSource;
  destination?: AudioNode;
  maxVoices: number;
}

export class AudioEngine {
  readonly buses: Record<BusName, GainNode>;
  readonly master: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly slowMoFilter: BiquadFilterNode;
  private readonly reverbSend: GainNode;
  private readonly noise = new Map<NoiseColour, AudioBuffer>();
  private voices: ActiveVoice[] = [];
  private readonly listener = { position: { x: 0, y: 0, z: 0 }, right: { x: 1, y: 0, z: 0 } };
  /** Voices started, and dropped by the limiter (for tests and the dev overlay). */
  readonly stats = { started: 0, dropped: 0, stolen: 0, peakVoices: 0 };

  constructor(
    readonly ctx: BaseAudioContext,
    private readonly options: AudioEngineOptions,
  ) {
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 16;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.25;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.slowMoFilter = ctx.createBiquadFilter();
    this.slowMoFilter.type = 'lowpass';
    this.slowMoFilter.frequency.value = 20000;
    this.slowMoFilter.connect(this.limiter);
    this.limiter.connect(this.master);
    // Soft clip after the limiter: linear to 0.6, then a knee that never passes −1 dBFS.
    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(2049);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      const a = Math.abs(x);
      curve[i] = Math.sign(x) * (a < 0.6 ? a : 0.6 + 0.29 * Math.tanh((a - 0.6) / 0.29));
    }
    clip.curve = curve;
    this.master.connect(clip).connect(options.destination ?? ctx.destination);

    this.buses = { sfx: ctx.createGain(), sub: ctx.createGain(), ambience: ctx.createGain() };
    this.buses.sub.gain.value = 0.9;
    this.buses.ambience.gain.value = 0.7;
    for (const bus of Object.values(this.buses)) bus.connect(this.slowMoFilter);

    // Street canyon: early reflections off facades plus a 2.5 s tail, fed from the sfx bus.
    const reverb = ctx.createConvolver();
    reverb.buffer = this.streetCanyonImpulse(2.5);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.35;
    this.buses.sfx.connect(this.reverbSend);
    this.reverbSend.connect(reverb);
    reverb.connect(this.slowMoFilter);

    for (const colour of ['white', 'pink', 'brown'] as const) this.noise.set(colour, this.makeNoise(colour, 4));
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  get activeVoices(): number {
    return this.voices.filter((v) => v.end > this.now).length;
  }

  /** The listener follows the camera; the reverb thins as it climbs above the street canyons. */
  setListener(position: Point3, right: Point3, altitude: number): void {
    this.listener.position = { ...position };
    this.listener.right = { ...right };
    const wet = 0.4 * (1 - Math.min(1, Math.max(0, (altitude - 30) / 400)));
    this.reverbSend.gain.setTargetAtTime(0.08 + wet, this.now, 0.3);
  }

  /** Slow motion muffles the world (0 = normal, 1 = deepest). */
  setSlowMotion(amount: number): void {
    this.slowMoFilter.frequency.setTargetAtTime(20000 * Math.pow(0.04, Math.min(1, Math.max(0, amount))), this.now, 0.08);
  }

  /** Duck the sfx and ambience buses under a boom, from `at` (when the boom arrives). */
  duck(depth: number, seconds: number, at = this.now): void {
    const t = Math.max(at, this.now);
    for (const bus of [this.buses.sfx, this.buses.ambience]) {
      const base = bus === this.buses.ambience ? 0.7 : 1;
      bus.gain.cancelScheduledValues(t);
      bus.gain.setValueAtTime(bus.gain.value, t);
      bus.gain.linearRampToValueAtTime(base * (1 - depth), t + 0.04);
      bus.gain.setTargetAtTime(base, t + 0.08, seconds / 3);
    }
  }

  distanceTo(position: Point3 | null): number {
    if (!position) return 0;
    const l = this.listener.position;
    return Math.hypot(position.x - l.x, position.y - l.y, position.z - l.z);
  }

  /**
   * Open a spatial voice, or return null if the limiter drops it. The recipe connects its sound to
   * `input` and schedules it from `start` (already delayed by distance / speed of sound).
   */
  voice(spec: VoiceSpec): VoiceInput | null {
    const ctx = this.ctx;
    const distance = this.distanceTo(spec.position);
    const reference = spec.reference ?? 40;
    const gain = spec.gain / (1 + distance / reference);
    const delay = Math.min(MAX_SOUND_DELAY, distance / SPEED_OF_SOUND);
    const start = this.now + delay + 0.005;
    const priority = gain;
    this.voices = this.voices.filter((v) => v.end > this.now);
    if (this.voices.length >= this.options.maxVoices) {
      let quietest = this.voices[0]!;
      for (const v of this.voices) if (v.priority < quietest.priority) quietest = v;
      if (quietest.priority >= priority) {
        this.stats.dropped++;
        return null;
      }
      quietest.output.gain.cancelScheduledValues(this.now);
      quietest.output.gain.setTargetAtTime(0, this.now, 0.02);
      quietest.end = this.now;
      this.voices = this.voices.filter((v) => v !== quietest);
      this.stats.stolen++;
    }

    const input = ctx.createGain();
    // Air absorption: highs die with distance (≈ 20 kHz nearby, ≈ 1.5 kHz at a kilometre).
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = Math.max(700, 20000 / (1 + distance / 80));
    air.Q.value = 0.5;
    const panner = ctx.createStereoPanner();
    panner.pan.value = this.panFor(spec.position, distance);
    const output = ctx.createGain();
    output.gain.value = gain;
    input.connect(air).connect(panner).connect(output).connect(this.buses[spec.bus]);
    this.voices.push({ priority, end: start + spec.duration, output });
    this.stats.started++;
    this.stats.peakVoices = Math.max(this.stats.peakVoices, this.voices.length);
    return { ctx, input, start, engine: this };
  }

  private panFor(position: Point3 | null, distance: number): number {
    if (!position || distance < 1e-3) return 0;
    const l = this.listener;
    const side = ((position.x - l.position.x) * l.right.x + (position.y - l.position.y) * l.right.y + (position.z - l.position.z) * l.right.z) / distance;
    return Math.max(-1, Math.min(1, side)) * 0.85;
  }

  /** A looping noise source (seeded, 4 s) starting at a random offset. */
  noiseSource(colour: NoiseColour): AudioBufferSourceNode {
    const source = this.ctx.createBufferSource();
    source.buffer = this.noise.get(colour)!;
    source.loop = true;
    return source;
  }

  randomOffset(): number {
    return this.options.random() * 3.5;
  }

  random(): number {
    return this.options.random();
  }

  private makeNoise(colour: NoiseColour, seconds: number): AudioBuffer {
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    const random = this.options.random;
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0;
    for (let i = 0; i < length; i++) {
      const white = random() * 2 - 1;
      if (colour === 'white') data[i] = white * 0.5;
      else if (colour === 'pink') {
        // Paul Kellet's refined pink filter.
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      } else {
        brown = (brown + 0.02 * white) / 1.02;
        data[i] = brown * 3.5;
      }
    }
    // Cross-fade the loop point so looping never clicks.
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      data[i] = data[i]! * t + data[length - fade + i]! * (1 - t);
    }
    return buffer;
  }

  /** Stereo impulse: sparse early reflections (facades 10–40 m away) and a decaying diffuse tail. */
  private streetCanyonImpulse(seconds: number): AudioBuffer {
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    const random = this.options.random;
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let r = 0; r < 14; r++) {
        const t = 0.02 + random() * 0.12;
        const i = Math.floor(t * ctx.sampleRate);
        if (i < length) data[i] = (data[i] ?? 0) + (random() < 0.5 ? -1 : 1) * (0.6 - t * 3);
      }
      for (let i = 0; i < length; i++) {
        const t = i / ctx.sampleRate;
        const decay = Math.exp(-t * (6.9 / seconds) * 2.2);
        data[i] = (data[i] ?? 0) + (random() * 2 - 1) * decay * 0.35 * Math.min(1, t / 0.03);
      }
    }
    return buffer;
  }
}
