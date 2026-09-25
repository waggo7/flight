# Aloft v2

A superhero flight game over a golden-hour city, rebuilt so the best part (buildings coming down)
is real: structural failure rules decide what breaks, a rigid-body engine moves the pieces, and the
collapse is heard as it happens. Built to grow toward "any superhero, fighting in the sky".

**Status:** M0 (foundations) is done: the engine core, the flight model on the new architecture,
a grey-box island, headless tests, and a Godot 4.7 scaffold that replays the same flight vectors.
The full plan and build order are in [`docs/build-plan.md`](docs/build-plan.md).

## Run it

```bash
cd web
npm install
npm run dev          # http://localhost:5173
npm run check        # typecheck, lint, tests, build
npm run build        # dist/index.html — one self-contained file
```

## Controls (so far)

| | Mouse + keyboard | Gamepad |
|---|---|---|
| Steer | Move the mouse (screen centre is neutral) · WASD / arrows | Left stick |
| Boost | Hold click · Space | A · RB · RT |
| Slow & hover | Hold right-click · Shift | B · LB · LT |
| View | V (chase / first person) | Y |
| Restart / pause | R / Esc | Back / Start |
| Stats | F3 | — |

Bindings live in `content/input/actions.json`, shared with the Godot scaffold.

## How it's organised

- `content/` — tuning and bindings as JSON, read by both engines.
- `web/` — the game (TypeScript, Three.js, Vite). `src/core` is portable pure logic, `src/engine` the
  loop/events/services, `src/features` self-installing feature modules.
- `godot/` — Godot 4.7 pivot scaffold; `npm run godot:check` proves its ports match the web core.
- `conformance/` — golden vectors that both engines must reproduce.

v1 lives at the repository root and stays as the reference.
