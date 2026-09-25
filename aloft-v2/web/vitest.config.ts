import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@content': fileURLToPath(new URL('../content', import.meta.url)) },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/sim/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
