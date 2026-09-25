extends Node
## Loads the engine-neutral content (aloft-v2/content/*.json, synced into res://shared/content by
## `npm run godot:sync`). The web game reads the very same files.

const ROOT := "res://shared/content/"

var tuning := {}
var input_actions := {}


func _ready() -> void:
	for name in ["flight", "camera", "input", "simulation", "destruction", "powers", "combat"]:
		tuning[name] = _read(ROOT + "tuning/%s.json" % name)
	input_actions = _read(ROOT + "input/actions.json")


func _read(path: String) -> Dictionary:
	if not FileAccess.file_exists(path):
		push_warning("Aloft content missing: %s (run `npm run godot:sync` in aloft-v2/web)" % path)
		return {}
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(path))
	return parsed if parsed is Dictionary else {}
