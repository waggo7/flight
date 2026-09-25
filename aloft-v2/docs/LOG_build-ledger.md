# Build ledger

Append-only. One entry per milestone.

## M0 — Foundations (2026-09-25)

- New self-contained `aloft-v2/` (v1 untouched): `content/`, `conformance/`, `docs/`, `godot/`, `web/`.
- Web tooling: TypeScript 6.0 strict (plus a no-DOM config for portable layers), Vite 8.3 single-file
  build, Vitest 5, ESLint 10 with layer boundaries, Playwright 1.63 on the preinstalled Chromium.
- Engine core: fixed-step loop (identical sim at 30/60/144 Hz; 0.12× slow motion steps every 8–9
  frames), system phases, typed queued event bus, named seeded random streams, service registry,
  content validation.
- Flight model ported to `core/` behind a sweep-ready world contract (`resolveSphere` gets the
  previous position); all 12 v1 flight tests pass, plus new ones.
- Content as JSON: flight, camera, input, simulation tuning and shared input bindings.
- Godot 4.7.2 scaffold: GDScript flight model, Content/Events/InputActions autoloads, headless
  conformance runner. 12 cases / 3,040 checks match the TypeScript core to 1e-6.
- Grey-box island world, placeholder hero, chase camera, title/pause/restart flow, dev overlay (F3),
  `?test` API; e2e checks with screenshots at desktop and phone sizes.
