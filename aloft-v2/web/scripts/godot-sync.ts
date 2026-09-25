import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Copies the engine-neutral content and conformance vectors into godot/shared/ (gitignored),
// where the Godot project can read them as res://shared/...

const root = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const shared = root('godot/shared');

export function syncGodotShared(): void {
  rmSync(shared, { recursive: true, force: true });
  mkdirSync(shared, { recursive: true });
  cpSync(root('content'), `${shared}/content`, { recursive: true });
  cpSync(root('conformance'), `${shared}/conformance`, { recursive: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncGodotShared();
  console.log(`synced content/ and conformance/ into ${shared}`);
}
