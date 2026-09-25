extends RefCounted
## Arcade superhero flight: yaw is rate-controlled, pitch is attitude-controlled, speed has three
## calm levels (hover, cruise, boost) and gravity trades altitude for speed.
##
## GDScript twin of web/src/core/flight-model.ts. Both must reproduce
## conformance/flight-model.json. Vectors are 3-element Arrays of 64-bit floats (Godot's Vector3
## is 32-bit in standard builds, which would drift from the reference over hundreds of steps).
##
## World interface (duck-typed):
##   ground_height(x: float, z: float) -> float
##   resolve_sphere(position: Array, previous: Array, radius: float, out_normal: Array) -> Variant  # null = no hit
##   nearest_surface(position: Array, max_distance: float) -> float
##   has_smash() -> bool
##   smash(hit, point: Array, normal: Array, velocity: Array, impact: float) -> Variant  # Dictionary or null

const GRAVITY := 9.81

var world
var tuning: Dictionary

var position := [0.0, 0.0, 0.0]
var velocity := [0.0, 0.0, 0.0]
var acceleration := [0.0, 0.0, 0.0]
var forward := [0.0, 0.0, 1.0]
var up := [0.0, 1.0, 0.0]
var right := [-1.0, 0.0, 0.0]

var yaw := 0.0
var pitch := 0.0
var bank := 0.0
var yaw_rate := 0.0
var speed := 0.0
var mode := "hover"
var hover_blend := 1.0
var boost_blend := 0.0
var ground_clearance := INF
var over_water := false
var surface_rush := 0.0

var _events: Array = []
var _boom_armed := true
var _impact_cooldown := 0.0
var _edge_warned := false
var _previous_velocity := [0.0, 0.0, 0.0]
var _previous_position := [0.0, 0.0, 0.0]


func _init(world_ref, flight_tuning: Dictionary) -> void:
	world = world_ref
	tuning = flight_tuning


# --- scalar helpers (mirror web/src/core/scalar-math.ts) ---------------------------------

static func clampf64(value: float, lo: float, hi: float) -> float:
	return minf(hi, maxf(lo, value))


static func lerpf64(a: float, b: float, t: float) -> float:
	return a + (b - a) * t


static func smoothstep64(edge0: float, edge1: float, x: float) -> float:
	var t := clampf64((x - edge0) / (edge1 - edge0), 0.0, 1.0)
	return t * t * (3.0 - 2.0 * t)


static func damp(current: float, target: float, sharpness: float, dt: float) -> float:
	return target + (current - target) * exp(-sharpness * dt)


static func wrap_angle(angle: float) -> float:
	return atan2(sin(angle), cos(angle))


static func approach(current: float, target: float, max_delta: float) -> float:
	if current < target:
		return minf(current + max_delta, target)
	return maxf(current - max_delta, target)


static func length3(v: Array) -> float:
	return sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


static func finite_axis(value) -> float:
	if typeof(value) != TYPE_FLOAT and typeof(value) != TYPE_INT:
		return 0.0
	var f := float(value)
	if is_nan(f) or is_inf(f):
		return 0.0
	return clampf64(f, -1.0, 1.0)


static func sanitize_controls(input) -> Dictionary:
	if typeof(input) != TYPE_DICTIONARY:
		return {"steerX": 0.0, "steerY": 0.0, "boost": false, "brake": false}
	return {
		"steerX": finite_axis(input.get("steerX", 0.0)),
		"steerY": finite_axis(input.get("steerY", 0.0)),
		"boost": bool(input.get("boost", false)),
		"brake": bool(input.get("brake", false)),
	}


# --- lifecycle -----------------------------------------------------------------------------

func reset(start_position: Array, start_yaw: float = 0.0) -> void:
	position = [float(start_position[0]), float(start_position[1]), float(start_position[2])]
	velocity = [0.0, 0.0, 0.0]
	acceleration = [0.0, 0.0, 0.0]
	yaw = start_yaw
	pitch = 0.0
	bank = 0.0
	yaw_rate = 0.0
	speed = 0.0
	mode = "hover"
	hover_blend = 1.0
	boost_blend = 0.0
	surface_rush = 0.0
	_boom_armed = true
	_impact_cooldown = 0.0
	_edge_warned = false
	_events = []
	_update_basis()


func launch() -> void:
	if mode == "flying":
		return
	mode = "flying"
	speed = maxf(speed, tuning["launchSpeed"])
	_events.append({"type": "launch"})


func take_events() -> Array:
	var events := _events
	_events = []
	return events


func speed_share() -> float:
	return smoothstep64(tuning["cruiseSpeed"], tuning["boostSpeed"], speed)


func update(dt: float, raw_input) -> void:
	var input := sanitize_controls(raw_input)
	_previous_velocity = velocity.duplicate()
	_previous_position = position.duplicate()
	_impact_cooldown = maxf(0.0, _impact_cooldown - dt)

	if mode == "hover":
		_update_hover(dt, input)
	else:
		_update_flight(dt, input)

	_resolve_world(dt)
	_update_basis()

	if dt > 0.0:
		for i in 3:
			acceleration[i] = (velocity[i] - _previous_velocity[i]) / dt
		var magnitude := length3(acceleration)
		if magnitude > 240.0:
			for i in 3:
				acceleration[i] = acceleration[i] / magnitude * 240.0
	var boosting: bool = input["boost"] and not input["brake"] and mode == "flying"
	boost_blend = damp(boost_blend, 1.0 if boosting else 0.0, 3.0 if boosting else 1.5, dt)


func _ceiling_limit() -> float:
	return smoothstep64(tuning["maxAltitude"] - 200.0, tuning["maxAltitude"] + 150.0, position[1])


func _update_hover(dt: float, input: Dictionary) -> void:
	var F := tuning
	yaw_rate = damp(yaw_rate, -input["steerX"] * F["hoverYawRate"], 5.0, dt)
	yaw = wrap_angle(yaw + yaw_rate * dt)
	pitch = damp(pitch, 0.0, 3.0, dt)
	bank = damp(bank, clampf64(-yaw_rate * 0.25, -0.3, 0.3), 4.0, dt)

	var drift := exp(-2.2 * dt)
	velocity[0] *= drift
	velocity[2] *= drift
	var climb_scale := (1.0 - _ceiling_limit()) if input["steerY"] > 0.0 else 1.0
	var climb: float = input["steerY"] * F["hoverClimb"] * climb_scale
	velocity[1] = damp(velocity[1], climb, 3.0, dt)
	for i in 3:
		position[i] += velocity[i] * dt
	speed = length3(velocity)
	hover_blend = damp(hover_blend, 1.0, 3.2, dt)

	if input["boost"] and not input["brake"]:
		launch()


func _update_flight(dt: float, input: Dictionary) -> void:
	var F := tuning
	var max_yaw_rate := lerpf64(F["yawRateSlow"], F["yawRateFast"], speed_share())
	yaw_rate = damp(yaw_rate, -input["steerX"] * max_yaw_rate, F["yawResponse"], dt)
	yaw = wrap_angle(yaw + yaw_rate * dt)

	var ceiling_pitch := lerpf64(F["pitchMax"], -0.35, _ceiling_limit())
	var target_pitch: float = minf(input["steerY"] * F["pitchMax"], ceiling_pitch)
	pitch = damp(pitch, target_pitch, F["pitchResponse"], dt)

	var sin_pitch := sin(pitch)
	var braking: bool = input["brake"]
	var boosting: bool = input["boost"] and not braking
	var target: float = F["boostSpeed"] if boosting else F["cruiseSpeed"]
	target += F["diveBonus"] * maxf(0.0, -sin_pitch) * (1.0 if boosting else 0.75)
	target -= F["climbPenalty"] * maxf(0.0, sin_pitch)
	target = 0.0 if braking else maxf(target, F["minFlightSpeed"])

	var gaining := speed < target
	var rate: float
	if gaining:
		rate = F["boostAccel"] if boosting else F["cruiseAccel"]
	else:
		rate = F["brakeDecel"] if braking else F["coastDecel"]
	rate += GRAVITY * F["gravityShare"] * maxf(0.0, -sin_pitch if gaining else sin_pitch)
	speed = approach(speed, target, rate * dt)

	var cos_pitch := cos(pitch)
	velocity = [sin(yaw) * cos_pitch * speed, sin_pitch * speed, cos(yaw) * cos_pitch * speed]
	for i in 3:
		position[i] += velocity[i] * dt

	# Coordinated-turn bank: lean into the turn in proportion to lateral acceleration.
	var lateral := speed * -yaw_rate
	var target_bank := clampf64(atan2(lateral * F["bankGain"], GRAVITY), -F["bankMax"], F["bankMax"])
	bank = damp(bank, target_bank, F["bankResponse"], dt)

	var upright := (1.0 - smoothstep64(F["hoverThreshold"], F["cruiseSpeed"] * 0.9, speed)) if braking else 0.0
	hover_blend = damp(hover_blend, upright, 3.5 if braking else 5.0, dt)

	if braking and speed <= F["hoverThreshold"]:
		mode = "hover"
		_events.append({"type": "hover"})

	if boosting and _boom_armed and speed > F["boostSpeed"] * F["boomSpeedShare"]:
		_boom_armed = false
		_events.append({"type": "boom"})
	if speed < F["boostSpeed"] * 0.7:
		_boom_armed = true


func _resolve_world(dt: float) -> void:
	var F := tuning
	var radius: float = F["radius"]

	# World edge: a gentle hand that turns you back toward the city.
	var horizontal := sqrt(position[0] * position[0] + position[2] * position[2])
	if horizontal > F["worldRadius"]:
		var push := smoothstep64(F["worldRadius"], F["worldRadius"] + 700.0, horizontal)
		var home_yaw := atan2(-position[0], -position[2])
		yaw = wrap_angle(yaw + wrap_angle(home_yaw - yaw) * minf(1.0, push * 1.8 * dt))
		var hard_limit: float = F["worldRadius"] + 900.0
		if horizontal > hard_limit:
			position[0] *= hard_limit / horizontal
			position[2] *= hard_limit / horizontal
		if not _edge_warned:
			_edge_warned = true
			_events.append({"type": "edge"})
	elif horizontal < F["worldRadius"] - 400.0:
		_edge_warned = false
	position[1] = minf(position[1], F["maxAltitude"] + 300.0)

	# Ground and sea: never a crash, just a skim.
	var ground: float = world.ground_height(position[0], position[2])
	var surface := maxf(ground, 0.0)
	over_water = ground < 0.5
	ground_clearance = position[1] - surface
	if position[1] < surface + radius:
		var vertical_speed: float = -velocity[1]
		position[1] = surface + radius
		if velocity[1] < 0.0:
			velocity[1] = 0.0
		if mode == "flying" and pitch < 0.0:
			pitch = maxf(pitch, -0.04)
		if vertical_speed > 10.0 and _impact_cooldown <= 0.0:
			_impact_cooldown = 0.5
			var event_type := "splash" if over_water else "impact"
			var event := {"type": event_type, "strength": clampf64(vertical_speed / 70.0, 0.15, 1.0)}
			if event_type == "impact":
				event["dented"] = false
			_events.append(event)
		ground_clearance = radius

	# Buildings: burst through if the world says it gives way, otherwise glance off.
	var normal := [0.0, 0.0, 0.0]
	var hit = world.resolve_sphere(position, _previous_position, radius, normal)
	if hit != null:
		var into: float = velocity[0] * normal[0] + velocity[1] * normal[1] + velocity[2] * normal[2]
		var outcome = null
		if into < 0.0 and world.has_smash():
			outcome = world.smash(hit, position, normal, velocity, -into)
		if outcome != null and outcome["brokeThrough"] and mode == "flying":
			speed = maxf(F["minFlightSpeed"], speed * F["smashSpeedKept"])
			yaw_rate *= 0.5
			_events.append({"type": "smash", "kind": outcome["kind"], "strength": outcome["strength"]})
		elif into < 0.0:
			for i in 3:
				velocity[i] += normal[i] * (-into * 1.15)
			if mode == "flying":
				var slide_speed := length3(velocity)
				speed = maxf(F["minFlightSpeed"], slide_speed * 0.9)
				if slide_speed > 1e-3:
					yaw = atan2(velocity[0], velocity[2])
					pitch = asin(clampf64(velocity[1] / slide_speed, -1.0, 1.0))
					yaw_rate *= 0.3
			if -into > 6.0 and _impact_cooldown <= 0.0:
				_impact_cooldown = 0.35
				var dented: bool = outcome != null and outcome["kind"] == "dent"
				_events.append({"type": "impact", "strength": clampf64(-into / 60.0, 0.1, 1.0), "dented": dented})

	# Skimming close to walls or water at speed feeds the rush effects.
	var wall_distance: float = world.nearest_surface(position, 16.0)
	var wall_rush := 1.0 - smoothstep64(radius + 1.0, 16.0, wall_distance)
	var water_rush := (1.0 - smoothstep64(radius + 1.0, 12.0, ground_clearance)) if over_water else 0.0
	var rush_target := maxf(wall_rush, water_rush) * smoothstep64(20.0, 70.0, speed)
	surface_rush = damp(surface_rush, rush_target, 6.0, dt)


func _update_basis() -> void:
	var cos_pitch := cos(pitch)
	var sin_pitch := sin(pitch)
	var sin_yaw := sin(yaw)
	var cos_yaw := cos(yaw)
	forward = [sin_yaw * cos_pitch, sin_pitch, cos_yaw * cos_pitch]
	var level_right := [-cos_yaw, 0.0, sin_yaw]
	# level_up = level_right × forward
	var level_up := [
		level_right[1] * forward[2] - level_right[2] * forward[1],
		level_right[2] * forward[0] - level_right[0] * forward[2],
		level_right[0] * forward[1] - level_right[1] * forward[0],
	]
	var cos_bank := cos(bank)
	var sin_bank := sin(bank)
	for i in 3:
		up[i] = level_up[i] * cos_bank + level_right[i] * sin_bank
		right[i] = level_right[i] * cos_bank - level_up[i] * sin_bank
