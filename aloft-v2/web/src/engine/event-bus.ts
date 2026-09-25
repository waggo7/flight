// Typed, queued events. Producers emit during a step; everything is delivered once per step
// at flush, in emit order. Features declare their own events by augmenting GameEventMap:
//   declare module '../engine/event-bus' { interface GameEventMap { 'flight:smash': {...} } }

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GameEventMap {}

type Handler<P> = (payload: P) => void;

// Events emitted by handlers during a flush are delivered in the same flush, up to this many
// rounds, so a chain reaction can't hang the frame.
const MAX_FLUSH_ROUNDS = 8;

export class EventBus<M extends object = GameEventMap> {
  private readonly handlers = new Map<keyof M, Set<Handler<never>>>();
  private queue: { type: keyof M; payload: unknown }[] = [];

  on<K extends keyof M>(type: K, handler: Handler<M[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    this.queue.push({ type, payload });
  }

  /** Deliver everything queued. Returns the number of events delivered. */
  flush(): number {
    let delivered = 0;
    for (let round = 0; round < MAX_FLUSH_ROUNDS && this.queue.length > 0; round++) {
      const batch = this.queue;
      this.queue = [];
      for (const { type, payload } of batch) {
        const set = this.handlers.get(type);
        if (set) for (const handler of [...set]) (handler as Handler<unknown>)(payload);
        delivered++;
      }
    }
    return delivered;
  }

  get pending(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
  }
}
