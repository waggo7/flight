import type { FlightControls } from '../../core/flight-model';
import type { InputBindings, InputTuning, PressAction } from '../../core/flight-tuning';
import { approach, clamp } from '../../core/scalar-math';

// Folds mouse, keyboard, touch and gamepad into one calm virtual stick plus two buttons:
//   state = { steerX, steerY, boost, brake }  (steer axes in [-1, 1], right/up positive)
// The mouse acts as a stick whose centre is the middle of the screen: a dead zone in the
// middle, a soft response curve, and a short fade-in after starting or resuming.
// Ported from v1 (src/input-controls.js). Bindings come from content/input/actions.json, the
// same file the Godot scaffold registers in its InputMap.

export type InputAction = PressAction;
export type InputDevice = 'mouse' | 'keyboard' | 'touch' | 'gamepad';

export function shapeStick(x: number, y: number, deadZone: number, curve: number): { x: number; y: number; magnitude: number } {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= deadZone) return { x: 0, y: 0, magnitude: 0 };
  const scaled = Math.min(1, (magnitude - deadZone) / (1 - deadZone));
  const shaped = Math.pow(scaled, curve);
  return { x: (x / magnitude) * shaped, y: (y / magnitude) * shaped, magnitude: shaped };
}

export class InputControls {
  readonly state: FlightControls = { steerX: 0, steerY: 0, boost: false, brake: false };
  enabled = false;
  invertY = false;
  sensitivity = 1;
  device: InputDevice;

  /** Free look: while active the head turns (x right, y up, −1..1) and the course holds. */
  readonly look = { active: false, x: 0, y: 0 };
  /** Read by the HUD for the reticle. */
  readonly mouse = { x: 0, y: 0, inside: false, active: false, left: false, right: false, stickX: 0, stickY: 0 };
  private readonly keys = new Set<string>();
  private readonly keyStick = { x: 0, y: 0 };
  /** Read by the HUD for the thumb stick. */
  readonly touchSteer = { id: null as number | null, originX: 0, originY: 0, x: 0, y: 0, stickX: 0, stickY: 0 };
  private readonly touchBoostPointers = new Set<number>();
  /** A second finger that started dragging instead of holding still turns into a look stick. */
  private readonly touchStarts = new Map<number, { x: number; y: number }>();
  private readonly touchLook = { id: null as number | null, originX: 0, originY: 0, x: 0, y: 0 };
  private readonly lookKeys: ReadonlySet<string>;
  private readonly touchButtons = { boost: false, brake: false };
  private readonly pad = { connected: false, stickX: 0, stickY: 0, lookX: 0, lookY: 0, boost: false, brake: false, previous: [] as boolean[] };
  private authority = 0;
  private readonly handlers = new Map<InputAction, (() => void)[]>();
  private readonly steerKeys = new Map<string, readonly [number, number]>();
  private readonly boostKeys: ReadonlySet<string>;
  private readonly brakeKeys: ReadonlySet<string>;
  private readonly pressKeys = new Map<string, InputAction[]>();
  private readonly pressButtons = new Map<number, InputAction[]>();

  constructor(
    private readonly surface: HTMLElement,
    private readonly tuning: InputTuning,
    private readonly bindings: InputBindings,
  ) {
    this.device = matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse';
    const axes: Record<keyof InputBindings['axes'], readonly [number, number]> = {
      'steer-left': [-1, 0],
      'steer-right': [1, 0],
      'steer-up': [0, 1],
      'steer-down': [0, -1],
    };
    for (const [name, axis] of Object.entries(axes) as [keyof InputBindings['axes'], readonly [number, number]][]) {
      for (const code of bindings.axes[name].keys) this.steerKeys.set(code, axis);
    }
    this.boostKeys = new Set(bindings.holds.boost.keys);
    this.brakeKeys = new Set(bindings.holds.brake.keys);
    this.lookKeys = new Set(bindings.holds.look.keys);
    for (const [action, binding] of Object.entries(bindings.presses) as [InputAction, InputBindings['presses'][InputAction]][]) {
      for (const code of binding.keys) this.pressKeys.set(code, [...(this.pressKeys.get(code) ?? []), action]);
      for (const index of binding.gamepadButtons ?? []) this.pressButtons.set(index, [...(this.pressButtons.get(index) ?? []), action]);
    }
    this.bind();
  }

  on(action: InputAction, handler: () => void): void {
    const list = this.handlers.get(action) ?? [];
    list.push(handler);
    this.handlers.set(action, list);
  }

  private emit(action: InputAction): void {
    for (const handler of this.handlers.get(action) ?? []) handler();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.authority = 0;
    this.releaseAll();
  }

  setTouchButton(name: 'boost' | 'brake', pressed: boolean): void {
    this.touchButtons[name] = pressed;
    this.device = 'touch';
  }

  private releaseAll(): void {
    this.mouse.left = false;
    this.mouse.right = false;
    this.keys.clear();
    this.touchSteer.id = null;
    this.touchLook.id = null;
    this.touchStarts.clear();
    this.touchBoostPointers.clear();
    this.touchButtons.boost = false;
    this.touchButtons.brake = false;
  }

  private bind(): void {
    const surface = this.surface;
    surface.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    surface.addEventListener('pointermove', (e) => this.onPointerMove(e));
    surface.addEventListener('pointerup', (e) => this.onPointerUp(e));
    surface.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    surface.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') this.mouse.inside = false;
    });
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.releaseAll());
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse') {
      this.trackMouse(e);
      if (this.enabled) capturePointer(this.surface, e);
      return;
    }
    this.device = 'touch';
    if (!this.enabled) return;
    capturePointer(this.surface, e);
    if (e.clientX < window.innerWidth * 0.5 && this.touchSteer.id === null) {
      const steer = this.touchSteer;
      steer.id = e.pointerId;
      steer.originX = steer.x = e.clientX;
      steer.originY = steer.y = e.clientY;
    } else {
      this.touchBoostPointers.add(e.pointerId);
      this.touchStarts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerType === 'mouse') {
      this.trackMouse(e);
      return;
    }
    if (e.pointerId === this.touchSteer.id) {
      this.touchSteer.x = e.clientX;
      this.touchSteer.y = e.clientY;
      return;
    }
    const start = this.touchStarts.get(e.pointerId);
    if (start && this.touchLook.id === null && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 24) {
      // A dragging second finger looks around rather than boosting.
      this.touchBoostPointers.delete(e.pointerId);
      Object.assign(this.touchLook, { id: e.pointerId, originX: start.x, originY: start.y });
    }
    if (e.pointerId === this.touchLook.id) {
      this.touchLook.x = e.clientX;
      this.touchLook.y = e.clientY;
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerType === 'mouse') {
      this.mouse.left = (e.buttons & 1) !== 0;
      this.mouse.right = (e.buttons & 2) !== 0;
      return;
    }
    if (e.pointerId === this.touchSteer.id) this.touchSteer.id = null;
    if (e.pointerId === this.touchLook.id) this.touchLook.id = null;
    this.touchBoostPointers.delete(e.pointerId);
    this.touchStarts.delete(e.pointerId);
  }

  private trackMouse(e: PointerEvent): void {
    const moved = Math.abs(e.clientX - this.mouse.x) + Math.abs(e.clientY - this.mouse.y) > 0.5;
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    this.mouse.inside = true;
    this.mouse.left = (e.buttons & 1) !== 0;
    this.mouse.right = (e.buttons & 2) !== 0;
    if (moved || e.type === 'pointerdown') {
      this.mouse.active = true;
      this.device = 'mouse';
    }
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const code = e.code;
    const target = e.target;
    const inField = target instanceof HTMLInputElement && target.type !== 'checkbox' && target.type !== 'range';
    if (inField) return;

    const steer = this.steerKeys.has(code);
    if (steer || this.boostKeys.has(code) || this.brakeKeys.has(code) || this.lookKeys.has(code)) {
      if (this.enabled || !this.boostKeys.has(code)) e.preventDefault();
      if (down) {
        this.keys.add(code);
        if (steer) {
          this.mouse.active = false; // a resting cursor must not fight the keys
          this.device = 'keyboard';
        }
      } else {
        this.keys.delete(code);
      }
    }
    if (!down || e.repeat) return;
    for (const action of this.pressKeys.get(code) ?? []) {
      if (action === 'confirm') {
        // Confirm only starts the game; it never fires while flying or when a button has focus.
        if (!this.enabled && !(target instanceof HTMLButtonElement)) this.emit('confirm');
        continue;
      }
      if (action === 'toggle-dev') e.preventDefault();
      this.emit(action);
    }
  }

  private pollGamepad(): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    for (const candidate of pads) {
      if (candidate && candidate.connected) {
        pad = candidate;
        break;
      }
    }
    const state = this.pad;
    state.connected = !!pad;
    if (!pad) {
      state.stickX = state.stickY = state.lookX = state.lookY = 0;
      state.boost = state.brake = false;
      return;
    }
    const stick = shapeStick(pad.axes[0] ?? 0, -(pad.axes[1] ?? 0), this.tuning.gamepadDeadZone, 1.35);
    const pressed = (i: number): boolean => {
      const button = pad.buttons[i];
      return !!button && (button.pressed || button.value > 0.35);
    };
    state.stickX = stick.x;
    state.stickY = stick.y;
    const look = shapeStick(pad.axes[2] ?? 0, -(pad.axes[3] ?? 0), this.tuning.gamepadDeadZone, 1.2);
    state.lookX = look.x;
    state.lookY = look.y;
    state.boost = (this.bindings.holds.boost.gamepadButtons ?? []).some(pressed);
    state.brake = (this.bindings.holds.brake.gamepadButtons ?? []).some(pressed);

    const edge = (i: number): boolean => pressed(i) && !state.previous[i];
    for (const [index, actions] of this.pressButtons) {
      if (!edge(index)) continue;
      for (const action of actions) if (action !== 'confirm' || !this.enabled) this.emit(action);
    }
    for (let i = 0; i < pad.buttons.length; i++) state.previous[i] = pressed(i);
    if (stick.magnitude > 0.05 || state.boost || state.brake) this.device = 'gamepad';
  }

  private rampToward(current: number, target: number, dt: number): number {
    const rising = Math.abs(target) > Math.abs(current) || Math.sign(target) !== Math.sign(current);
    return approach(current, target, (rising ? this.tuning.keyRise : this.tuning.keyFall) * dt);
  }

  update(dt: number): void {
    this.pollGamepad();
    const width = window.innerWidth;
    const height = window.innerHeight;

    let keyX = 0;
    let keyY = 0;
    for (const code of this.keys) {
      const axis = this.steerKeys.get(code);
      if (axis) {
        keyX += axis[0];
        keyY += axis[1];
      }
    }
    this.keyStick.x = this.rampToward(this.keyStick.x, clamp(keyX, -1, 1), dt);
    this.keyStick.y = this.rampToward(this.keyStick.y, clamp(keyY, -1, 1), dt);

    const mouse = this.mouse;
    mouse.stickX = mouse.stickY = 0;
    if (mouse.inside && mouse.active) {
      const radius = (Math.min(width, height) * this.tuning.mouseRadius) / this.sensitivity;
      const stick = shapeStick((mouse.x - width / 2) / radius, (height / 2 - mouse.y) / radius, this.tuning.deadZone, this.tuning.curve);
      mouse.stickX = stick.x;
      mouse.stickY = stick.y;
    }

    const steer = this.touchSteer;
    steer.stickX = steer.stickY = 0;
    if (steer.id !== null) {
      const radius = this.tuning.touchRadius / this.sensitivity;
      const stick = shapeStick((steer.x - steer.originX) / radius, (steer.originY - steer.y) / radius, 0.12, 1.3);
      steer.stickX = stick.x;
      steer.stickY = stick.y;
    }

    // Free look: the look key hands the mouse to the head; the right stick and a dragging second
    // finger look on their own.
    const lookKey = this.enabled && [...this.lookKeys].some((code) => this.keys.has(code));
    const lookTouch = this.touchLook;
    let lookX = this.pad.lookX;
    let lookY = this.pad.lookY;
    if (lookKey) {
      lookX += mouse.inside && mouse.active ? mouse.stickX : 0;
      lookY += mouse.inside && mouse.active ? mouse.stickY : 0;
    }
    if (lookTouch.id !== null) {
      const radius = this.tuning.touchRadius * 1.6;
      lookX += (lookTouch.x - lookTouch.originX) / radius;
      lookY += (lookTouch.originY - lookTouch.y) / radius;
    }
    this.look.active = this.enabled && (lookKey || lookTouch.id !== null || Math.hypot(this.pad.lookX, this.pad.lookY) > 0.05);
    this.look.x = clamp(lookX, -1, 1);
    this.look.y = clamp(this.invertY ? -lookY : lookY, -1, 1);
    const mouseSteers = lookKey ? 0 : 1;

    let x = mouse.stickX * mouseSteers + this.keyStick.x + steer.stickX + this.pad.stickX;
    let y = mouse.stickY * mouseSteers + this.keyStick.y + steer.stickY + this.pad.stickY;
    const magnitude = Math.hypot(x, y);
    if (magnitude > 1) {
      x /= magnitude;
      y /= magnitude;
    }

    this.authority = this.tuning.authorityRamp > 0 ? Math.min(1, this.authority + dt / this.tuning.authorityRamp) : 1;
    const authority = this.enabled ? this.authority * this.authority * (3 - 2 * this.authority) : 0;
    this.state.steerX = x * authority;
    this.state.steerY = (this.invertY ? -y : y) * authority;

    const keyBoost = [...this.boostKeys].some((code) => this.keys.has(code));
    const keyBrake = [...this.brakeKeys].some((code) => this.keys.has(code));
    const mouseHeld = (buttons: readonly ('left' | 'right')[] | undefined): boolean =>
      (buttons ?? []).some((b) => (b === 'left' ? mouse.left : mouse.right));
    this.state.boost =
      this.enabled &&
      (mouseHeld(this.bindings.holds.boost.mouse) || keyBoost || this.touchBoostPointers.size > 0 || this.touchButtons.boost || this.pad.boost);
    this.state.brake = this.enabled && (mouseHeld(this.bindings.holds.brake.mouse) || keyBrake || this.touchButtons.brake || this.pad.brake);
  }
}

function capturePointer(surface: HTMLElement, e: PointerEvent): void {
  try {
    surface.setPointerCapture(e.pointerId);
  } catch {
    // Capture can fail for synthetic events; steering still works without it.
  }
}
