import { clamp } from './scalar-math.js';

// All sound is synthesised with Web Audio — nothing to download. Wind that rises
// with speed, a soft evolving pad, and one-shots for boost, shockwave, sparks and bumps.

const PENTATONIC = [587.33, 659.25, 739.99, 880.0, 987.77, 1174.66, 1318.51, 1479.98, 1760.0, 1975.53];
const CHORDS = [
  [146.83, 220.0, 329.63, 369.99], // D add9-ish
  [123.47, 185.0, 277.18, 293.66], // Bm
  [98.0, 146.83, 246.94, 369.99], // Gmaj7
  [110.0, 164.81, 277.18, 329.63], // A
];

function makeImpulse(ctx, seconds = 2.8, decay = 3.2) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
  }
  return buffer;
}

export class FlightAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.chordIndex = 0;
    this.chordTimer = 0;
  }

  async start() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
      return;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.85;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.25;
    this.master.connect(compressor).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.32;
    this.reverb.connect(reverbReturn).connect(this.master);

    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = noise;

    // Wind body: band-passed noise whose pitch and level climb with speed.
    this.windBand = ctx.createBiquadFilter();
    this.windBand.type = 'bandpass';
    this.windBand.Q.value = 0.55;
    this.windBand.frequency.value = 300;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.#loopNoise().connect(this.windBand).connect(this.windGain).connect(this.master);

    // Air hiss: the high edge of the wind, strongest at full speed and near surfaces.
    const hissHigh = ctx.createBiquadFilter();
    hissHigh.type = 'highpass';
    hissHigh.frequency.value = 1900;
    this.hissLow = ctx.createBiquadFilter();
    this.hissLow.type = 'lowpass';
    this.hissLow.frequency.value = 7000;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    this.#loopNoise().connect(hissHigh).connect(this.hissLow).connect(this.hissGain).connect(this.master);

    // Pad: four soft voices gliding through a slow I–vi–IV–V.
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 850;
    this.padFilter.Q.value = 0.3;
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0;
    this.padFilter.connect(this.padGain);
    this.padGain.connect(this.master);
    const padSend = ctx.createGain();
    padSend.gain.value = 0.55;
    this.padGain.connect(padSend).connect(this.reverb);
    this.voices = CHORDS[0].map((frequency) => {
      const oscillators = [
        Object.assign(ctx.createOscillator(), { type: 'sine' }),
        Object.assign(ctx.createOscillator(), { type: 'triangle' }),
      ];
      const voiceGain = ctx.createGain();
      voiceGain.gain.value = 0.22;
      oscillators[0].frequency.value = frequency;
      oscillators[1].frequency.value = frequency;
      oscillators[1].detune.value = 5;
      for (const oscillator of oscillators) {
        oscillator.connect(voiceGain);
        oscillator.start();
      }
      voiceGain.connect(this.padFilter);
      return oscillators;
    });
    this.padGain.gain.setTargetAtTime(0.05, ctx.currentTime, 2.5);
    this.ready = true;
  }

  #loopNoise() {
    const source = this.ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    source.loopStart = Math.random();
    source.start(0, Math.random() * 1.5);
    return source;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.ready) this.master.gain.setTargetAtTime(muted ? 0 : 0.85, this.ctx.currentTime, 0.08);
  }

  update(dt, { speed = 0, rush = 0, cloud = 0, active = true }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const s = active ? clamp(speed / 140, 0, 1) : 0;
    const muffle = 1 - cloud * 0.6;
    this.windGain.gain.setTargetAtTime((active ? 0.03 : 0.01) + (0.34 * s * s + 0.12 * rush) * muffle, t, 0.15);
    this.windBand.frequency.setTargetAtTime(240 + 1300 * s + 500 * rush - 160 * cloud, t, 0.2);
    this.hissGain.gain.setTargetAtTime((0.008 + 0.15 * Math.pow(s, 2.2) + 0.1 * rush) * (1 - cloud * 0.8), t, 0.12);
    this.hissLow.frequency.setTargetAtTime(7000 - cloud * 5000, t, 0.2);
    this.padGain.gain.setTargetAtTime(0.05 * (1 - 0.45 * s), t, 0.8);

    this.chordTimer += dt;
    if (this.chordTimer > 9) {
      this.chordTimer = 0;
      this.chordIndex = (this.chordIndex + 1) % CHORDS.length;
      CHORDS[this.chordIndex].forEach((frequency, i) => {
        for (const oscillator of this.voices[i]) oscillator.frequency.setTargetAtTime(frequency, t, 1.4);
      });
    }
  }

  #envelope(gainNode, peak, attack, decay, when = this.ctx.currentTime) {
    gainNode.gain.setValueAtTime(0.0001, when);
    gainNode.gain.exponentialRampToValueAtTime(peak, when + attack);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
  }

  #burst(duration, filterType, frequency, q = 0.7) {
    const source = this.ctx.createBufferSource();
    source.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const gain = this.ctx.createGain();
    source.connect(filter).connect(gain);
    source.start(0, Math.random() * 1.2);
    source.stop(this.ctx.currentTime + duration + 0.05);
    return { source, filter, gain };
  }

  chime(step = 0, delay = 0) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const when = ctx.currentTime + delay;
    const frequency = PENTATONIC[Math.min(step, PENTATONIC.length - 1)];
    const gain = ctx.createGain();
    gain.connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.6;
    gain.connect(send).connect(this.reverb);
    [
      [frequency, 'sine', 1],
      [frequency * 2, 'sine', 0.25],
      [frequency * 3.01, 'triangle', 0.06],
    ].forEach(([f, type, level]) => {
      const oscillator = Object.assign(ctx.createOscillator(), { type });
      oscillator.frequency.value = f;
      const partial = ctx.createGain();
      partial.gain.value = level;
      oscillator.connect(partial).connect(gain);
      oscillator.start(when);
      oscillator.stop(when + 2);
    });
    this.#envelope(gain, 0.22, 0.006, 1.6, when);
  }

  trailComplete(base = 3) {
    for (let i = 0; i < 4; i++) this.chime(base + i, i * 0.09);
  }

  whoosh(strength = 1) {
    if (!this.ready) return;
    const { filter, gain } = this.#burst(0.9, 'bandpass', 300, 0.9);
    const t = this.ctx.currentTime;
    filter.frequency.setValueAtTime(260, t);
    filter.frequency.exponentialRampToValueAtTime(2400, t + 0.55);
    gain.connect(this.master);
    this.#envelope(gain, 0.3 * strength, 0.18, 0.6);
  }

  boom() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const thump = Object.assign(ctx.createOscillator(), { type: 'sine' });
    thump.frequency.setValueAtTime(78, t);
    thump.frequency.exponentialRampToValueAtTime(32, t + 0.7);
    const thumpGain = ctx.createGain();
    thump.connect(thumpGain).connect(this.master);
    this.#envelope(thumpGain, 0.9, 0.008, 1.1);
    thump.start(t);
    thump.stop(t + 1.3);

    const crack = this.#burst(0.2, 'highpass', 900);
    crack.gain.connect(this.master);
    this.#envelope(crack.gain, 0.45, 0.002, 0.14);

    const rumble = this.#burst(2.2, 'lowpass', 190);
    rumble.gain.connect(this.master);
    rumble.gain.connect(this.reverb);
    this.#envelope(rumble.gain, 0.5, 0.03, 2);
  }

  thud(strength = 0.5) {
    if (!this.ready) return;
    const hit = this.#burst(0.35, 'lowpass', 420);
    hit.gain.connect(this.master);
    this.#envelope(hit.gain, 0.2 + 0.5 * strength, 0.004, 0.28);
  }

  splash(strength = 0.5) {
    if (!this.ready) return;
    const wash = this.#burst(0.9, 'bandpass', 1300, 0.6);
    wash.gain.connect(this.master);
    this.#envelope(wash.gain, 0.15 + 0.35 * strength, 0.01, 0.75);
  }
}
