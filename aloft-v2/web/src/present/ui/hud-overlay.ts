import { clamp } from '../../core/scalar-math';
import type { InputDevice } from '../input/input-controls';

// The DOM layer: title and pause screens, a quiet flight HUD, one-at-a-time hints,
// toasts, the mouse-stick reticle and touch controls.
// Ported from v1 (src/hud-overlay.js). The markup comes from mountHudMarkup (hud-markup.ts);
// `on()` now keeps every handler registered for an event (v1 kept only the last one).

export interface HudSettings {
  /** Steering sensitivity, 0.6–1.6. */
  sensitivity: number;
  invertY: boolean;
  firstPerson: boolean;
  sound: boolean;
  /** Show the key legend on screen. */
  showKeys: boolean;
  /** Buildings can break. */
  destruction: boolean;
}

export type HudTouchButton = 'boost' | 'brake';

/** Every HUD event and the arguments its handlers receive. */
export interface HudEventMap {
  /** The title screen's "Take flight" button. */
  start: [];
  resume: [];
  restart: [];
  /** The on-screen pause button (touch). */
  pause: [];
  /** Any settings field changed; carries the whole form. */
  settings: [settings: HudSettings];
  /** An on-screen touch button went down or up. */
  touchButton: [name: HudTouchButton, pressed: boolean];
}

export type HudEvent = keyof HudEventMap;
export type HudHandler<K extends HudEvent> = (...args: HudEventMap[K]) => void;

/** The pointer state the HUD draws: v1's InputControls `mouse` and `touchSteer`. */
export interface HudPointerInput {
  readonly mouse: {
    /** The mouse is steering (it has moved over the game since flight started). */
    readonly active: boolean;
    /** Pointer position, CSS pixels. */
    readonly x: number;
    readonly y: number;
    /** Stick deflection after the dead zone and curve, -1..1. */
    readonly stickX: number;
    readonly stickY: number;
  };
  readonly touchSteer: {
    /** Pointer id of the steering thumb, or null when no thumb is steering. */
    readonly id: number | null;
    /** Where the thumb went down, CSS pixels. */
    readonly originX: number;
    readonly originY: number;
    /** Where the thumb is now, CSS pixels. */
    readonly x: number;
    readonly y: number;
  };
}

/** What the HUD shows each frame. */
export interface HudFrame {
  /** Hero speed, m/s (shown as km/h). */
  readonly speed: number;
  /** Height above the surface below, metres. */
  readonly altitude: number;
  readonly input: HudPointerInput;
  readonly device: InputDevice;
  /** True only while flying (not on the title or pause screens). */
  readonly flying: boolean;
}

type ElementType<T extends HTMLElement> = { new (): T; prototype: T };

function findElement<T extends HTMLElement>(root: HTMLElement, id: string, type: ElementType<T>): T {
  const element = root.querySelector(`#${id}`);
  if (!(element instanceof type)) throw new Error(`HUD: no <${type.name}> #${id} inside the app root (call mountHudMarkup first)`);
  return element;
}

function findAppRoot(): HTMLElement {
  const app = document.getElementById('app');
  if (!app) throw new Error('HUD: no #app element');
  return app;
}

export class HudOverlay {
  readonly app: HTMLElement;
  readonly titleScreen: HTMLElement;
  readonly pauseScreen: HTMLElement;
  readonly hud: HTMLElement;
  readonly startButton: HTMLButtonElement;
  readonly resumeButton: HTMLButtonElement;
  readonly restartButton: HTMLButtonElement;
  readonly fadeVeil: HTMLElement;
  readonly pauseButton: HTMLButtonElement;
  readonly loadingNote: HTMLElement;
  readonly speedValue: HTMLElement;
  readonly altitudeValue: HTMLElement;
  readonly hintEl: HTMLElement;
  readonly toastEl: HTMLElement;
  readonly reticle: HTMLElement;
  readonly reticleDot: HTMLElement;
  readonly reticleLine: HTMLElement;
  readonly touchControls: HTMLElement;
  readonly touchStick: HTMLElement;
  readonly touchKnob: HTMLElement;
  readonly touchBoost: HTMLButtonElement;
  readonly touchHover: HTMLButtonElement;
  readonly fields: {
    readonly sensitivity: HTMLInputElement;
    readonly invertY: HTMLInputElement;
    readonly firstPerson: HTMLInputElement;
    readonly sound: HTMLInputElement;
    readonly showKeys: HTMLInputElement;
    readonly destruction: HTMLInputElement;
  };
  readoutTimer = 0;
  toastTimer = 0;
  hintKey: string | null = null;

  private readonly handlers: { [K in HudEvent]: Set<HudHandler<K>> } = {
    start: new Set(),
    resume: new Set(),
    restart: new Set(),
    pause: new Set(),
    settings: new Set(),
    touchButton: new Set(),
  };

  /** `root` is the element mountHudMarkup filled (default: `#app`). */
  constructor(root: HTMLElement = findAppRoot()) {
    const find = <T extends HTMLElement>(id: string, type: ElementType<T>): T => findElement(root, id, type);
    this.app = root;
    this.titleScreen = find('title-screen', HTMLElement);
    this.pauseScreen = find('pause-screen', HTMLElement);
    this.hud = find('hud', HTMLElement);
    this.startButton = find('start-button', HTMLButtonElement);
    this.resumeButton = find('resume-button', HTMLButtonElement);
    this.restartButton = find('restart-button', HTMLButtonElement);
    this.fadeVeil = find('fade-veil', HTMLElement);
    this.pauseButton = find('pause-button', HTMLButtonElement);
    this.loadingNote = find('loading-note', HTMLElement);
    this.speedValue = find('speed-value', HTMLElement);
    this.altitudeValue = find('altitude-value', HTMLElement);
    this.hintEl = find('hint', HTMLElement);
    this.toastEl = find('toast', HTMLElement);
    this.reticle = find('reticle', HTMLElement);
    this.reticleDot = find('reticle-dot', HTMLElement);
    this.reticleLine = find('reticle-line', HTMLElement);
    this.touchControls = find('touch-controls', HTMLElement);
    this.touchStick = find('touch-stick', HTMLElement);
    this.touchKnob = find('touch-knob', HTMLElement);
    this.touchBoost = find('touch-boost', HTMLButtonElement);
    this.touchHover = find('touch-hover', HTMLButtonElement);
    this.fields = {
      sensitivity: find('setting-sensitivity', HTMLInputElement),
      invertY: find('setting-invert', HTMLInputElement),
      firstPerson: find('setting-first-person', HTMLInputElement),
      sound: find('setting-sound', HTMLInputElement),
      showKeys: find('setting-keys', HTMLInputElement),
      destruction: find('setting-destruction', HTMLInputElement),
    };

    this.startButton.addEventListener('click', () => this.emit('start'));
    this.resumeButton.addEventListener('click', () => this.emit('resume'));
    this.restartButton.addEventListener('click', () => this.emit('restart'));
    this.pauseButton.addEventListener('click', () => this.emit('pause'));
    this.fields.sensitivity.addEventListener('input', () => this.emitSettings());
    for (const key of ['invertY', 'firstPerson', 'sound', 'showKeys', 'destruction'] as const) {
      this.fields[key].addEventListener('change', () => this.emitSettings());
    }

    const hold = (element: HTMLElement, name: HudTouchButton): void => {
      const set = (pressed: boolean) => (event: Event): void => {
        event.preventDefault();
        element.classList.toggle('is-pressed', pressed);
        this.emit('touchButton', name, pressed);
      };
      element.addEventListener('pointerdown', (e) => {
        element.setPointerCapture?.(e.pointerId);
        set(true)(e);
      });
      element.addEventListener('pointerup', set(false));
      element.addEventListener('pointercancel', set(false));
      element.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    hold(this.touchBoost, 'boost');
    hold(this.touchHover, 'brake');
  }

  /** Adds a handler (every handler added for an event is called). Returns a function that removes it. */
  on<K extends HudEvent>(name: K, handler: HudHandler<K>): () => void {
    const handlers: Set<HudHandler<K>> = this.handlers[name];
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  private emit<K extends HudEvent>(name: K, ...args: HudEventMap[K]): void {
    const handlers: Set<HudHandler<K>> = this.handlers[name];
    for (const handler of [...handlers]) handler(...args);
  }

  private emitSettings(): void {
    this.emit('settings', this.readSettings());
  }

  readSettings(): HudSettings {
    return {
      sensitivity: Number(this.fields.sensitivity.value),
      invertY: this.fields.invertY.checked,
      firstPerson: this.fields.firstPerson.checked,
      sound: this.fields.sound.checked,
      showKeys: this.fields.showKeys.checked,
      destruction: this.fields.destruction.checked,
    };
  }

  applySettings(settings: HudSettings): void {
    this.fields.sensitivity.value = String(settings.sensitivity);
    this.fields.invertY.checked = settings.invertY;
    this.fields.firstPerson.checked = settings.firstPerson;
    this.fields.sound.checked = settings.sound;
    this.fields.showKeys.checked = settings.showKeys;
    this.fields.destruction.checked = settings.destruction;
    this.app.dataset.keys = settings.showKeys ? 'shown' : 'hidden';
  }

  setFade(active: boolean): void {
    this.fadeVeil.classList.toggle('is-active', active);
  }

  setLoading(text: string): void {
    this.loadingNote.textContent = text;
  }

  ready(): void {
    this.app.dataset.state = 'title';
    this.startButton.disabled = false;
    this.loadingNote.textContent = 'Headphones on.';
    this.startButton.focus({ preventScroll: true });
  }

  setDevice(device: InputDevice): void {
    this.app.dataset.device = device;
  }

  showFlight(): void {
    this.app.dataset.state = 'flying';
    this.pauseScreen.hidden = true;
  }

  showPause(): void {
    this.app.dataset.state = 'paused';
    this.pauseScreen.hidden = false;
    this.resumeButton.focus({ preventScroll: true });
  }

  showFatal(message: string): void {
    this.app.dataset.state = 'fatal';
    this.loadingNote.textContent = message;
    this.startButton.hidden = true;
  }

  toast(text: string, seconds = 3.2): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('is-visible');
    this.toastTimer = seconds;
  }

  showHint(key: string, text: string): void {
    if (this.hintKey === key) return;
    this.hintKey = key;
    this.hintEl.textContent = text;
    this.hintEl.classList.add('is-visible');
  }

  clearHint(key?: string): void {
    if (key && this.hintKey !== key) return;
    this.hintKey = null;
    this.hintEl.classList.remove('is-visible');
  }

  update(dt: number, { speed, altitude, input, device, flying }: HudFrame): void {
    this.readoutTimer -= dt;
    if (this.readoutTimer <= 0) {
      this.readoutTimer = 0.1;
      this.speedValue.textContent = String(Math.round(speed * 3.6));
      this.altitudeValue.textContent = String(Math.max(0, Math.round(altitude)));
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove('is-visible');
    }
    this.updateReticle(input, device, flying);
    this.updateTouch(input, device, flying);
  }

  private updateReticle(input: HudPointerInput, device: InputDevice, flying: boolean): void {
    const show = flying && device === 'mouse' && input.mouse.active;
    this.reticle.classList.toggle('is-visible', show);
    if (!show) return;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const dx = input.mouse.x - cx;
    const dy = input.mouse.y - cy;
    this.reticleDot.style.transform = `translate(${dx}px, ${dy}px)`;
    const length = Math.hypot(dx, dy);
    const deflection = Math.hypot(input.mouse.stickX, input.mouse.stickY);
    this.reticleLine.style.width = `${Math.max(0, length - 16)}px`;
    this.reticleLine.style.transform = `rotate(${Math.atan2(dy, dx)}rad) translateX(16px)`;
    this.reticleLine.style.opacity = String(clamp(deflection * 1.4, 0, 0.55));
    this.reticle.style.setProperty('--deflection', deflection.toFixed(3));
  }

  private updateTouch(input: HudPointerInput, device: InputDevice, flying: boolean): void {
    const show = flying && device === 'touch';
    this.touchControls.hidden = !show;
    const steer = input.touchSteer;
    const active = show && steer.id !== null;
    this.touchStick.classList.toggle('is-visible', active);
    if (!active) return;
    this.touchStick.style.transform = `translate(${steer.originX}px, ${steer.originY}px)`;
    const dx = steer.x - steer.originX;
    const dy = steer.y - steer.originY;
    const length = Math.hypot(dx, dy);
    const limit = 52;
    const scale = length > limit ? limit / length : 1;
    this.touchKnob.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
  }
}
