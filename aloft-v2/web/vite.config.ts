import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` emits one self-contained dist/index.html: open it anywhere, host it anywhere.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  resolve: {
    alias: { '@content': fileURLToPath(new URL('../content', import.meta.url)) },
  },
  server: {
    fs: { allow: ['..'] },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
});
