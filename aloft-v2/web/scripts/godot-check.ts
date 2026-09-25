import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncGodotShared } from './godot-sync';

// Runs the Godot conformance suite headless. Downloads Godot 4.7.2 once into ~/.cache/aloft
// (or uses $GODOT_BIN), syncs the shared JSON, then runs godot/tests/conformance_runner.gd.

const VERSION = '4.7.2-stable';
const ARCHIVE = `Godot_v${VERSION}_linux.x86_64`;
const URL_BASE = `https://github.com/godotengine/godot-builds/releases/download/${VERSION}`;

function run(command: string, args: string[], cwd?: string): number {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function ensureGodot(): string {
  if (process.env.GODOT_BIN) return process.env.GODOT_BIN;
  const cache = join(homedir(), '.cache', 'aloft', `godot-${VERSION}`);
  const binary = join(cache, ARCHIVE);
  if (existsSync(binary)) return binary;
  mkdirSync(cache, { recursive: true });
  const zip = join(cache, `${ARCHIVE}.zip`);
  console.log(`downloading Godot ${VERSION} (one time)…`);
  if (run('curl', ['-fsSL', '--retry', '3', '-o', zip, `${URL_BASE}/${ARCHIVE}.zip`]) !== 0) throw new Error('Godot download failed');
  if (run('unzip', ['-o', '-q', zip, '-d', cache]) !== 0) throw new Error('Godot unzip failed');
  chmodSync(binary, 0o755);
  return binary;
}

const godot = ensureGodot();
syncGodotShared();
const project = fileURLToPath(new URL('../../godot', import.meta.url));
const status = run(godot, ['--headless', '--path', project, '--script', 'res://tests/conformance_runner.gd']);
process.exit(status);
