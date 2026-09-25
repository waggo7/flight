// First-person comfort controls, added to the pause screen's settings form: how much the view
// rolls with the hero, a level-horizon lock, the widest FOV, and reduced motion.

export interface ComfortValues {
  rollShare: number;
  horizonLock: boolean;
  maxFov: number;
  reducedMotion: boolean;
}

export function mountComfortSettings(root: HTMLElement, initial: ComfortValues, onChange: (changes: Partial<ComfortValues>) => void): void {
  const form = root.querySelector('.settings');
  if (!form || form.querySelector('#setting-roll')) return;
  const html = `
    <label class="setting"><span>First-person roll</span><input id="setting-roll" type="range" min="0" max="1" step="0.05" /></label>
    <label class="setting setting--toggle"><span>Level horizon (first person)</span><input id="setting-horizon" type="checkbox" /></label>
    <label class="setting"><span>Widest view (FOV)</span><input id="setting-fov" type="range" min="60" max="110" step="1" /></label>
    <label class="setting setting--toggle"><span>Reduced motion</span><input id="setting-reduced-motion" type="checkbox" /></label>`;
  form.insertAdjacentHTML('beforeend', html);
  const roll = form.querySelector<HTMLInputElement>('#setting-roll')!;
  const horizon = form.querySelector<HTMLInputElement>('#setting-horizon')!;
  const fov = form.querySelector<HTMLInputElement>('#setting-fov')!;
  const reduced = form.querySelector<HTMLInputElement>('#setting-reduced-motion')!;
  roll.value = String(initial.rollShare);
  horizon.checked = initial.horizonLock;
  fov.value = String(initial.maxFov);
  reduced.checked = initial.reducedMotion;
  roll.addEventListener('input', () => onChange({ rollShare: Number(roll.value) }));
  horizon.addEventListener('change', () => onChange({ horizonLock: horizon.checked }));
  fov.addEventListener('input', () => onChange({ maxFov: Number(fov.value) }));
  reduced.addEventListener('change', () => onChange({ reducedMotion: reduced.checked }));
}
