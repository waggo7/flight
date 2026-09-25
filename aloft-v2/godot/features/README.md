# Godot features (at pivot time)

Mirror the web feature folders one to one. Each web `features/*-feature.ts` becomes a scene
(or an autoload for services) here:

| Web | Godot |
|---|---|
| `flight-feature.ts` + `core/flight-model.ts` | `features/flight/hero.tscn` driving `core/flight_model.gd` in `_physics_process` |
| `camera-feature.ts` | `features/camera/chase_camera.tscn` |
| `controls-feature.ts` | `InputActions` autoload + `Input.get_vector()` |
| `game-flow-feature.ts` | `features/game_flow/game_flow.gd` (state machine) |

Port order and the concept map are in `../../docs/godot-pivot.md`. Only `core/` is ported ahead
of time, proven by the conformance runner.
