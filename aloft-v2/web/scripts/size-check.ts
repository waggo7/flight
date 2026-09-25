import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// The build must stay one self-contained HTML file small enough to share as a link.
const LIMIT_BYTES = 4.0 * 1024 * 1024;

const file = fileURLToPath(new URL('../dist/index.html', import.meta.url));
const bytes = statSync(file).size;
const gzipped = gzipSync(readFileSync(file)).length;
const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(`dist/index.html: ${mb(bytes)} (${mb(gzipped)} gzipped), limit ${mb(LIMIT_BYTES)}`);
if (bytes > LIMIT_BYTES) {
  console.error('Build is over the size limit.');
  process.exit(1);
}
