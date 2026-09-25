import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openPage, serveDist } from './browser-harness';

// Renders the collapse recipes offline in headless Chromium (through the ?test API), checks the
// build plan's M5 numbers, and writes WAVs to test-results/audio/ to listen to.

const OUT = fileURLToPath(new URL('../test-results/audio', import.meta.url));
mkdirSync(OUT, { recursive: true });

const { url, server } = await serveDist(4183);
const { browser, page, errors } = await openPage(`${url}?test`, 'desktop');
const failures: string[] = [];
const expect = (ok: boolean, message: string): void => {
  if (!ok) failures.push(message);
};
try {
  await page.goto(`${url}?test`, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction(() => document.body.dataset.ready === 'true' && !!window.__aloft, null, { timeout: 120_000 });
  const r = await page.evaluate(() => window.__aloft!.audioBench());
  for (const [name, data] of Object.entries(r.wavs)) writeFileSync(`${OUT}/${name}.wav`, Buffer.from(data, 'base64'));
  const hz = (v: number): string => `${Math.round(v)} Hz`;
  console.log(`peak ${r.peakDbfs.toFixed(2)} dBFS · NaN ${r.hasNaN} · roar tail ${r.roarTail.toFixed(2)} s · boom ${r.boomLength.toFixed(2)} s`);
  console.log(`centroids: concrete ${hz(r.centroids.concrete)} · glass ${hz(r.centroids.glass)} · groan ${hz(r.centroids.groan)}`);
  console.log(`1,000 contacts → peak ${r.peakVoices} voices · 1,000 m vs 50 m: +${r.distance.delay.toFixed(2)} s, −${r.distance.lossDb.toFixed(1)} dB`);
  expect(r.peakDbfs <= -1, `peak ${r.peakDbfs.toFixed(2)} dBFS > −1 dBFS`);
  expect(!r.hasNaN, 'NaN in a render');
  expect(r.roarTail >= 2, `the roar outlasts its drive by ${r.roarTail.toFixed(2)} s (< 2 s)`);
  expect(r.boomLength >= 2.5, `boom lasts ${r.boomLength.toFixed(2)} s (< 2.5 s)`);
  expect(r.centroids.concrete >= 300 && r.centroids.concrete <= 1200, `concrete centroid ${hz(r.centroids.concrete)} outside 0.3–1.2 kHz`);
  expect(r.centroids.glass >= 3000 && r.centroids.glass <= 7000, `glass centroid ${hz(r.centroids.glass)} outside 3–7 kHz`);
  expect(r.centroids.groan >= 80 && r.centroids.groan <= 400, `groan centroid ${hz(r.centroids.groan)} outside 80–400 Hz`);
  expect(r.peakVoices <= 32, `${r.peakVoices} voices > 32`);
  expect(Math.abs(r.distance.delay - 950 / 343) < 0.05, `1,000 m arrives ${r.distance.delay.toFixed(2)} s after 50 m (expected 2.77 s)`);
  expect(r.distance.lossDb >= 18, `1,000 m is only ${r.distance.lossDb.toFixed(1)} dB quieter (< 18 dB)`);
  expect(errors.length === 0, `page errors:\n  ${errors.join('\n  ')}`);
} finally {
  await browser.close();
  server.close();
}
if (failures.length > 0) {
  console.error(`AUDIO FAIL (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`AUDIO PASS · WAVs in ${OUT}`);
