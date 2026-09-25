import './powers-hud.css';

// The powers' bit of HUD: a cooldown ring each for Slam and Grab, a reticle while carrying (you
// throw where you look), Slam / Grab touch buttons, and their rows in the key legend.

export interface PowersHudState {
  slamCooldown: number;
  slamActive: boolean;
  holding: boolean;
  grabBusy: boolean;
}

const CIRCUMFERENCE = 2 * Math.PI * 20;

function chip(label: string, key: string): { root: HTMLElement; fill: SVGCircleElement } {
  const root = document.createElement('div');
  root.className = 'power-chip';
  root.innerHTML = `<svg viewBox="0 0 46 46" aria-hidden="true"><circle class="track" cx="23" cy="23" r="20"/><circle class="fill" cx="23" cy="23" r="20" stroke-dasharray="${CIRCUMFERENCE}" stroke-dashoffset="0"/></svg><span>${key}</span><small>${label}</small>`;
  return { root, fill: root.querySelector('.fill')! };
}

function legendRow(title: string, keys: string[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'key-row';
  row.innerHTML = `<dt>${title}</dt><dd>${keys.map((k) => `<kbd>${k}</kbd>`).join('')}</dd>`;
  return row;
}

export class PowersHud {
  private readonly slam = chip('SLAM', 'Q');
  private readonly grab = chip('GRAB', 'E');
  private readonly reticle = document.createElement('div');

  constructor(root: HTMLElement, onTouch: (power: 'slam' | 'grab') => void) {
    const bar = document.createElement('div');
    bar.className = 'powers-hud';
    bar.append(this.slam.root, this.grab.root);
    this.reticle.className = 'carry-reticle';
    root.append(bar, this.reticle);

    const touch = root.querySelector('#touch-controls');
    for (const power of ['slam', 'grab'] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `touch-button touch-button--${power}`;
      button.textContent = power === 'slam' ? 'Slam' : 'Grab';
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        onTouch(power);
      });
      touch?.append(button);
    }

    const pointer = root.querySelector('.key-list[data-for="pointer"]');
    const pad = root.querySelector('.key-list[data-for="gamepad"]');
    const beforeView = (list: Element | null): Element | null => [...(list?.children ?? [])].find((row) => row.querySelector('dt')?.textContent === 'View') ?? null;
    pointer?.insertBefore(legendRow('Slam', ['Q']), beforeView(pointer));
    pointer?.insertBefore(legendRow('Grab · throw', ['E']), beforeView(pointer));
    const padView = beforeView(pad);
    pad?.insertBefore(legendRow('Slam', ['Y']), padView);
    pad?.insertBefore(legendRow('Grab · throw', ['X']), padView);
    const padViewKey = padView?.querySelector('kbd');
    if (padViewKey) padViewKey.textContent = 'D-pad ↑';
  }

  update(state: PowersHudState): void {
    this.slam.fill.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE * state.slamCooldown));
    this.slam.root.dataset.ready = String(state.slamCooldown <= 0);
    this.slam.root.dataset.active = String(state.slamActive);
    this.grab.fill.setAttribute('stroke-dashoffset', state.grabBusy ? String(CIRCUMFERENCE * 0.5) : '0');
    this.grab.root.dataset.ready = String(!state.grabBusy);
    this.grab.root.dataset.active = String(state.holding);
    this.grab.root.querySelector('small')!.textContent = state.holding ? 'THROW' : 'GRAB';
    this.reticle.dataset.on = String(state.holding);
  }
}
