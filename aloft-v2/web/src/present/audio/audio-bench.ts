import { createRandomStream } from '../../engine/random-streams';
import { AudioEngine, type Point3 } from './audio-engine';
import { crack, glassCascade, groan, groundBoom, modalImpact, rubbleGrains, rumbleBed } from './collapse-recipes';

// Offline renders of the collapse recipes with measurements (npm run audio:render drives this
// through the ?test API): peak level, NaN, how long sounds last, spectral centroids, voice limits,
// and distance delay and loss. Also hands back WAV files to listen to.

const RATE = 48000;

export interface AudioBenchResult {
  peakDbfs: number;
  hasNaN: boolean;
  roarTail: number;
  boomLength: number;
  centroids: { concrete: number; glass: number; groan: number };
  peakVoices: number;
  distance: { delay: number; lossDb: number };
  wavs: Record<string, string>;
}

type Scene = (engine: AudioEngine) => void;

async function render(seconds: number, scene: Scene, { listener = { x: 0, y: 0, z: 0 }, maxVoices = 32 } = {}): Promise<{ data: Float32Array; engine: AudioEngine; buffer: AudioBuffer }> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * RATE), RATE);
  const random = createRandomStream(11);
  const engine = new AudioEngine(ctx, { random: random.next, maxVoices });
  engine.setListener(listener, { x: 1, y: 0, z: 0 }, 20);
  scene(engine);
  const buffer = await ctx.startRendering();
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const data = new Float32Array(left.length);
  for (let i = 0; i < data.length; i++) data[i] = Math.max(Math.abs(left[i]!), Math.abs(right[i]!)) * Math.sign(left[i]! + right[i]! || 1);
  return { data, engine, buffer };
}

const toDb = (v: number): number => 20 * Math.log10(Math.max(v, 1e-9));

/** RMS level in 20 ms windows. */
function envelope(data: Float32Array): number[] {
  const window = Math.floor(RATE * 0.02);
  const out: number[] = [];
  for (let i = 0; i + window <= data.length; i += window) {
    let sum = 0;
    for (let j = i; j < i + window; j++) sum += data[j]! * data[j]!;
    out.push(Math.sqrt(sum / window));
  }
  return out;
}

/** Seconds from `from` until the level last sits within `rangeDb` of its peak. */
function audibleUntil(data: Float32Array, rangeDb: number): number {
  const env = envelope(data);
  const peak = Math.max(...env);
  let last = 0;
  env.forEach((v, i) => {
    if (toDb(v) > toDb(peak) - rangeDb) last = i;
  });
  return (last + 1) * 0.02;
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
}

/** Power-weighted mean frequency over Hann-windowed 8192-sample frames. */
function centroid(data: Float32Array): number {
  const n = 8192;
  let weighted = 0;
  let total = 0;
  for (let start = 0; start + n <= data.length; start += n / 2) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = data[start + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    fft(re, im);
    for (let k = 1; k < n / 2; k++) {
      const power = re[k]! * re[k]! + im[k]! * im[k]!;
      weighted += power * ((k * RATE) / n);
      total += power;
    }
  }
  return total > 0 ? weighted / total : 0;
}

function onset(data: Float32Array, threshold: number): number {
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i]!) > threshold) return i / RATE;
  return Infinity;
}

function peak(data: Float32Array): number {
  let max = 0;
  for (const v of data) max = Math.max(max, Math.abs(v));
  return max;
}

/** 16-bit PCM WAV as base64. */
function wav(buffer: AudioBuffer): string {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = new DataView(new ArrayBuffer(44 + frames * channels * 2));
  const text = (offset: number, s: string): void => [...s].forEach((c, i) => bytes.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  bytes.setUint32(4, 36 + frames * channels * 2, true);
  text(8, 'WAVEfmt ');
  bytes.setUint32(16, 16, true);
  bytes.setUint16(20, 1, true);
  bytes.setUint16(22, channels, true);
  bytes.setUint32(24, RATE, true);
  bytes.setUint32(28, RATE * channels * 2, true);
  bytes.setUint16(32, channels * 2, true);
  bytes.setUint16(34, 16, true);
  text(36, 'data');
  bytes.setUint32(40, frames * channels * 2, true);
  const data = [...Array(channels).keys()].map((c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      bytes.setInt16(offset, Math.max(-1, Math.min(1, data[c]![i]!)) * 0x7fff, true);
      offset += 2;
    }
  }
  let binary = '';
  const u8 = new Uint8Array(bytes.buffer);
  for (let i = 0; i < u8.length; i += 0x8000) binary += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function runAudioBench(): Promise<AudioBenchResult> {
  const at = (x: number, z: number): Point3 => ({ x, y: 0, z });
  // A whole tower coming down 120 m away: hit, groan, fall, landing.
  const collapse = await render(12, (e) => {
    crack(e, at(120, 30), 1);
    for (let i = 0; i < 3; i++) modalImpact(e, at(118 + i, 30), 'concrete', 3, 1);
    glassCascade(e, at(120, 30), 40, 50);
    groan(e, at(120, 30), 4, 1);
    rumbleBed(e, at(120, 30), 6, 1);
    groundBoom(e, at(140, 60), 220);
    rubbleGrains(e, at(140, 60), 260, 2.2, 1);
  });
  const roar = await render(7, (e) => rumbleBed(e, null, 3, 1));
  const boom = await render(5, (e) => groundBoom(e, null, 200));
  const concrete = await render(1.5, (e) => modalImpact(e, null, 'concrete', 3, 1));
  const glass = await render(1.5, (e) => modalImpact(e, null, 'glass', 0.3, 1));
  const groanRender = await render(4, (e) => groan(e, null, 3.5, 1));
  const crowd = await render(1.5, (e) => {
    for (let i = 0; i < 1000; i++) modalImpact(e, at(Math.sin(i) * 60, Math.cos(i * 1.3) * 60), 'concrete', 1 + (i % 7), 0.2 + (i % 5) / 6);
  });
  const near = await render(7, (e) => crack(e, at(50, 0), 1));
  const far = await render(7, (e) => crack(e, at(1000, 0), 1));

  const roarEnv = envelope(roar.data);
  const sustain = roarEnv[Math.round(2 / 0.02)]!;
  let lastLoud = 0;
  roarEnv.forEach((v, i) => {
    if (toDb(v) > toDb(sustain) - 40) lastLoud = i;
  });
  return {
    peakDbfs: toDb(Math.max(peak(collapse.data), peak(crowd.data))),
    hasNaN: [collapse, roar, boom, crowd].some((r) => r.data.some((v) => Number.isNaN(v))),
    roarTail: (lastLoud + 1) * 0.02 - 3,
    boomLength: audibleUntil(boom.data, 40),
    centroids: { concrete: centroid(concrete.data), glass: centroid(glass.data), groan: centroid(groanRender.data) },
    peakVoices: crowd.engine.stats.peakVoices,
    distance: { delay: onset(far.data, 1e-4) - onset(near.data, 1e-4), lossDb: toDb(peak(near.data)) - toDb(peak(far.data)) },
    wavs: { collapse: wav(collapse.buffer), roar: wav(roar.buffer), boom: wav(boom.buffer), glass: wav(glass.buffer), groan: wav(groanRender.buffer) },
  };
}
