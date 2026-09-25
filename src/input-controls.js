import { INPUT } from './flight-tuning.js';
import { clamp, approach } from './scalar-math.js';

// Folds mouse, keyboard, touch and gamepad into one calm virtual stick plus two buttons:
//   state = { steerX, steerY, boost, brake }  (steer axes in [-1, 1], right/up positive)
// The mouse acts as a stick whose centre is the middle of the screen: a dead zone
// in the middle, a soft response curve, and a short fade-in after starting or resuming.

const STEER_KEYS = {
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
};
const BOOST_KEYS = new Set(['Space']);
const BRAKE_KEYS = new Set(['ShiftLeft', 'ShiftRight']);

export function shapeStick(x, y, deadZone, curve) {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= deadZone) return { x: 0, y: 0, magnitude: 0 };
  const scaled = Math.min(1, (magnitude - deadZone) / (1 - deadZone));
  const shaped = Math.pow(scaled, curve);
  return { x: (x / magnitude) * shaped, y: (y / magnitude) * shaped, magnitude: shaped };
}

function rampToward(current, target, dt) {
  const rising = Math.abs(target) > Math.abs(current) || Math.sign(target) !== Math.sign(current);
  return approach(current, target, (rising ? INPUT.keyRise : INPUT.keyFall) * dt);
}

export class InputControls {
  constructor(surface) {
    this.surface = surface;
    this.state = { steerX: 0, steerY: 0, boost: false, brake: false };
    this.enabled = false;
    this.invertY = false;
    this.sensitivity = 1;
    this.device = matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse';

    this.mouse = { x: 0, y: 0, inside: false, active: false, left: false, right: false, stickX: 0, stickY: 0 };
    this.keys = new Set();
    this.keyStick = { x: 0, y: 0 };
    this.touchSteer = { id: null, originX: 0, originY: 0, x: 0, y: 0, stickX: 0, stickY: 0 };
    this.touchBoostPointers = new Set();
    this.touchButtons = { boost: false, brake: false };
    this.pad = { connected: false, stickX: 0, stickY: 0, boost: false, brake: false, previous: [] };
    this.authority = 0;
    this.handlers = new Map();
    this.#bind();
  }

  on(action, handler) {
    if (!this.handlers.has(action)) this.handlers.set(action, []);
    this.handlers.get(action).push(handler);
  }

  #emit(action) {
    for (const handler of this.handlers.get(action) ?? []) handler();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.authority = 0;
    this.#releaseAll();
  }

  setTouchButton(name, pressed) {
    this.touchButtons[name] = pressed;
    this.device = 'touch';
  }

  #releaseAll() {
    this.mouse.left = false;
    this.mouse.right = false;
    this.keys.clear();
    this.touchSteer.id = null;
    this.touchBoostPointers.clear();
    this.touchButtons.boost = false;
    this.touchButtons.brake = false;
  }

  #bind() {
    const surface = this.surface;
    surface.addEventListener('pointerdown', (e) => this.#onPointerDown(e));
    surface.addEventListener('pointermove', (e) => this.#onPointerMove(e));
    surface.addEventListener('pointerup', (e) => this.#onPointerUp(e));
    surface.addEventListener('pointercancel', (e) => this.#onPointerUp(e));
    surface.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') this.mouse.inside = false;
    });
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.#onKey(e, true));
    window.addEventListener('keyup', (e) => this.#onKey(e, false));
    window.addEventListener('blur', () => this.#releaseAll());
  }

  #onPointerDown(e) {
    if (e.pointerType === 'mouse') {
      this.#trackMouse(e);
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
    }
  }

  #onPointerMove(e) {
    if (e.pointerType === 'mouse') {
      this.#trackMouse(e);
      return;
    }
    if (e.pointerId === this.touchSteer.id) {
      this.touchSteer.x = e.clientX;
      this.touchSteer.y = e.clientY;
    }
  }

  #onPointerUp(e) {
    if (e.pointerType === 'mouse') {
      this.mouse.left = (e.buttons & 1) !== 0;
      this.mouse.right = (e.buttons & 2) !== 0;
      return;
    }
    if (e.pointerId === this.touchSteer.id) this.touchSteer.id = null;
    this.touchBoostPointers.delete(e.pointerId);
  }

  #trackMouse(e) {
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

  #onKey(e, down) {
    const code = e.code;
    const inField = e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && e.target.type !== 'range';
    if (inField) return;

    if (STEER_KEYS[code] || BOOST_KEYS.has(code) || BRAKE_KEYS.has(code)) {
      if (this.enabled || !BOOST_KEYS.has(code)) e.preventDefault();
      if (down) {
        this.keys.add(code);
        if (STEER_KEYS[code]) {
          this.mouse.active = false; // a resting cursor must not fight the keys
          this.device = 'keyboard';
        }
      } else {
        this.keys.delete(code);
      }
    }
    if (!down || e.repeat) return;
    if (code === 'Escape' || code === 'KeyP') this.#emit('pause');
    else if (code === 'KeyV' || code === 'KeyC') this.#emit('toggle-view');
    else if (code === 'KeyM') this.#emit('toggle-sound');
    else if (code === 'KeyR') this.#emit('restart');
    else if (code === 'KeyH') this.#emit('toggle-keys');
    else if ((code === 'Enter' || code === 'Space') && !this.enabled) {
      if (!(e.target instanceof HTMLButtonElement)) this.#emit('confirm');
    }
  }

  #pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const candidate of pads) {
      if (candidate && candidate.connected) {
        pad = candidate;
        break;
      }
    }
    const state = this.pad;
    state.connected = !!pad;
    if (!pad) {
      state.stickX = state.stickY = 0;
      state.boost = state.brake = false;
      return;
    }
    const stick = shapeStick(pad.axes[0] || 0, -(pad.axes[1] || 0), INPUT.gamepadDeadZone, 1.35);
    const pressed = (i) => !!pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > 0.35);
    state.stickX = stick.x;
    state.stickY = stick.y;
    state.boost = pressed(0) || pressed(5) || pressed(7);
    state.brake = pressed(1) || pressed(4) || pressed(6);

    const edge = (i) => pressed(i) && !state.previous[i];
    if (edge(3)) this.#emit('toggle-view');
    if (edge(8)) this.#emit('restart');
    if (edge(9)) this.#emit('pause');
    if (edge(0) && !this.enabled) this.#emit('confirm');
    for (let i = 0; i < pad.buttons.length; i++) state.previous[i] = pressed(i);
    if (stick.magnitude > 0.05 || state.boost || state.brake) this.device = 'gamepad';
  }

  update(dt) {
    this.#pollGamepad();
    const width = window.innerWidth;
    const height = window.innerHeight;

    let keyX = 0;
    let keyY = 0;
    for (const code of this.keys) {
      const axis = STEER_KEYS[code];
      if (axis) {
        keyX += axis[0];
        keyY += axis[1];
      }
    }
    this.keyStick.x = rampToward(this.keyStick.x, clamp(keyX, -1, 1), dt);
    this.keyStick.y = rampToward(this.keyStick.y, clamp(keyY, -1, 1), dt);

    const mouse = this.mouse;
    mouse.stickX = mouse.stickY = 0;
    if (mouse.inside && mouse.active) {
      const radius = (Math.min(width, height) * INPUT.mouseRadius) / this.sensitivity;
      const stick = shapeStick((mouse.x - width / 2) / radius, (height / 2 - mouse.y) / radius, INPUT.deadZone, INPUT.curve);
      mouse.stickX = stick.x;
      mouse.stickY = stick.y;
    }

    const steer = this.touchSteer;
    steer.stickX = steer.stickY = 0;
    if (steer.id !== null) {
      const radius = INPUT.touchRadius / this.sensitivity;
      const stick = shapeStick((steer.x - steer.originX) / radius, (steer.originY - steer.y) / radius, 0.12, 1.3);
      steer.stickX = stick.x;
      steer.stickY = stick.y;
    }

    let x = mouse.stickX + this.keyStick.x + steer.stickX + this.pad.stickX;
    let y = mouse.stickY + this.keyStick.y + steer.stickY + this.pad.stickY;
    const magnitude = Math.hypot(x, y);
    if (magnitude > 1) {
      x /= magnitude;
      y /= magnitude;
    }

    this.authority = Math.min(1, this.authority + dt / INPUT.authorityRamp);
    const authority = this.enabled ? this.authority * this.authority * (3 - 2 * this.authority) : 0;
    this.state.steerX = x * authority;
    this.state.steerY = (this.invertY ? -y : y) * authority;

    const keyBoost = [...BOOST_KEYS].some((code) => this.keys.has(code));
    const keyBrake = [...BRAKE_KEYS].some((code) => this.keys.has(code));
    this.state.boost = this.enabled && (mouse.left || keyBoost || this.touchBoostPointers.size > 0 || this.touchButtons.boost || this.pad.boost);
    this.state.brake = this.enabled && (mouse.right || keyBrake || this.touchButtons.brake || this.pad.brake);
  }
}

function capturePointer(surface, e) {
  try {
    surface.setPointerCapture(e.pointerId);
  } catch {
    // Capture can fail for synthetic events; steering still works without it.
  }
}
