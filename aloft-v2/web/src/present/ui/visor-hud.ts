import type { Camera, Vector3 } from 'three';
import './visor-hud.css';

// First person only: speed and altitude at the edges of the visor, and a centre reticle whose
// arcs show the slam cooldown (left) and the grab (right). In both views: brackets on the piece a
// grab would take.

export interface VisorFrame {
  /** 0..1 how far into first person the view is. */
  visibility: number;
  speed: number;
  altitude: number;
  slamCooldown: number;
  holding: boolean;
  grabTarget: Vector3 | null;
  camera: Camera;
}

const ARC = 2 * Math.PI * 26 * 0.25;

export class VisorHud {
  private readonly root = document.createElement('div');
  private readonly speed: HTMLElement;
  private readonly altitude: HTMLElement;
  private readonly slamArc: SVGCircleElement;
  private readonly grabArc: SVGCircleElement;
  private readonly mark = document.createElement('div');

  constructor(host: HTMLElement) {
    this.root.className = 'visor';
    this.root.innerHTML = `
      <svg class="visor-reticle" viewBox="0 0 64 64" aria-hidden="true">
        <circle class="ring" cx="32" cy="32" r="26"/>
        <circle class="arc slam" cx="32" cy="32" r="26" stroke-dasharray="${ARC} 999" transform="rotate(135 32 32)"/>
        <circle class="arc grab" cx="32" cy="32" r="26" stroke-dasharray="${ARC} 999" transform="rotate(-45 32 32)"/>
        <circle class="dot" cx="32" cy="32" r="2"/>
      </svg>
      <div class="visor-edge visor-edge--left"><i></i><b data-speed>0</b><span>KM/H</span><i></i></div>
      <div class="visor-edge visor-edge--right"><i></i><b data-altitude>0</b><span>M UP</span><i></i></div>`;
    this.speed = this.root.querySelector('[data-speed]')!;
    this.altitude = this.root.querySelector('[data-altitude]')!;
    this.slamArc = this.root.querySelector('.arc.slam')!;
    this.grabArc = this.root.querySelector('.arc.grab')!;
    this.mark.className = 'grab-mark';
    host.append(this.root, this.mark);
  }

  update(frame: VisorFrame): void {
    this.root.style.opacity = String(frame.visibility);
    if (frame.visibility > 0.01) {
      this.speed.textContent = String(Math.round(frame.speed * 3.6));
      this.altitude.textContent = Number.isFinite(frame.altitude) ? String(Math.round(frame.altitude)) : '—';
      this.slamArc.setAttribute('stroke-dasharray', `${ARC * (1 - frame.slamCooldown)} 999`);
      this.grabArc.setAttribute('stroke-dasharray', `${frame.holding ? ARC : ARC * 0.25} 999`);
    }
    const target = frame.grabTarget;
    if (!target) {
      this.mark.dataset.on = 'false';
      return;
    }
    const p = target.clone().project(frame.camera);
    const visible = p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
    this.mark.dataset.on = String(visible);
    if (visible) {
      this.mark.style.left = `${(p.x * 0.5 + 0.5) * 100}%`;
      this.mark.style.top = `${(0.5 - p.y * 0.5) * 100}%`;
    }
  }
}
