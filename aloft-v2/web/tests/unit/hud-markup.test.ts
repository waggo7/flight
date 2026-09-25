import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { HUD_MARKUP } from '../../src/present/ui/hud-markup';

// HudOverlay and hud-styles.css were ported against v1's DOM, so the markup stays v1's (the
// repo-root index.html <body> without the #app wrapper, the canvas and the script tag) except
// where v2 changed on purpose: the spark trails are gone (no spark badge or pointer), and the key
// legend has v2's controls (look back, and view on the D-pad).

const v1Html = readFileSync(fileURLToPath(new URL('../../../../index.html', import.meta.url)), 'utf8');

const normalise = (html: string): string => html.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
const ids = (html: string): string[] => [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]).sort();
const SPARK_IDS = ['spark-pointer', 'sparks', 'sparks-total', 'sparks-value'];

function v1HudMarkup(): string {
  const body = /<body>([\s\S]*)<\/body>/.exec(v1Html)?.[1];
  if (!body) throw new Error('v1 index.html has no <body>');
  return body
    .replace(/<script[\s\S]*?<\/script>/, '')
    .replace(/<canvas[\s\S]*?<\/canvas>/, '')
    .replace(/^\s*<div id="app" class="app" data-state="loading" data-device="mouse">/, '')
    .replace(/<\/div>\s*$/, '');
}

/** v1's markup with the spark badge and pointer taken out and the key legend set aside. */
function withoutSparksOrLegend(html: string): string {
  return normalise(html)
    .replace(/<div id="sparks"[\s\S]*?<\/span><\/span><\/div>/, '')
    .replace(/<div id="spark-pointer"[^>]*><span><\/span><\/div>/, '')
    .replace(/<aside id="key-legend"[\s\S]*?<\/aside>/, '<aside/>');
}

describe('HUD markup', () => {
  test('has every id v1 had except the spark badge and pointer, and no others', () => {
    const v1 = ids(v1HudMarkup());
    expect(v1).toEqual(expect.arrayContaining(SPARK_IDS));
    expect(ids(HUD_MARKUP)).toEqual(v1.filter((id) => !SPARK_IDS.includes(id)));
  });

  test('is v1’s index.html body apart from the sparks and the key legend', () => {
    expect(withoutSparksOrLegend(HUD_MARKUP)).toBe(withoutSparksOrLegend(v1HudMarkup()));
    expect(HUD_MARKUP).not.toMatch(/spark/);
  });

  test('the key legend lists look back for keyboard and gamepad', () => {
    expect(normalise(HUD_MARKUP)).toContain('<dt>Look back</dt><dd><kbd>Shift</kbd><kbd>V</kbd></dd>');
    expect(normalise(HUD_MARKUP)).toContain('<dt>Look back</dt><dd><kbd>D-pad ↓</kbd></dd>');
  });
});
