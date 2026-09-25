import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { compareImages, openPage, serveDirectory } from './browser-harness';

// Renders the same poses in v1 (repo root dist/) and v2 (aloft-v2/web/dist/) and compares the
// canvases. The world should look the same; the facade differs on purpose in fine detail (window
// rows now start at each tier's base), so images are compared at quarter resolution with a
// per-pixel colour threshold. Writes both renders and a diff map to test-results/parity/.

const OUT = fileURLToPath(new URL('../test-results/parity', import.meta.url));
const V1_DIST = fileURLToPath(new URL('../../../dist', import.meta.url));
const V2_DIST = fileURLToPath(new URL('../dist', import.meta.url));
const MAX_DIFFERENT_SHARE = 0.03;
mkdirSync(OUT, { recursive: true });

interface Pose {
  name: string;
  /** Frames to advance on the title screen before capturing (title shot only). */
  titleFrames?: number;
  position?: [number, number, number];
  yaw?: number;
  speed?: number;
  controls?: { steerX?: number; steerY?: number; boost?: boolean };
  /** Share of pixels allowed to differ, when a pose has known, intended differences (default 3%). */
  maxShare?: number;
}

const POSES: Pose[] = [
  { name: 'title', titleFrames: 90 },
  // Lit windows are hashed per building-space cell in v2 (so a broken-off chunk keeps its
  // windows), so a different set of windows glows; the scene is otherwise the same.
  { name: 'canyon', position: [-36, 70, -700], yaw: 0, speed: 60, controls: {}, maxShare: 0.2 },
  { name: 'above-clouds', position: [-800, 760, -1400], yaw: 0.6, speed: 50, controls: { steerY: -0.05 } },
  // Speed streaks, spray and wave phase depend on frame history, not on the look.
  { name: 'sea-skim', position: [-1700, 4, -800], yaw: -2.0, speed: 90, controls: { boost: true }, maxShare: 0.14 },
];

/** Each build's own test API, reduced to what the parity check needs. */
async function capture(page: Page, version: 'v1' | 'v2', pose: Pose): Promise<string> {
  return page.evaluate(
    ([v, p]) => {
      type Api = {
        state: string;
        flight: { position: { set(x: number, y: number, z: number): void }; yaw: number; pitch: number; speed: number };
        chase: { snapTo(flight: unknown): void };
        start(): void;
        pose(pose: unknown): void;
        setControls(controls: unknown): void;
        advance(frames: number): void;
        render(): void;
      };
      const api = (window as unknown as { __aloft: Api }).__aloft;
      const pose = p as Pose;
      if (pose.titleFrames) {
        api.advance(pose.titleFrames);
      } else {
        if (api.state === 'title') api.start();
        if (v === 'v1') {
          const flight = api.flight;
          flight.position.set(...pose.position!);
          flight.yaw = pose.yaw!;
          flight.pitch = 0;
          flight.speed = pose.speed!;
          api.chase.snapTo(flight);
        } else {
          api.pose({ position: pose.position, yaw: pose.yaw, pitch: 0, speed: pose.speed });
        }
        api.setControls(pose.controls ?? {});
        api.advance(60);
      }
      // Read the canvas in the same task as the render, before the browser clears it.
      api.render();
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      return canvas.toDataURL('image/png');
    },
    [version, pose] as const,
  );
}


const saveDataUrl = (name: string, dataUrl: string): void => writeFileSync(`${OUT}/${name}.png`, Buffer.from(dataUrl.split(',')[1]!, 'base64'));

async function renderAll(root: string, port: number, version: 'v1' | 'v2', viewport: 'desktop' | 'phone'): Promise<Map<string, string>> {
  const { url, server } = await serveDirectory(root, port);
  const { browser, page } = await openPage(url, viewport);
  const results = new Map<string, string>();
  try {
    await page.goto(`${url}?test`, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(() => !!(window as unknown as { __aloft?: unknown }).__aloft, null, { timeout: 180_000 });
    for (const pose of POSES) results.set(pose.name, await capture(page, version, pose));
  } finally {
    await browser.close();
    server.close();
  }
  return results;
}

let worst = 0;
const failures: string[] = [];
for (const viewport of ['desktop', 'phone'] as const) {
  const v1 = await renderAll(V1_DIST, 4191, 'v1', viewport);
  const v2 = await renderAll(V2_DIST, 4192, 'v2', viewport);
  const { browser, page } = await openPage('http://127.0.0.1/', viewport);
  try {
    await page.setContent('<html><body></body></html>');
    for (const pose of POSES) {
      const a = v1.get(pose.name)!;
      const b = v2.get(pose.name)!;
      const { share, diff } = await compareImages(page, a, b);
      saveDataUrl(`${viewport}-${pose.name}-v1`, a);
      saveDataUrl(`${viewport}-${pose.name}-v2`, b);
      saveDataUrl(`${viewport}-${pose.name}-diff`, diff);
      worst = Math.max(worst, share);
      console.log(`${viewport} ${pose.name}: ${(share * 100).toFixed(2)}% of pixels differ`);
      const limit = pose.maxShare ?? MAX_DIFFERENT_SHARE;
      if (share > limit) failures.push(`${viewport} ${pose.name}: ${(share * 100).toFixed(2)}% > ${(limit * 100).toFixed(0)}%`);
    }
  } finally {
    await browser.close();
  }
}
if (failures.length > 0) {
  console.error(`LOOK PARITY FAIL:\n- ${failures.join('\n- ')}\nImages in ${OUT}`);
  process.exit(1);
}
console.log(`LOOK PARITY PASS (worst ${(worst * 100).toFixed(2)}%) · images in ${OUT}`);
