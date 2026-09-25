extends Node
## Signal bus mirroring the web game's typed events (web/src/engine/event-bus.ts GameEventMap).
## Web `ctx.events.emit('flight:event', e)` ↔ Godot `Events.flight_event.emit(e)`.

signal flight_event(event: Dictionary)
signal game_state(state: String)
signal game_restart()
