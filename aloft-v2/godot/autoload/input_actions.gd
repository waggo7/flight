extends Node
## Registers the shared input actions (content/input/actions.json) in Godot's InputMap, so both
## engines bind the same keys and gamepad buttons.

# Web KeyboardEvent.code → Godot physical keycode.
const KEY_CODES := {
	"KeyA": KEY_A, "KeyC": KEY_C, "KeyD": KEY_D, "KeyE": KEY_E, "KeyF": KEY_F, "KeyH": KEY_H, "KeyM": KEY_M,
	"KeyP": KEY_P, "KeyQ": KEY_Q, "KeyR": KEY_R, "KeyS": KEY_S, "KeyV": KEY_V, "KeyW": KEY_W,
	"ArrowLeft": KEY_LEFT, "ArrowRight": KEY_RIGHT, "ArrowUp": KEY_UP, "ArrowDown": KEY_DOWN,
	"Space": KEY_SPACE, "ShiftLeft": KEY_SHIFT, "ShiftRight": KEY_SHIFT, "Escape": KEY_ESCAPE,
	"Enter": KEY_ENTER, "F3": KEY_F3, "Backquote": KEY_QUOTELEFT,
}
# Web standard-gamepad button index → Godot joypad button (triggers are axes in Godot).
const PAD_BUTTONS := {
	0: JOY_BUTTON_A, 1: JOY_BUTTON_B, 2: JOY_BUTTON_X, 3: JOY_BUTTON_Y, 4: JOY_BUTTON_LEFT_SHOULDER,
	5: JOY_BUTTON_RIGHT_SHOULDER, 8: JOY_BUTTON_BACK, 9: JOY_BUTTON_START, 12: JOY_BUTTON_DPAD_UP,
}
const PAD_TRIGGERS := {6: JOY_AXIS_TRIGGER_LEFT, 7: JOY_AXIS_TRIGGER_RIGHT}


func _ready() -> void:
	var actions: Dictionary = Content.input_actions
	for group in ["axes", "holds", "presses"]:
		for action in actions.get(group, {}):
			_register(action, actions[group][action])


func _register(action: String, binding: Dictionary) -> void:
	var name := action.replace("-", "_")
	if not InputMap.has_action(name):
		InputMap.add_action(name)
	for code in binding.get("keys", []):
		if KEY_CODES.has(code):
			var key := InputEventKey.new()
			key.physical_keycode = KEY_CODES[code]
			InputMap.action_add_event(name, key)
	for index in binding.get("gamepadButtons", []):
		var i := int(index)
		if PAD_BUTTONS.has(i):
			var button := InputEventJoypadButton.new()
			button.button_index = PAD_BUTTONS[i]
			InputMap.action_add_event(name, button)
		elif PAD_TRIGGERS.has(i):
			var trigger := InputEventJoypadMotion.new()
			trigger.axis = PAD_TRIGGERS[i]
			trigger.axis_value = 1.0
			InputMap.action_add_event(name, trigger)
