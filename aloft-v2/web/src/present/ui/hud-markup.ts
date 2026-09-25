// v1's DOM layer, inserted from script so v2's index.html can stay minimal: the title and pause
// screens, the flight HUD, touch controls, key legend and fade veil. Ids, classes and text are
// v1's (repo-root index.html), because HudOverlay looks elements up by id and hud-styles.css
// keys off the classes and the data attributes on the `.app` container.

/** v1's index.html <body>, minus the #app wrapper, the canvas and the script tag. */
export const HUD_MARKUP = /* html */ `
<section id="title-screen" class="screen screen--title" aria-labelledby="wordmark">
  <div class="title-block">
    <p class="eyebrow">A superhero flight</p>
    <h1 id="wordmark" class="wordmark">Aloft</h1>
  </div>
  <div class="title-action">
    <button id="start-button" class="primary-button" type="button" disabled>Take flight</button>
  </div>
  <div class="title-footer">
    <dl class="legend">
      <div class="legend-row">
        <dt>Steer</dt>
        <dd><span data-for="pointer">Mouse <i>or</i> WASD</span><span data-for="touch">Drag left thumb</span></dd>
      </div>
      <div class="legend-row">
        <dt>Boost</dt>
        <dd><span data-for="pointer">Hold click <i>or</i> Space</span><span data-for="touch">Hold right side</span></dd>
      </div>
      <div class="legend-row">
        <dt>Hover</dt>
        <dd><span data-for="pointer">Right-click <i>or</i> Shift</span><span data-for="touch">Hover button</span></dd>
      </div>
    </dl>
    <p id="loading-note" class="loading-note" role="status">Raising the city…</p>
  </div>
</section>

<div id="hud" class="hud" aria-live="off">
  <div class="readout" aria-label="Speed and altitude">
    <p class="readout-primary"><span id="speed-value">0</span><span class="unit">km/h</span></p>
    <p class="readout-secondary"><span id="altitude-value">0</span><span class="unit">m up</span></p>
  </div>
  <button id="pause-button" class="pause-button" type="button" aria-label="Pause">
    <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1" /><rect x="9.5" y="2.5" width="3" height="11" rx="1" /></svg>
  </button>
  <p id="hint" class="hint" role="status"></p>
  <p id="toast" class="toast" role="status"></p>
  <div id="reticle" class="reticle" aria-hidden="true">
    <div class="reticle-ring"></div>
    <div id="reticle-line" class="reticle-line"></div>
    <div id="reticle-dot" class="reticle-dot"></div>
  </div>
</div>

<div id="touch-controls" class="touch-controls" hidden>
  <div id="touch-stick" class="touch-stick"><div id="touch-knob" class="touch-knob"></div></div>
  <button id="touch-hover" class="touch-button touch-button--hover" type="button">Hover</button>
  <button id="touch-boost" class="touch-button touch-button--boost" type="button">Boost</button>
</div>

<section id="pause-screen" class="screen screen--pause" aria-labelledby="pause-title" hidden>
  <h2 id="pause-title" class="pause-title">Paused</h2>
  <div class="pause-actions">
    <button id="resume-button" class="primary-button" type="button">Resume</button>
    <button id="restart-button" class="quiet-button" type="button">Restart <kbd>R</kbd></button>
  </div>
  <form class="settings" onsubmit="return false">
    <label class="setting">
      <span>Steering sensitivity</span>
      <input id="setting-sensitivity" type="range" min="0.6" max="1.6" step="0.05" value="1" />
    </label>
    <label class="setting setting--toggle">
      <span>Invert up / down</span>
      <input id="setting-invert" type="checkbox" />
    </label>
    <label class="setting setting--toggle">
      <span>First-person view <kbd>V</kbd></span>
      <input id="setting-first-person" type="checkbox" />
    </label>
    <label class="setting setting--toggle">
      <span>Sound <kbd>M</kbd></span>
      <input id="setting-sound" type="checkbox" checked />
    </label>
    <label class="setting setting--toggle">
      <span>Show controls on screen <kbd>H</kbd></span>
      <input id="setting-keys" type="checkbox" checked />
    </label>
    <label class="setting setting--toggle">
      <span>Buildings can break</span>
      <input id="setting-destruction" type="checkbox" checked />
    </label>
  </form>
</section>

<aside id="key-legend" class="key-legend" aria-label="Controls">
  <dl class="key-list" data-for="pointer">
    <div class="key-row"><dt>Steer</dt><dd><kbd>Mouse</kbd><kbd>WASD</kbd></dd></div>
    <div class="key-row"><dt>Boost</dt><dd><kbd>Click</kbd><kbd>Space</kbd></dd></div>
    <div class="key-row"><dt>Hover</dt><dd><kbd>Right-click</kbd><kbd>Shift</kbd></dd></div>
    <div class="key-row"><dt>View</dt><dd><kbd>V</kbd></dd></div>
    <div class="key-row"><dt>Look back</dt><dd><kbd>Shift</kbd><kbd>V</kbd></dd></div>
    <div class="key-row"><dt>Restart</dt><dd><kbd>R</kbd></dd></div>
    <div class="key-row"><dt>Pause</dt><dd><kbd>Esc</kbd></dd></div>
    <div class="key-row key-row--quiet"><dt>Hide keys</dt><dd><kbd>H</kbd></dd></div>
  </dl>
  <dl class="key-list" data-for="gamepad">
    <div class="key-row"><dt>Steer</dt><dd><kbd>Left stick</kbd></dd></div>
    <div class="key-row"><dt>Boost</dt><dd><kbd>A</kbd><kbd>RT</kbd></dd></div>
    <div class="key-row"><dt>Hover</dt><dd><kbd>B</kbd><kbd>LT</kbd></dd></div>
    <div class="key-row"><dt>View</dt><dd><kbd>D-pad ↑</kbd></dd></div>
    <div class="key-row"><dt>Look back</dt><dd><kbd>D-pad ↓</kbd></dd></div>
    <div class="key-row"><dt>Restart</dt><dd><kbd>Back</kbd></dd></div>
    <div class="key-row"><dt>Pause</dt><dd><kbd>Start</kbd></dd></div>
  </dl>
</aside>
<p id="key-reminder" class="key-reminder"><kbd>H</kbd> Show keys</p>

<div id="fade-veil" class="fade-veil" aria-hidden="true"></div>
`;

/**
 * Turns `root` into v1's `#app` container and fills it with the HUD. Pass the element that holds
 * the canvas (v2's `<div id="app">`: the scene feature prepends its canvas there, so the HUD,
 * appended after it, stacks on top). `root` gains class `app` and, unless already set,
 * `data-state="loading"` and `data-device="mouse"`, the attributes v1's stylesheet and
 * HudOverlay switch on. Mounting twice into the same root does nothing the second time.
 */
export function mountHudMarkup(root: HTMLElement): void {
  if (root.querySelector('#hud')) return;
  root.classList.add('app');
  root.dataset.state ??= 'loading';
  root.dataset.device ??= 'mouse';
  root.insertAdjacentHTML('beforeend', HUD_MARKUP);
}
