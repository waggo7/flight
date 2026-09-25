import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';

// Player settings, saved in the browser (v1's set plus room to grow). Features read them and
// subscribe to changes; nothing else touches localStorage.

export interface PlayerSettings {
  sensitivity: number;
  invertY: boolean;
  firstPerson: boolean;
  sound: boolean;
  showKeys: boolean;
  destruction: boolean;
  /** The chosen hero's id (content/heroes/<id>.json). */
  hero: string;
}

export const DEFAULT_SETTINGS: Readonly<PlayerSettings> = Object.freeze({
  sensitivity: 1, invertY: false, firstPerson: false, sound: true, showKeys: true, destruction: true, hero: 'aurora',
});

export interface SettingsService {
  readonly current: Readonly<PlayerSettings>;
  update(changes: Partial<PlayerSettings>): void;
  onChange(listener: (settings: Readonly<PlayerSettings>) => void): () => void;
}

export const SettingsToken = serviceToken<SettingsService>('settings');

const STORAGE_KEY = 'aloft-v2-settings';

/**
 * Keep only known keys with the right types, so a stale or hand-edited entry can't break boot.
 * `heroIds` (content order): an unknown hero falls back to the first.
 */
export function sanitizeSettings(raw: unknown, heroIds: readonly string[] = []): PlayerSettings {
  const settings: PlayerSettings = { ...DEFAULT_SETTINGS, hero: heroIds[0] ?? DEFAULT_SETTINGS.hero };
  if (typeof raw !== 'object' || raw === null) return settings;
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof PlayerSettings)[]) {
    const value = record[key];
    if (typeof value === typeof DEFAULT_SETTINGS[key]) (settings as unknown as Record<string, unknown>)[key] = value;
  }
  settings.sensitivity = Math.min(2, Math.max(0.4, Number.isFinite(settings.sensitivity) ? settings.sensitivity : 1));
  if (heroIds.length > 0 && !heroIds.includes(settings.hero)) settings.hero = heroIds[0]!;
  return settings;
}

function readStored(testMode: boolean, heroIds: readonly string[]): PlayerSettings {
  if (testMode) return sanitizeSettings(null, heroIds);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return sanitizeSettings(raw ? JSON.parse(raw) : null, heroIds);
  } catch {
    return sanitizeSettings(null, heroIds);
  }
}

export const settingsFeature: Feature = {
  name: 'settings',
  install(ctx) {
    const heroIds = ctx.content.heroes.map((hero) => hero.id);
    let current = readStored(ctx.testMode, heroIds);
    const listeners = new Set<(settings: Readonly<PlayerSettings>) => void>();
    ctx.services.provide(SettingsToken, {
      get current() {
        return current;
      },
      update(changes) {
        current = sanitizeSettings({ ...current, ...changes }, heroIds);
        if (!ctx.testMode) {
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
          } catch {
            // Storage can be unavailable (private mode, sandboxed frames); settings just won't persist.
          }
        }
        for (const listener of listeners) listener(current);
      },
      onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
  },
};
