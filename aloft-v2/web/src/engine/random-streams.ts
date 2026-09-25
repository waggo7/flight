// Seeded, named random streams. Each subsystem draws from its own stream, so adding a random
// call in one system never changes another system's sequence, and runs are reproducible.
// Math.random is banned in core/, engine/ and sim/ by the lint config.

export interface RandomStream {
  /** Uniform in [0, 1). */
  next(): number;
  range(min: number, max: number): number;
  /** Integer in [0, count). */
  int(count: number): number;
  chance(probability: number): boolean;
  /** Uniform in [-1, 1). */
  signed(): number;
}

/** 32-bit FNV-1a, used to derive a stream seed from its name. */
export function hashString(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: tiny, fast, good enough for gameplay. */
export function createRandomStream(seed: number): RandomStream {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (count) => Math.floor(next() * count),
    chance: (probability) => next() < probability,
    signed: () => next() * 2 - 1,
  };
}

export class RandomStreams {
  private readonly streams = new Map<string, RandomStream>();

  constructor(private seed: number) {}

  stream(name: string): RandomStream {
    let stream = this.streams.get(name);
    if (!stream) {
      stream = createRandomStream(hashString(name, this.seed >>> 0));
      this.streams.set(name, stream);
    }
    return stream;
  }

  /** Restart every stream from the (optionally new) seed. */
  reset(seed = this.seed): void {
    this.seed = seed;
    this.streams.clear();
  }
}
