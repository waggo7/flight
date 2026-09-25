# Aloft v2 — agent guide

Superhero flight over a golden-hour city, rebuilt for real rigid-body building collapse,
physics-driven collapse sound, superhero powers and a Godot 4.7 pivot kept ready at all times.
TypeScript + Three.js r186 (WebGLRenderer) + Rapier 0.20 + Vite 8; ships as one HTML file.
v1 (the repo root) is the frozen reference. The design and build order live in
`docs/build-plan.md`; session state lives in `docs/now.md` and `docs/LOG_build-ledger.md`.

## Commands (run in `web/`)

- `npm install` — once
- `npm run dev` — dev server with hot reload
- `npm run check` — typecheck (full + no-DOM portable layers), lint, unit + sim tests, build, size gate
- `npm run e2e` — headless Chromium: boots the built game in `?test` mode, flies, asserts, screenshots
- `npm run conformance:write` — regenerate `conformance/*.json` (only when behaviour changes on purpose)
- `npm run godot:check` — Godot 4.7.2 headless replays the conformance vectors against `godot/core/`

## Layout

| Path | Owns |
|---|---|
| `content/` | Engine-neutral JSON (tuning, input bindings, later materials, heroes, scenarios). Source of truth for web **and** Godot |
| `conformance/` | Golden vectors: scripted inputs → expected outputs for every portable core module |
| `godot/` | Godot 4.7 scaffold: `core/` ports, `autoload/` (Content, Events, InputActions), headless conformance runner |
| `web/src/core/` | Portable pure logic (flight model, later structure graph, crush planner, support check, pose graph). The Godot port target |
| `web/src/engine/` | Fixed-step loop, system phases, typed event bus, seeded random streams, service registry, content validation |
| `web/src/sim/` | Headless simulation (world contracts, grey-box world; Rapier from M2). Runs in Node |
| `web/src/present/` | Browser-only: rendering, input devices, audio, UI |
| `web/src/features/` | Feature modules: each `install(ctx)` registers systems, services, events and UI |
| `web/src/app/` | Boot and `feature-list.ts`, the composition root |
| `web/tests/` | `unit/` (Vitest), `conformance/` (shared case definitions), `sim/` (Rapier in Node, from M2) |
| `web/scripts/` | Conformance writer, Godot sync/check, size gate, headless browser harness |

## Conventions

- Name files and variables by what they do — never `utils`, `helpers`, `misc`.
- **Layers:** `core/` imports only `core/` (three.js math only via `core/math.ts`); `engine/` adds nothing
  browser-side; `sim/` adds Rapier but no DOM. ESLint and `tsconfig.core.json` (no DOM types) enforce it.
- **Features install themselves.** A new feature is a new file plus one line in `app/feature-list.ts`.
  Share objects through `ServiceRegistry` tokens; talk through `EventBus` events (declare yours by
  augmenting `GameEventMap`). Never grow a central file.
- **Fixed step:** simulation runs in 1/60 s steps in named phases; rendering interpolates with `alpha`.
  Hit-stop and slow motion scale sim time only (`loop.timeScale`).
- **Randomness:** only `engine/random-streams` (named, seeded). `Math.random` is banned in core/engine/sim.
- **Tuning lives in `content/*.json`**, never inline. Keep controls forgiving: dead zones, curves, smoothing.
  Add a `$notes` entry for every new key and a range in `engine/content-library.ts`.
- **Godot readiness at all times:** every new `core/` module gets conformance vectors; ported modules
  must pass `npm run godot:check`. Content stays JSON so Godot reads the same files.
- Units: metres, kilograms, seconds, radians. Author colours as sRGB hex.
- From v1, still true: tone mapping only in the post pass (never renderer tone mapping); per-instance
  hash inputs are `flat` varyings; effects near the camera fade or cut away; anything that damages the
  world must be undone by Restart.

## Verifying changes

- `npm run check` must pass; for visual or behaviour changes also `npm run build && npm run e2e`, and
  look at `web/test-results/shots/` (desktop 1280×720 and phone 390×844).
- `?test` mode stops the render loop and exposes `window.__aloft` (`start()`, `setControls({...})`,
  `advance(frames)`, `snapshot`, `restart()`); `advance` draws only its last frame.
- Core behaviour changes: update vectors with `npm run conformance:write`, update the GDScript port,
  and keep `npm run godot:check` green.
