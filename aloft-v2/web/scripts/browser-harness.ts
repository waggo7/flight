import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

// Shared plumbing for headless checks: serve dist/, launch the preinstalled Chromium on
// SwiftShader, route web fonts through Node, and collect console errors.

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
};

/** The container's own address: loopback traffic may be routed through the egress proxy. */
function hostAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  }
  return '127.0.0.1';
}

export function serveDist(port = Number(process.env.E2E_PORT ?? 4180)): Promise<{ url: string; server: Server }> {
  return serveDirectory(DIST, port);
}

/** Serve a built single-page app (any folder with an index.html) on the container's address. */
export async function serveDirectory(root: string, port: number): Promise<{ url: string; server: Server }> {
  if (!existsSync(join(root, 'index.html'))) throw new Error(`${root}/index.html is missing: build it first.`);
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent((request.url ?? '/').split('?')[0]!)).replace(/^(\.\.[/\\])+/, '');
    let file = join(root, path === '/' ? 'index.html' : path);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  return { url: `http://${hostAddress()}:${port}/`, server };
}

export interface HarnessPage {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  errors: string[];
}

export type Viewport = 'desktop' | 'phone';

export async function openPage(url: string, viewport: Viewport): Promise<HarnessPage> {
  const host = new URL(url).hostname;
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const browser = await chromium.launch({
    // The preinstalled Chromium in cloud sessions; CI uses Playwright's own download.
    executablePath: process.env.CHROMIUM_PATH ?? (existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
    proxy: proxy ? { server: proxy, bypass: `${host},127.0.0.1,localhost` } : undefined,
  });
  const context = await browser.newContext(
    viewport === 'phone'
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }
      : { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
  );
  // tsx (esbuild keepNames) wraps named functions in page.evaluate bodies with __name(); give the
  // page a no-op one. A string, so it isn't transformed itself.
  await context.addInitScript('window.__name = (fn) => fn;');
  // Chromium doesn't trust the egress proxy's CA; Node does. Fetch fonts in Node and hand them over.
  await context.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
    try {
      const response = await fetch(route.request().url(), { headers: { 'user-agent': 'Mozilla/5.0 Chrome/140.0 Safari/537.36' } });
      await route.fulfill({
        status: response.status,
        headers: { 'content-type': response.headers.get('content-type') ?? 'text/css', 'access-control-allow-origin': '*' },
        body: Buffer.from(await response.arrayBuffer()),
      });
    } catch {
      await route.abort();
    }
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return { browser, context, page, errors };
}

/**
 * Share of pixels that differ between two PNG data URLs (colour distance above `threshold`, 0..1),
 * compared at 1/`downscale` resolution, plus a diff image with the differing pixels in red.
 */
export async function compareImages(page: Page, a: string, b: string, { downscale = 4, threshold = 0.12 } = {}): Promise<{ share: number; diff: string }> {
  return page.evaluate(
    async ([first, second, threshold, scale]) => {
      const load = (src: string): Promise<HTMLImageElement> =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = src;
        });
      const [imageA, imageB] = await Promise.all([load(first as string), load(second as string)]);
      const width = Math.round(imageA.width / (scale as number));
      const height = Math.round(imageA.height / (scale as number));
      const pixels = (image: HTMLImageElement): Uint8ClampedArray => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0, width, height);
        return context.getImageData(0, 0, width, height).data;
      };
      const pa = pixels(imageA);
      const pb = pixels(imageB);
      const diffCanvas = document.createElement('canvas');
      diffCanvas.width = width;
      diffCanvas.height = height;
      const diffContext = diffCanvas.getContext('2d')!;
      const diff = diffContext.createImageData(width, height);
      let different = 0;
      for (let i = 0; i < pa.length; i += 4) {
        const distance = Math.hypot(pa[i]! - pb[i]!, pa[i + 1]! - pb[i + 1]!, pa[i + 2]! - pb[i + 2]!) / 441.7;
        const off = distance > (threshold as number);
        if (off) different++;
        diff.data[i] = off ? 255 : pa[i]! * 0.25;
        diff.data[i + 1] = off ? 40 : pa[i + 1]! * 0.25;
        diff.data[i + 2] = off ? 40 : pa[i + 2]! * 0.25;
        diff.data[i + 3] = 255;
      }
      diffContext.putImageData(diff, 0, 0);
      return { share: different / (width * height), diff: diffCanvas.toDataURL('image/png') };
    },
    [a, b, threshold, downscale] as const,
  );
}
