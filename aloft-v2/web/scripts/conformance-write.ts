import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadContent } from '../src/engine/content-library';
import { buildCoreConformance } from '../tests/conformance/core-conformance';
import { buildFlightConformance } from '../tests/conformance/flight-conformance';

// Regenerates aloft-v2/conformance/*.json from the TypeScript core. Run only when behaviour
// changes on purpose; the web tests and the Godot runner both check against these files.

const target = (name: string): string => fileURLToPath(new URL(`../../conformance/${name}`, import.meta.url));

const flight = buildFlightConformance(loadContent().flight);
writeFileSync(target('flight-model.json'), `${JSON.stringify(flight, null, 1)}\n`);
console.log(`flight-model.json: ${flight.cases.length} cases, ${flight.cases.reduce((n, c) => n + c.samples.length, 0)} samples`);

const content = loadContent();
const core = buildCoreConformance(content.destruction, content.powers);
writeFileSync(target('destruction-and-powers.json'), `${JSON.stringify(core, null, 1)}\n`);
console.log(`destruction-and-powers.json: ${core.storeyLayouts.length} layouts, ${core.hits.length} hits, ${core.timelines.length} timelines`);
