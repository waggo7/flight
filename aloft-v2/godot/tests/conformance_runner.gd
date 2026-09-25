extends SceneTree
## Headless conformance runner:
##   godot --headless --path aloft-v2/godot --script res://tests/conformance_runner.gd
## Replays conformance/*.json (synced into res://shared/ by `npm run godot:sync`) against the
## GDScript ports and exits 0 when every sample matches within tolerance.

const FlightModel := preload("res://core/flight_model.gd")
const BoxWorld := preload("res://tests/conformance_box_world.gd")

var failures := 0
var checks := 0


func _init() -> void:
	var started := Time.get_ticks_msec()
	_run_flight("res://shared/conformance/flight-model.json")
	var elapsed := Time.get_ticks_msec() - started
	if checks == 0:
		failures += 1
		printerr("CONFORMANCE FAIL: no checks ran (script errors above?)")
	elif failures == 0:
		print("CONFORMANCE PASS: %d checks in %d ms" % [checks, elapsed])
	else:
		printerr("CONFORMANCE FAIL: %d of %d checks failed" % [failures, checks])
	quit(0 if failures == 0 else 1)


func _load_json(path: String):
	if not FileAccess.file_exists(path):
		printerr("missing %s (run `npm run godot:sync` in aloft-v2/web)" % path)
		failures += 1
		return null
	return JSON.parse_string(FileAccess.get_file_as_string(path))


func _close(actual: float, expected: float, tolerance: Dictionary) -> bool:
	if is_inf(expected) or is_inf(actual):
		return actual == expected
	return absf(actual - expected) <= tolerance["absolute"] + tolerance["relative"] * absf(expected)


func _expect(condition: bool, message: String) -> void:
	checks += 1
	if not condition:
		failures += 1
		if failures <= 20:
			printerr("  ✗ " + message)


func _event_detail(event: Dictionary) -> String:
	if event["type"] == "smash":
		return event["kind"]
	if event["type"] == "impact":
		return "dented" if event.get("dented", false) else "glanced"
	return ""


func _run_flight(path: String) -> void:
	var data = _load_json(path)
	if data == null:
		return
	var tolerance: Dictionary = data["tolerance"]
	var dt: float = data["dt"]
	var every := int(data["sampleEvery"])
	for case in data["cases"]:
		var world = BoxWorld.new(case["tower"], case["smash"])
		var model = FlightModel.new(world, data["tuning"])
		if model == null:
			failures += 1
			printerr("could not create the flight model")
			return
		model.reset(case["start"]["position"], case["start"]["yaw"])
		if case["start"]["launch"]:
			model.launch()
		var events: Array = []
		var samples: Array = []
		var step := 0
		for event in model.take_events():
			events.append({"step": 0, "type": event["type"], "detail": _event_detail(event)})
		for segment in case["segments"]:
			for i in int(segment["steps"]):
				model.update(dt, segment["controls"])
				step += 1
				for event in model.take_events():
					events.append({"step": step, "type": event["type"], "detail": _event_detail(event)})
				if step % every == 0:
					samples.append({
						"step": step,
						"position": model.position.duplicate(),
						"velocity": model.velocity.duplicate(),
						"yaw": model.yaw, "pitch": model.pitch, "bank": model.bank, "yawRate": model.yaw_rate,
						"speed": model.speed, "mode": model.mode,
						"hoverBlend": model.hover_blend, "boostBlend": model.boost_blend,
						"surfaceRush": model.surface_rush, "groundClearance": model.ground_clearance,
						"overWater": model.over_water,
					})
		var name: String = case["name"]
		var expected_events: Array = case["events"]
		_expect(events.size() == expected_events.size(), "%s: %d events, expected %d" % [name, events.size(), expected_events.size()])
		for i in mini(events.size(), expected_events.size()):
			var e: Dictionary = expected_events[i]
			var got: Dictionary = events[i]
			_expect(int(e["step"]) == got["step"] and e["type"] == got["type"] and e.get("detail", "") == got["detail"],
				"%s: event %d is %s@%d, expected %s@%d" % [name, i, got["type"], got["step"], e["type"], int(e["step"])])
		var expected_samples: Array = case["samples"]
		_expect(samples.size() == expected_samples.size(), "%s: %d samples, expected %d" % [name, samples.size(), expected_samples.size()])
		for i in mini(samples.size(), expected_samples.size()):
			var want: Dictionary = expected_samples[i]
			var got: Dictionary = samples[i]
			for key in ["yaw", "pitch", "bank", "yawRate", "speed", "hoverBlend", "boostBlend", "surfaceRush", "groundClearance"]:
				_expect(_close(got[key], want[key], tolerance), "%s step %d: %s = %.9f, expected %.9f" % [name, got["step"], key, got[key], want[key]])
			for key in ["position", "velocity"]:
				for axis in 3:
					_expect(_close(got[key][axis], want[key][axis], tolerance), "%s step %d: %s[%d] = %.9f, expected %.9f" % [name, got["step"], key, axis, got[key][axis], want[key][axis]])
			_expect(got["mode"] == want["mode"], "%s step %d: mode %s, expected %s" % [name, got["step"], got["mode"], want["mode"]])
			_expect(got["overWater"] == want["overWater"], "%s step %d: overWater mismatch" % [name, got["step"]])
