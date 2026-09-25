import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { HUD_MARKUP } from '../../src/present/ui/hud-markup';

// HudOverlay and hud-styles.css were ported against v1's DOM, so the markup must stay v1's:
// the repo-root index.html <body> without the #app wrapper, the canvas and the script tag.

const v1Html = readFileSync(fileURLToPath(new URL('../../../../index.html', import.meta.url)), 'utf8');

const normalise = (html: string): string => html.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
const ids = (html: string): string[] => [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]).sort();

function v1HudMarkup(): string {
  const body = /<body>([\s\S]*)<\/body>/.exec(v1Html)?.[1];
  if (!body) throw new Error('v1 index.html has no <body>');
  return body
    .replace(/<script[\s\S]*?<\/script>/, '')
    .replace(/<canvas[\s\S]*?<\/canvas>/, '')
    .replace(/^\s*<div id="app" class="app" data-state="loading" data-device="mouse">/, '')
    .replace(/<\/div>\s*$/, '');
}

describe('HUD markup', () => {
  test('has every id v1 had, and no others', () => {
    expect(ids(HUD_MARKUP)).toEqual(ids(v1HudMarkup()));
    expect(ids(HUD_MARKUP)).toHaveLength(35);
  });

  test('is v1’s index.html body without the #app wrapper, canvas and script', () => {
    expect(normalise(HUD_MARKUP)).toBe(normalise(v1HudMarkup()));
  });
});
