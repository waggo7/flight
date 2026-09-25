# Godot 4.7 pivot — always ready

The web build is the reference. This document is how the project stays one decision away from
Godot 4.7 (Jolt physics, editor, scenes) without a rewrite from scratch.

## What keeps it ready

1. **Portable core.** `web/src/core/` is pure TypeScript (three.js math only through `core/math.ts`),
   with no DOM, Rapier or rendering. ESLint and the no-DOM `tsconfig.core.json` enforce this.
2. **Shared content.** Tuning, bindings (and from later milestones materials, heroes, scenarios) are
   JSON in `content/`. Godot's `Content` autoload reads the same files (`npm run godot:sync` copies
   them to `godot/shared/`).
3. **Conformance vectors.** `conformance/*.json` records scripted inputs and expected outputs from
   the TypeScript core. The web tests assert them, so they never drift. `godot/tests/conformance_runner.gd`
   replays them against the GDScript ports.
4. **Continuous proof.** `npm run godot:check` downloads Godot 4.7.2 once (to `~/.cache/aloft`), syncs
   the JSON and runs the runner headless. CI runs it on every push.

## Ported so far

| Module | Web | Godot | Vectors |
|---|---|---|---|
| Flight model | `web/src/core/flight-model.ts` | `godot/core/flight_model.gd` | `conformance/flight-model.json` (12 cases, 3,040 checks) |

GDScript ports keep simulation math in 64-bit `float` scalars (Godot's `Vector3` is 32-bit in standard
builds), so they match the reference to 1e-6.

## Concept map

| Web | Godot 4.7 |
|---|---|
| Feature module (`features/*-feature.ts`, `install(ctx)`) | Scene (`.tscn`) or autoload for shared services |
| `ServiceRegistry` token | Autoload singleton or exported node reference |
| `EventBus` + `GameEventMap` | Signals on the `Events` autoload |
| Fixed-step loop, `StepPhase` | `_physics_process` at 60 ticks; process priority for phase order |
| Frame phases + interpolation `alpha` | `_process` + physics interpolation |
| `content/*.json` | Same JSON via `Content`; later `.tres` resources if preferred |
| Rapier bodies, compound colliders | `RigidBody3D` / `StaticBody3D` with several `CollisionShape3D` children (Jolt) |
| Rapier contact-force events | Jolt contact monitoring; `_integrate_forces` + `PhysicsDirectBodyState3D` |
| Kinematic shape sweeps | `PhysicsDirectSpaceState3D.cast_motion` / `intersect_shape` |
| `InstancedMesh` | `MultiMeshInstance3D` |
| GLSL `ShaderMaterial` / patched built-ins | Godot shading language `ShaderMaterial` |
| Web Audio procedural recipes | Pre-rendered WAVs from the offline render pipeline, played by `AudioStreamPlayer3D` |
| `?test` API + Playwright | `--headless` scripts + GUT (or the conformance runner pattern) |

## Pivot checklist (when the day comes)

1. Port the remaining `core/` modules one by one; each is done when its vectors pass in Godot.
2. Rebuild features as scenes in the order of `app/feature-list.ts`.
3. Swap Rapier glue (`sim/`) for Jolt nodes; keep the destruction rules from `core/` unchanged.
4. Render collapse audio recipes to WAVs (`npm run audio:render`, from M5) and play them spatially.
5. Recreate materials in Godot's shading language using the same parameters.
