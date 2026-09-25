import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadContent } from '../../src/engine/content-library';
import { FLIGHT_CASES, runFlightCase, type FlightConformanceFile } from '../conformance/flight-conformance';

// The committed vectors are the contract the Godot port must also meet. If this fails after an
// intended behaviour change, run `npm run conformance:write` and commit the new vectors.

const file = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../conformance/flight-model.json', import.meta.url)), 'utf8'),
) as FlightConformanceFile;

describe('flight conformance vectors', () => {
  test('the vectors were generated from the shipped tuning and the current case list', () => {
    expect(file.tuning).toEqual(loadContent().flight);
    expect(file.cases.map((c) => c.name)).toEqual(FLIGHT_CASES.map((c) => c.name));
  });

  for (const recorded of file.cases) {
    test(`replays "${recorded.name}" exactly`, () => {
      const replay = runFlightCase(recorded, file.tuning);
      expect(replay.events).toEqual(recorded.events);
      expect(replay.samples).toEqual(recorded.samples);
    });
  }
});
