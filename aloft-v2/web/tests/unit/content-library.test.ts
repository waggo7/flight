import { describe, expect, test } from 'vitest';
import { FLIGHT_SHAPE, loadContent } from '../../src/engine/content-library';
import { ContentError, num, obj, validated } from '../../src/engine/content-validation';

describe('content', () => {
  test('all shipped content validates', () => {
    const content = loadContent();
    expect(content.flight.cruiseSpeed).toBe(34);
    expect(content.simulation.stepsPerSecond).toBe(60);
  });

  test('a value out of range fails with its path', () => {
    const bad = { ...loadContent().flight, cruiseSpeed: -5 };
    expect(() => validated(bad, FLIGHT_SHAPE, 'flight.json')).toThrow(ContentError);
    expect(() => validated(bad, FLIGHT_SHAPE, 'flight.json')).toThrow(/flight\.json\.cruiseSpeed/);
  });

  test('typos (unknown keys) and missing keys fail; $notes are allowed', () => {
    const shape = { speed: num(0, 10) };
    expect(() => validated({ speed: 1, sped: 2 }, shape, 'x')).toThrow(/unknown key/);
    expect(() => validated({}, shape, 'x')).toThrow(/missing/);
    expect(validated<{ speed: number }>({ speed: 1, $notes: { speed: 'm/s' } }, shape, 'x').speed).toBe(1);
    expect(() => validated({ nested: { a: 'no' } }, { nested: obj({ a: num(0, 1) }) }, 'x')).toThrow(/x\.nested\.a/);
  });
});
