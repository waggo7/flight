# Aloft — agent guide

Superhero flight game over a golden-hour archipelago city. Three.js + Vite, no backend.
Everything is procedural (no asset files); all sound is synthesised with Web Audio.

## Commands

- `npm install` — once
- `npm run dev` — dev server with hot reload
- `npm test` — flight-model and cape-cloth suites (`node:test`)
- `npm run build` — one self-contained `dist/index.html` (open or host anywhere)

## Layout

| File | Owns |
|---|---|
| `src/main.js` | Boot, game states (title → flying ⇄ paused), frame loop, event wiring |
| `src/flight-tuning.js` | Every number that shapes the feel: speeds, turn rates, camera, input curves |
| `src/flight-model.js` | Arcade physics: yaw is rate-controlled, pitch is attitude-controlled; hover / cruise / boost; bursting through buildings |
| `src/input-controls.js` | Mouse virtual stick, keyboard, touch, gamepad → `{ steerX, steerY, boost, brake }` |
| `src/chase-camera.js` | Chase, first-person and title-screen framing; wall avoidance; shake |
| `src/hero-figure.js` | Hero rig with fly ⇄ hover pose blending |
| `src/cape-cloth.js` | Position-based cape simulated in a hero-relative (translating) frame |
| `src/atmosphere.js` | Sun, palette, shared aerial-perspective GLSL, built-in material patcher |
| `src/sky-dome.js` · `ocean-surface.js` · `island-terrain.js` · `city-skyline.js` · `cloud-field.js` | The world |
| `src/city-skyline.js` (also) | Building registry (pieces, roles, colliders), cut/hide/restore, scorch decals, facade shader |
| `src/city-destruction.js` | Dent / shatter / topple decisions, toppling sections, `planSplit` (pure) |
| `src/debris-field.js` · `src/dust-plumes.js` · `src/particle-pool.js` | Rubble chunks, billowing dust, point-sprite pools |
| `src/spark-trails.js` | Collectible spark trails |
| `src/speed-effects.js` | Air streaks, shockwave, spray, bursts |
| `src/post-pipeline.js` | Bloom + composite (speed blur, cloud white-out, ACES, sRGB, dither) |
| `src/flight-audio.js` | Synthesised wind, pad and one-shots |
| `src/hud-overlay.js` · `src/styles.css` | DOM UI: title, pause, HUD, hints, touch controls |

## Conventions

- Name files and variables by what they do — never `utils`, `helpers`, `misc`.
- Tune feel in `flight-tuning.js`, not inline. Keep controls forgiving: dead zones, response curves, smoothing.
- Author colours as sRGB hex; three.js converts to linear. The scene renders HDR into a half-float
  target and is tone-mapped only in `post-pipeline.js` — never enable renderer tone mapping.
- Custom shaders include `ATMOSPHERE_GLSL`. Patched built-in materials go through `applyAtmosphere`
  with a unique `key` so three.js compiles separate programs.
- Per-instance values fed to hash functions must be `flat` varyings (interpolation jitter causes speckle).
- Destruction is non-destructive to data: the city keeps pristine instance matrices and collider heights,
  and `restore()` (Restart) puts everything back. Anything that damages the city must be undoable there.
- Effects near the camera must fade or cut away (dust, particles, debris, falling sections) so a hit
  never fills the screen.

## Verifying changes

- `npm test` must pass.
- Visual changes: build, serve `dist/`, open `index.html?test`. Test mode stops the render loop and
  exposes `window.__aloft` (`start()`, `setControls({...})`, `advance(frames)`, `flight`, `chase`, …)
  for deterministic headless screenshots. Check desktop and a phone viewport.
