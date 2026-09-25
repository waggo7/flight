import * as THREE from 'three';
import { clamp } from './scalar-math.js';

// The DOM layer: title and pause screens, a quiet flight HUD, one-at-a-time hints,
// toasts, the mouse-stick reticle, touch controls and an edge marker for the next spark.

const $ = (id) => document.getElementById(id);

export class HudOverlay {
  constructor() {
    this.app = $('app');
    this.titleScreen = $('title-screen');
    this.pauseScreen = $('pause-screen');
    this.hud = $('hud');
    this.startButton = $('start-button');
    this.resumeButton = $('resume-button');
    this.restartButton = $('restart-button');
    this.fadeVeil = $('fade-veil');
    this.pauseButton = $('pause-button');
    this.loadingNote = $('loading-note');
    this.speedValue = $('speed-value');
    this.altitudeValue = $('altitude-value');
    this.sparksValue = $('sparks-value');
    this.sparksTotal = $('sparks-total');
    this.sparksBadge = $('sparks');
    this.hintEl = $('hint');
    this.toastEl = $('toast');
    this.reticle = $('reticle');
    this.reticleDot = $('reticle-dot');
    this.reticleLine = $('reticle-line');
    this.pointer = $('spark-pointer');
    this.touchControls = $('touch-controls');
    this.touchStick = $('touch-stick');
    this.touchKnob = $('touch-knob');
    this.touchBoost = $('touch-boost');
    this.touchHover = $('touch-hover');
    this.fields = {
      sensitivity: $('setting-sensitivity'),
      invertY: $('setting-invert'),
      firstPerson: $('setting-first-person'),
      sound: $('setting-sound'),
      showKeys: $('setting-keys'),
      destruction: $('setting-destruction'),
    };
    this.handlers = {};
    this.readoutTimer = 0;
    this.toastTimer = 0;
    this.hintKey = null;
    this._projected = new THREE.Vector3();
    this._toSpark = new THREE.Vector3();
    this._camForward = new THREE.Vector3();

    this.startButton.addEventListener('click', () => this.handlers.start?.());
    this.resumeButton.addEventListener('click', () => this.handlers.resume?.());
    this.restartButton.addEventListener('click', () => this.handlers.restart?.());
    this.pauseButton.addEventListener('click', () => this.handlers.pause?.());
    this.fields.sensitivity.addEventListener('input', () => this.#emitSettings());
    for (const key of ['invertY', 'firstPerson', 'sound', 'showKeys', 'destruction']) {
      this.fields[key].addEventListener('change', () => this.#emitSettings());
    }

    const hold = (element, name) => {
      const set = (pressed) => (event) => {
        event.preventDefault();
        element.classList.toggle('is-pressed', pressed);
        this.handlers.touchButton?.(name, pressed);
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

  on(name, handler) {
    this.handlers[name] = handler;
  }

  #emitSettings() {
    this.handlers.settings?.(this.readSettings());
  }

  readSettings() {
    return {
      sensitivity: Number(this.fields.sensitivity.value),
      invertY: this.fields.invertY.checked,
      firstPerson: this.fields.firstPerson.checked,
      sound: this.fields.sound.checked,
      showKeys: this.fields.showKeys.checked,
      destruction: this.fields.destruction.checked,
    };
  }

  applySettings(settings) {
    this.fields.sensitivity.value = String(settings.sensitivity);
    this.fields.invertY.checked = settings.invertY;
    this.fields.firstPerson.checked = settings.firstPerson;
    this.fields.sound.checked = settings.sound;
    this.fields.showKeys.checked = settings.showKeys;
    this.fields.destruction.checked = settings.destruction;
    this.app.dataset.keys = settings.showKeys ? 'shown' : 'hidden';
  }

  setFade(active) {
    this.fadeVeil.classList.toggle('is-active', active);
  }

  setLoading(text) {
    this.loadingNote.textContent = text;
  }

  ready() {
    this.app.dataset.state = 'title';
    this.startButton.disabled = false;
    this.loadingNote.textContent = 'Headphones on.';
    this.startButton.focus({ preventScroll: true });
  }

  setDevice(device) {
    this.app.dataset.device = device;
  }

  showFlight() {
    this.app.dataset.state = 'flying';
    this.pauseScreen.hidden = true;
  }

  showPause() {
    this.app.dataset.state = 'paused';
    this.pauseScreen.hidden = false;
    this.resumeButton.focus({ preventScroll: true });
  }

  showFatal(message) {
    this.app.dataset.state = 'fatal';
    this.loadingNote.textContent = message;
    this.startButton.hidden = true;
  }

  setSparks(count, total, pulse = false) {
    this.sparksValue.textContent = String(count);
    this.sparksTotal.textContent = String(total);
    if (pulse) {
      this.sparksBadge.classList.remove('is-pulsing');
      void this.sparksBadge.offsetWidth;
      this.sparksBadge.classList.add('is-pulsing');
    }
  }

  toast(text, seconds = 3.2) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('is-visible');
    this.toastTimer = seconds;
  }

  showHint(key, text) {
    if (this.hintKey === key) return;
    this.hintKey = key;
    this.hintEl.textContent = text;
    this.hintEl.classList.add('is-visible');
  }

  clearHint(key) {
    if (key && this.hintKey !== key) return;
    this.hintKey = null;
    this.hintEl.classList.remove('is-visible');
  }

  update(dt, { speed, altitude, input, device, flying, camera, nextSpark }) {
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
    this.#updateReticle(input, device, flying);
    this.#updateTouch(input, device, flying);
    this.#updatePointer(camera, nextSpark, flying);
  }

  #updateReticle(input, device, flying) {
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

  #updateTouch(input, device, flying) {
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

  #updatePointer(camera, target, flying) {
    if (!flying || !target) {
      this.pointer.classList.remove('is-visible');
      return;
    }
    const toSpark = this._toSpark.subVectors(target, camera.position);
    camera.getWorldDirection(this._camForward);
    const behind = toSpark.dot(this._camForward) < 0;
    const p = this._projected.copy(target).project(camera);
    let x = p.x;
    let y = p.y;
    const onScreen = !behind && Math.abs(x) < 0.92 && Math.abs(y) < 0.9;
    if (onScreen) {
      this.pointer.classList.remove('is-visible');
      return;
    }
    if (behind) {
      x = -x;
      y = -y;
      if (Math.abs(x) < 1e-3 && Math.abs(y) < 1e-3) y = -1;
    }
    const scale = 1 / Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.84, 1e-3);
    x *= scale;
    y *= scale;
    const px = ((x + 1) / 2) * window.innerWidth;
    const py = ((1 - y) / 2) * window.innerHeight;
    const angle = Math.atan2(-y, x);
    this.pointer.style.transform = `translate(${px}px, ${py}px) rotate(${angle}rad)`;
    this.pointer.classList.add('is-visible');
  }
}
