import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadContent } from '../../src/engine/content-library';
import { buildCoreConformance, type CoreConformanceFile } from '../conformance/core-conformance';

// The committed destruction and power vectors are the contract a Godot port must also meet. If this
// fails after an intended change, run `npm run conformance:write` and commit the new vectors.

const file = JSON.parse(readFileSync(fileURLToPath(new URL('../../../conformance/destruction-and-powers.json', import.meta.url)), 'utf8')) as CoreConformanceFile;

test('destruction and power vectors replay exactly', () => {
  const content = loadContent();
  expect(buildCoreConformance(content.destruction, content.powers)).toEqual(file);
});
