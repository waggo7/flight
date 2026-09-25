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

const HEROES = ['aurora', 'bastion', 'swift'] as const;
/** The stills: a pose and the flight state it is shown in. */
const STILLS = [
  { pose: null, name: 'hover', hover: true, pitch: 0, speed: 0 },
  { pose: 'cruise', name: 'cruise', hover: false, pitch: 0, speed: 34 },
  { pose: 'boost', name: 'boost', hover: false, pitch: 0, speed: 108 },
  { pose: 'dive', name: 'dive', hover: false, pitch: -0.9, speed: 70 },
  { pose: 'brake', name: 'brake', hover: false, pitch: 0.1, speed: 30 },
  { pose: 'burst', name: 'burst', hover: false, pitch: 0, speed: 90 },
  { pose: 'slamLand', name: 'slamLand', hover: true, pitch: 0, speed: 0 },
  { pose: 'hold', name: 'hold', hover: true, pitch: 0, speed: 0 },
] as const;

/**
 * Each hero × each still, framed close up in one camera pose; writes one PNG per still and a
 * contact sheet per viewport. Returns the hero stats (draw calls, triangles, rig ms).
 */
async function heroStills(page: Page, viewport: Viewport): Promise<void> {
  const result = await page.evaluate(([heroes, stills]) => {
    const api = window.__aloft!;
    const canvas = document.querySelector('canvas')!;
    const portrait = canvas.height > canvas.width;
    const cellW = portrait ? 180 : 240;
    const cellH = portrait ? 260 : 240;
    const sheet = document.createElement('canvas');
    sheet.width = cellW * stills.length;
    sheet.height = cellH * heroes.length;
    const context = sheet.getContext('2d')!;
    const crops: Record<string, string> = {};
    const stats = [];
    for (const [row, id] of heroes.entries()) {
      api.setHero(id);
      stats.push(api.heroStats());
      for (const [column, still] of stills.entries()) {
        api.forcePose(still.pose);
        api.placeHero({ position: [-60, 190, -980], yaw: 0.09, pitch: still.pitch, speed: still.speed, hover: still.hover });
        api.advance(45, 1 / 60, false);
        api.frameHero({ azimuth: 0.75, elevation: 0.14, fill: 0.86 });
        crops[`${id}-${still.name}`] = canvas.toDataURL('image/png');
        // Contact sheet cell: the middle of the frame, scaled down.
        const sourceH = canvas.height * 0.94;
        const sourceW = Math.min(canvas.width, (sourceH * cellW) / cellH);
        context.drawImage(canvas, (canvas.width - sourceW) / 2, (canvas.height - sourceH) / 2, sourceW, sourceH, column * cellW, row * cellH, cellW, cellH);
      }
    }
    api.forcePose(null);
    api.setHero(heroes[0]!);
    api.placeHero({ position: [-60, 190, -980], yaw: 0.09, hover: true });
    return { crops, sheet: sheet.toDataURL('image/png'), stats };
  }, [HEROES, STILLS] as const);
  for (const [name, data] of Object.entries(result.crops)) writeFileSync(`${OUT}/${viewport}-hero-${name}.png`, Buffer.from(data.split(',')[1]!, 'base64'));
  writeFileSync(`${OUT}/${viewport}-heroes-sheet.png`, Buffer.from(result.sheet.split(',')[1]!, 'base64'));
  for (const stats of result.stats) {
    console.log(`${viewport}: hero ${stats.hero} — ${stats.drawCalls} draw calls, ${stats.triangles} triangles, ${stats.bones} bones, rig update ${stats.rigMs.toFixed(3)} ms`);
    expect(stats.drawCalls <= 4, `${viewport}: hero ${stats.hero} draws in ${stats.drawCalls} calls (max 4)`);
    expect(stats.triangles <= 30_000, `${viewport}: hero ${stats.hero} has ${stats.triangles} triangles (max 30k)`);
    expect(stats.rigMs < 0.2, `${viewport}: hero ${stats.hero} rig update takes ${stats.rigMs.toFixed(3)} ms (max 0.2)`);
  }
}

async function runViewport(url: string, viewport: Viewport): Promise<void> {
  const { browser, page, errors } = await openPage(`${url}?test`, viewport);
  const shot = (name: string): Promise<Buffer> => page.screenshot({ path: `${OUT}/${viewport}-${name}.png`, timeout: 180_000 });
  try {
    await page.goto(`${url}?test`, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(() => document.body.dataset.ready === 'true' && !!window.__aloft, null, { timeout: 120_000 });
    await advance(page, 30, null);
    await shot('title');
    expect((await snapshot(page)).state === 'title', `${viewport}: should boot to the title`);

    // Hero select: → cycles to the next preset (saved in settings), ← back.
    await page.keyboard.press('ArrowRight');
    expect((await page.evaluate(() => window.__aloft!.hero)) === 'bastion', `${viewport}: → on the title should pick the next hero`);
    await advance(page, 20, null);
    await shot('title-bastion');
    await page.keyboard.press('ArrowLeft');
    expect((await page.evaluate(() => window.__aloft!.hero)) === 'aurora', `${viewport}: ← should go back`);

    const started = Date.now();
    await heroStills(page, viewport);
    console.log(`${viewport}: hero stills in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    await advance(page, 10, null);

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
      // Engulfed in dust, the picture veils over but never goes black or blank white.
      const luminance = await page.evaluate(() => {
        const api = window.__aloft!;
        api.engulfInDust();
        api.advance(90, 1 / 60);
        api.render();
        const source = document.querySelector('canvas')!;
        const probe = document.createElement('canvas');
        probe.width = 64;
        probe.height = 36;
        const context = probe.getContext('2d')!;
        context.drawImage(source, 0, 0, 64, 36);
        const data = context.getImageData(0, 0, 64, 36).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
        return sum / (data.length / 4);
      });
      await shot('dust');
      console.log(`${viewport}: engulfed in dust, mean luminance ${luminance.toFixed(2)}`);
      expect(luminance >= 0.15 && luminance <= 0.85, `${viewport}: dust veil luminance ${luminance.toFixed(2)} outside 0.15–0.85`);
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
