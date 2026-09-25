import './hero-picker.css';

// The hero select on the title screen: ‹ name · tagline › above "Take flight", with a dot per
// hero. Arrow buttons (or ←/→, wired by the hero-select feature) step through the presets.
// Kept out of hud-markup.ts, which must stay v1's markup exactly.

export interface HeroPickerEntry {
  readonly name: string;
  readonly tagline: string;
  /** Suit, trim and accent colours for the swatch. */
  readonly swatch: readonly string[];
}

const ARROW = (direction: 'left' | 'right'): string =>
  `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${direction === 'left' ? 'M10 3 5 8l5 5' : 'M6 3l5 5-5 5'}" /></svg>`;

export class HeroPicker {
  readonly element: HTMLElement;
  private readonly name: HTMLElement;
  private readonly tagline: HTMLElement;
  private readonly swatch: HTMLElement;
  private readonly dots: HTMLElement;
  private readonly handlers = new Set<(step: number) => void>();

  /** Mounts into the title screen's action block, above the start button. */
  constructor(titleScreen: HTMLElement, private readonly count: number) {
    const host = titleScreen.querySelector('.title-action') ?? titleScreen;
    const element = document.createElement('div');
    element.className = 'hero-picker';
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', 'Choose your hero');
    element.innerHTML = /* html */ `
      <button class="hero-picker-arrow" type="button" data-step="-1" aria-label="Previous hero">${ARROW('left')}</button>
      <div class="hero-picker-card" aria-live="polite">
        <p class="hero-picker-name"><span class="hero-picker-swatch" aria-hidden="true"></span><span class="hero-picker-label"></span></p>
        <p class="hero-picker-tagline"></p>
        <div class="hero-picker-dots" aria-hidden="true"></div>
      </div>
      <button class="hero-picker-arrow" type="button" data-step="1" aria-label="Next hero">${ARROW('right')}</button>`;
    host.prepend(element);
    this.element = element;
    this.name = element.querySelector('.hero-picker-label')!;
    this.tagline = element.querySelector('.hero-picker-tagline')!;
    this.swatch = element.querySelector('.hero-picker-swatch')!;
    this.dots = element.querySelector('.hero-picker-dots')!;
    this.dots.innerHTML = '<span></span>'.repeat(count);
    for (const button of element.querySelectorAll<HTMLButtonElement>('.hero-picker-arrow')) {
      button.addEventListener('click', () => {
        const step = Number(button.dataset.step);
        for (const handler of this.handlers) handler(step);
      });
    }
  }

  /** Called with -1 / +1 when an arrow is pressed. */
  onStep(handler: (step: number) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  show(index: number, entry: HeroPickerEntry): void {
    this.name.textContent = entry.name;
    this.tagline.textContent = entry.tagline;
    this.swatch.innerHTML = entry.swatch.map((colour) => `<i style="background:${colour}"></i>`).join('');
    this.dots.querySelectorAll('span').forEach((dot, i) => dot.classList.toggle('is-current', i === index));
    this.element.dataset.count = String(this.count);
  }
}
