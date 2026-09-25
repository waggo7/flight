import { describe, expect, test } from 'vitest';
import { EventBus } from '../../src/engine/event-bus';
import { createRandomStream, RandomStreams } from '../../src/engine/random-streams';
import { serviceToken, ServiceRegistry } from '../../src/engine/service-registry';
import { FramePhase, StepPhase, SystemRegistry } from '../../src/engine/system-phases';

interface TestEvents {
  hit: { strength: number };
  echo: { depth: number };
}

describe('event bus', () => {
  test('queues until flush and delivers in emit order', () => {
    const bus = new EventBus<TestEvents>();
    const seen: number[] = [];
    bus.on('hit', (e) => seen.push(e.strength));
    bus.emit('hit', { strength: 1 });
    bus.emit('hit', { strength: 2 });
    expect(seen).toEqual([]);
    expect(bus.flush()).toBe(2);
    expect(seen).toEqual([1, 2]);
  });

  test('unsubscribe stops delivery', () => {
    const bus = new EventBus<TestEvents>();
    const seen: number[] = [];
    const off = bus.on('hit', (e) => seen.push(e.strength));
    off();
    bus.emit('hit', { strength: 1 });
    bus.flush();
    expect(seen).toEqual([]);
  });

  test('events raised while flushing arrive in the same flush, but a runaway chain is cut off', () => {
    const bus = new EventBus<TestEvents>();
    let deliveries = 0;
    bus.on('echo', (e) => {
      deliveries++;
      bus.emit('echo', { depth: e.depth + 1 });
    });
    bus.emit('echo', { depth: 0 });
    bus.flush();
    expect(deliveries).toBe(8);
    expect(bus.pending).toBe(1);
  });
});

describe('random streams', () => {
  test('the same seed and name give the same sequence', () => {
    const a = new RandomStreams(7).stream('debris');
    const b = new RandomStreams(7).stream('debris');
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  test('streams are independent: drawing from one never shifts another', () => {
    const streams = new RandomStreams(7);
    const reference = new RandomStreams(7).stream('dust');
    streams.stream('debris').next();
    streams.stream('debris').next();
    const dust = streams.stream('dust');
    for (let i = 0; i < 20; i++) expect(dust.next()).toBe(reference.next());
  });

  test('reset replays from the start', () => {
    const streams = new RandomStreams(3);
    const first = [streams.stream('x').next(), streams.stream('x').next()];
    streams.reset();
    expect([streams.stream('x').next(), streams.stream('x').next()]).toEqual(first);
  });

  test('values stay in range and are roughly uniform', () => {
    const r = createRandomStream(99);
    let sum = 0;
    for (let i = 0; i < 20000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
      const n = r.int(6);
      expect(Number.isInteger(n) && n >= 0 && n < 6).toBe(true);
    }
    expect(Math.abs(sum / 20000 - 0.5)).toBeLessThan(0.01);
  });
});

describe('service registry', () => {
  test('provides and requires by token, and refuses duplicates and missing services', () => {
    const services = new ServiceRegistry();
    const token = serviceToken<{ n: number }>('thing');
    services.provide(token, { n: 1 });
    expect(services.require(token).n).toBe(1);
    expect(() => services.provide(token, { n: 2 })).toThrow(/already provided/);
    expect(() => services.require(serviceToken('missing'))).toThrow(/not provided/);
  });
});

describe('system registry', () => {
  test('runs step systems by phase, keeping insertion order within a phase', () => {
    const systems = new SystemRegistry();
    const order: string[] = [];
    systems.addStep({ name: 'physics', phase: StepPhase.Physics, step: () => order.push('physics') });
    systems.addStep({ name: 'hero', phase: StepPhase.Hero, step: () => order.push('hero') });
    systems.addStep({ name: 'input', phase: StepPhase.Input, step: () => order.push('input') });
    systems.addStep({ name: 'hero-2', phase: StepPhase.Hero, step: () => order.push('hero-2') });
    systems.runStep(1 / 60);
    expect(order).toEqual(['input', 'hero', 'hero-2', 'physics']);
  });

  test('runs only the requested frame phases', () => {
    const systems = new SystemRegistry();
    const order: string[] = [];
    systems.addFrame({ name: 'render', phase: FramePhase.Render, frame: () => order.push('render') });
    systems.addFrame({ name: 'input', phase: FramePhase.BeforeSim, frame: () => order.push('input') });
    systems.runFrame(0, 0, FramePhase.BeforeSim, FramePhase.BeforeSim);
    systems.runFrame(0, 0, FramePhase.Present, FramePhase.Render);
    expect(order).toEqual(['input', 'render']);
  });
});
