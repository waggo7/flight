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
  /** Comfort (M8): first-person roll share, level horizon, FOV cap (degrees), reduced motion. */
  rollShare: number;
  horizonLock: boolean;
  maxFov: number;
  reducedMotion: boolean;
}

export const DEFAULT_SETTINGS: Readonly<PlayerSettings> = Object.freeze({
  sensitivity: 1, invertY: false, firstPerson: false, sound: true, showKeys: true, destruction: true,
  rollShare: 0.5, horizonLock: false, maxFov: 90, reducedMotion: false,
});

export interface SettingsService {
  readonly current: Readonly<PlayerSettings>;
  update(changes: Partial<PlayerSettings>): void;
  onChange(listener: (settings: Readonly<PlayerSettings>) => void): () => void;
}

export const SettingsToken = serviceToken<SettingsService>('settings');

const STORAGE_KEY = 'aloft-v2-settings';

/** Keep only known keys with the right types, so a stale or hand-edited entry can't break boot. */
export function sanitizeSettings(raw: unknown): PlayerSettings {
  const settings: PlayerSettings = { ...DEFAULT_SETTINGS };
  if (typeof raw !== 'object' || raw === null) return settings;
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof PlayerSettings)[]) {
    const value = record[key];
    if (typeof value === typeof DEFAULT_SETTINGS[key]) (settings as unknown as Record<string, unknown>)[key] = value;
  }
  settings.sensitivity = Math.min(2, Math.max(0.4, Number.isFinite(settings.sensitivity) ? settings.sensitivity : 1));
  settings.rollShare = Math.min(1, Math.max(0, Number.isFinite(settings.rollShare) ? settings.rollShare : 0.5));
  settings.maxFov = Math.min(110, Math.max(60, Number.isFinite(settings.maxFov) ? settings.maxFov : 90));
  return settings;
}

function readStored(testMode: boolean): PlayerSettings {
  if (testMode) return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return sanitizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const settingsFeature: Feature = {
  name: 'settings',
  install(ctx) {
    let current = readStored(ctx.testMode);
    const listeners = new Set<(settings: Readonly<PlayerSettings>) => void>();
    ctx.services.provide(SettingsToken, {
      get current() {
        return current;
      },
      update(changes) {
        current = sanitizeSettings({ ...current, ...changes });
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
