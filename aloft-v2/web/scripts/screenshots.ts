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
    // Skimming the sea in first person: spray beads on the visor.
    await page.evaluate(() => window.__aloft!.pose({ position: [-1700, 5, -800], yaw: -2.0, speed: 95 }));
    await advance(page, 110, { boost: true });
    await shot('first-person-sea');
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
      // Shift+V: the camera swings round in front of the hero to look back at the tower coming down.
      await page.keyboard.press('Shift+KeyV');
      await advance(page, 70, { boost: true });
      expect((await snapshot(page)).front === true, `${viewport}: Shift+V should switch to the front view`);
      await shot('front-view');
      await page.keyboard.press('Shift+KeyV');
      expect((await snapshot(page)).front === false, `${viewport}: Shift+V again should leave the front view`);
      await page.evaluate((t) => window.__aloft!.watch(t.point, t.yaw), target);
      await advance(page, 110, { brake: true });
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
      // Ground slam from 150 m up in the street beside a fresh tower.
      await page.evaluate(() => window.__aloft!.restart());
      await advance(page, 5, {});
      const slamTarget = await page.evaluate(() => window.__aloft!.aimAtTower(0, 20));
      if (slamTarget) {
        await page.evaluate((t) => {
          const api = window.__aloft!;
          api.pose({ position: [t.point[0] - Math.sin(t.yaw) * 14, t.point[1] + 90, t.point[2] - Math.cos(t.yaw) * 14], yaw: t.yaw, speed: 10 });
          api.power('slam');
        }, slamTarget);
        await advance(page, 40, {});
        await shot('slam-dive');
        await advance(page, 75, {});
        const slammed = await page.evaluate(() => window.__aloft!.snapshot);
        expect(['recover', 'cooldown', 'ready'].includes(slammed.slam as string), `${viewport}: the slam should have landed (phase ${slammed.slam})`);
        await shot('slam-impact');
        await page.evaluate((t) => window.__aloft!.watch(t.point, t.yaw, 240), slamTarget);
        await advance(page, 150, { brake: true });
        await shot('slam-aftermath');
      }
      // Demo scenes (desktop only, to keep the run short): each must stage and leave the world sane.
      if (viewport === 'desktop') {
        for (const [name, frames] of [['topple', 540], ['pancake', 420], ['domino', 600], ['slam', 420], ['throw', 780]] as const) {
          const staged = await page.evaluate((n) => window.__aloft!.scene(n), name);
          expect(staged, `${viewport}: the ${name} scene should find a site in the city`);
          for (let done = 0; done < frames; done += 120) await advance(page, Math.min(120, frames - done), null);
          await shot(`scene-${name}`);
          const after = await page.evaluate(() => window.__aloft!.destruction);
          expect(after.fragments > 0, `${viewport}: the ${name} scene should break something (fragments ${after.fragments})`);
        }
      }
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
