import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadContent } from '../src/engine/content-library';
import { buildFlightConformance } from '../tests/conformance/flight-conformance';
import { buildPoseConformance } from '../tests/conformance/hero-pose-conformance';

// Regenerates aloft-v2/conformance/*.json from the TypeScript core. Run only when behaviour
// changes on purpose; the web tests and the Godot runner both check against these files.

const target = (name: string): string => fileURLToPath(new URL(`../../conformance/${name}`, import.meta.url));

const content = loadContent();
const flight = buildFlightConformance(content.flight);
writeFileSync(target('flight-model.json'), `${JSON.stringify(flight, null, 1)}\n`);
console.log(`flight-model.json: ${flight.cases.length} cases, ${flight.cases.reduce((n, c) => n + c.samples.length, 0)} samples`);

const poses = buildPoseConformance(content.poses);
writeFileSync(target('hero-pose-graph.json'), `${JSON.stringify(poses)}\n`);
console.log(`hero-pose-graph.json: ${poses.cases.length} cases, ${poses.cases.reduce((n, c) => n + c.samples.length, 0)} samples`);
