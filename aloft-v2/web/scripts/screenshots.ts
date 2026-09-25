import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { compareImages, openPage, serveDist, type Viewport } from './browser-harness';

// Headless end-to-end check of the built game: boots in ?test mode, flies scripted inputs,
// asserts the basics, and saves screenshots to test-results/shots/.

const OUT = fileURLToPath(new URL('../test-results/shots', import.meta.url));
mkdirSync(OUT, { recursive: true });

type Controls = { steerX?: number; steerY?: number; boost?: boolean; brake?: boolean } | null;

const failures: string[] = [];
const expect = (condition: boolean, message: string): void => {
  if (!condition) failures.push(message);
};

async function advance(page: Page, frames: number, controls: Controls): Promise<void> {
  await page.evaluate(([f, c]) => {
    window.__aloft!.setControls(c as Controls);
    window.__aloft!.advance(f as number);
  }, [frames, controls] as const);
}

const snapshot = (page: Page): Promise<Record<string, unknown>> => page.evaluate(() => window.__aloft!.snapshot);

async function runViewport(url: string, viewport: Viewport): Promise<void> {
  const { browser, page, errors } = await openPage(`${url}?test`, viewport);
  const shot = (name: string): Promise<Buffer> => page.screenshot({ path: `${OUT}/${viewport}-${name}.png`, timeout: 180_000 });
  try {
    await page.goto(`${url}?test`, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(() => document.body.dataset.ready === 'true' && !!window.__aloft, null, { timeout: 120_000 });
    await advance(page, 30, null);
    await shot('title');
    expect((await snapshot(page)).state === 'title', `${viewport}: should boot to the title`);

    await page.evaluate(() => window.__aloft!.start());
    await advance(page, 120, {});
    const cruising = await snapshot(page);
    expect(cruising.state === 'flying' && cruising.mode === 'flying', `${viewport}: launch should start flying`);
    expect(Math.abs((cruising.speed as number) - 34) < 6, `${viewport}: should approach cruise speed, got ${cruising.speed}`);
    await shot('cruise');

    await advance(page, 180, { boost: true, steerX: -0.35, steerY: 0.05 });
    const boosting = await snapshot(page);
    expect((boosting.speed as number) > 80, `${viewport}: boost should exceed 80 m/s, got ${boosting.speed}`);
    await shot('boost-turn');

    await page.keyboard.press('KeyV');
    await advance(page, 60, { boost: true });
    expect((await snapshot(page)).view === 'first', `${viewport}: V should switch to first person`);
    await shot('first-person');
    await page.keyboard.press('KeyV');

    await advance(page, 240, { brake: true });
    expect((await snapshot(page)).mode === 'hover', `${viewport}: braking should settle into a hover`);
    await shot('hover');

    // No pop: towers swapped for their storey × bay chunks must draw exactly like the intact ones.
    const [intact, chunked, swapped] = await page.evaluate(() => {
      const api = window.__aloft!;
      api.pose({ position: [-36, 70, -700], yaw: 0, speed: 60 });
      api.setControls({});
      api.advance(30);
      const canvas = document.querySelector('canvas')!;
      api.render();
      const before = canvas.toDataURL('image/png');
      const count = api.chunkify(-36, -560, 260);
      api.render();
      return [before, canvas.toDataURL('image/png'), count] as const;
    });
    const noPop = await compareImages(page, intact, chunked, { downscale: 1, threshold: 0.06 });
    console.log(`${viewport}: no-pop — ${swapped} towers chunked, ${(noPop.share * 100).toFixed(3)}% of pixels differ`);
    expect(swapped > 10, `${viewport}: no-pop check should chunk the canyon towers, chunked ${swapped}`);
    expect(noPop.share <= 0.005, `${viewport}: chunking popped ${(noPop.share * 100).toFixed(2)}% of pixels (max 0.5%)`);
    writeFileSync(`${OUT}/${viewport}-no-pop-diff.png`, Buffer.from(noPop.diff.split(',')[1]!, 'base64'));
    // Destruction: smash a tall tower at full boost, then turn round and hover to watch it go.
    const target = await page.evaluate(() => window.__aloft!.aimAtTower(108));
    expect(target !== null, `${viewport}: should find a tower to smash`);
    if (target) {
      await advance(page, 40, { boost: true });
      await shot('smash');
      const afterHit = await page.evaluate(() => window.__aloft!.destruction);
      expect(afterHit.fragments > 0, `${viewport}: smashing a tower should break pieces off (fragments ${afterHit.fragments})`);
      await page.evaluate((t) => window.__aloft!.watch(t.point, t.yaw), target);
      await advance(page, 180, { brake: true });
      await shot('topple');
      await advance(page, 240, { brake: true });
      await shot('collapse');
      await advance(page, 300, { brake: true });
      await shot('rubble');
      const later = await page.evaluate(() => window.__aloft!.snapshot);
      expect(Number.isFinite((later.position as number[])[1]!), `${viewport}: hero position should stay finite`);
    }
    expect(errors.length === 0, `${viewport}: page errors:\n  ${errors.join('\n  ')}`);
  } finally {
    await browser.close();
  }
}

const { url, server } = await serveDist();
try {
  for (const viewport of ['desktop', 'phone'] as const) {
    const started = Date.now();
    await runViewport(url, viewport);
    console.log(`${viewport}: done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
} finally {
  server.close();
}
if (failures.length > 0) {
  console.error(`E2E FAIL (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`E2E PASS · screenshots in ${OUT}`);
