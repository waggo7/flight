import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Layer boundaries keep the portable core ready for a Godot port:
//   core/   pure logic; three.js math only via core/math.ts; no DOM, no Rapier, no Math.random
//   engine/ loop, events, content; may import core/
//   sim/    headless simulation; may import core/, engine/ and Rapier; no DOM
//   present/, features/, app/  browser layers; may import anything below them
const noMathRandom = {
  'no-restricted-properties': ['error', { object: 'Math', property: 'random', message: 'Use engine/random-streams so runs are reproducible.' }],
};
const noBrowser = {
  'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'requestAnimationFrame', 'localStorage'],
};
const upperLayers = ['**/present/**', '**/features/**', '**/app/**'];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/core/**/*.ts'],
    ignores: ['src/core/math.ts'],
    rules: {
      ...noMathRandom,
      ...noBrowser,
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['three', 'three/*'], message: 'core/ uses three.js math only through core/math.ts.' },
          { group: ['@dimforge/*'], message: 'core/ is engine-neutral (Godot port target).' },
          { group: ['**/engine/**', '**/sim/**', ...upperLayers], message: 'core/ may import only core/.' },
        ],
      }],
    },
  },
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      ...noMathRandom,
      ...noBrowser,
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['three', 'three/*'], message: 'Use core/math.ts.' },
          { group: ['@dimforge/*', '**/sim/**', ...upperLayers], message: 'engine/ may import only core/.' },
        ],
      }],
    },
  },
  {
    files: ['src/sim/**/*.ts'],
    rules: {
      ...noMathRandom,
      ...noBrowser,
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['three', 'three/*'], message: 'Use core/math.ts.' },
          { group: upperLayers, message: 'sim/ may not import browser layers.' },
        ],
      }],
    },
  },
);
