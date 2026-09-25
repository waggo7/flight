extends RefCounted
## The hero's pose graph: flight state, power state and events in; weights over the pose library
## (content/heroes/poses.json) and one local rotation per joint out, through per-joint damped
## springs, additive layers (bank lean, steering drift, breathing, boost flutter, hover bob) and a
## head look-at.
##
## GDScript twin of web/src/core/hero-pose-graph.ts (and its quaternion helpers,
## web/src/core/joint-rotation.ts). Both must reproduce conformance/hero-pose-graph.json. All
## state is kept in Arrays of 64-bit floats; quaternions are (x, y, z, w), Euler order XYZ as in
## three.js. In the Godot game this drives the Skeleton3D directly (an AnimationTree could host
## the same weights later).
##
## Input (Dictionary, same keys as the TS HeroPoseInput):
##   hoverBlend, boostBlend, speedShare, pitch, bank, yawRate, steerX, brake,
##   actions: {slam: "ready"|"windup"|"dive"|"impact"|"recover"|"cooldown", grab: "empty"|"reaching"|"holding"|"windup"|"release"},
##   look: null or {x, y, z, weight}  (direction in the hero root frame, +Z forward, +Y up)

const JOINTS := [
	"body", "pelvis", "spine", "spine2", "chest", "neck", "head",
	"clavicleL", "clavicleR", "shoulderL", "shoulderR", "elbowL", "elbowR", "wristL", "wristR",
	"fingersL", "fingersR", "thumbL", "thumbR",
	"hipL", "hipR", "kneeL", "kneeR", "ankleL", "ankleR",
]
const POSES := [
	"hover", "cruise", "boost", "dive", "brake", "burst", "glance",
	"slamWindup", "slamLand", "grabReach", "hold", "throwWindup", "throwRelease",
]
const FLIGHT_POSES := ["hover", "brake", "dive", "boost", "cruise"]
## Spring group per joint: 0 core, 1 limb, 2 hand, 3 head.
const SPRING_GROUP := {
	"body": 0, "pelvis": 0, "spine": 0, "spine2": 0, "chest": 0, "neck": 3, "head": 3,
	"clavicleL": 1, "clavicleR": 1, "shoulderL": 1, "shoulderR": 1, "elbowL": 1, "elbowR": 1, "wristL": 1, "wristR": 1,
	"fingersL": 2, "fingersR": 2, "thumbL": 2, "thumbR": 2,
	"hipL": 1, "hipR": 1, "kneeL": 1, "kneeR": 1, "ankleL": 1, "ankleR": 1,
}
const IDLE_ACTIONS := {"slam": "ready", "grab": "empty"}

var weights: Array = []
var rotations: Array = []
var offset: Array = [0.0, 0.0, 0.0]
var look: Array = [0.0, 0.0]
var time := 0.0

var _tuning: Dictionary
var _joint_count := JOINTS.size()
var _pose_count := POSES.size()
var _pose_quats: Array = []
var _defines: Array = []
var _pose_offsets: Array = []
var _flight_weights: Array = []
var _override_weights: Array = []
var _target: Array = []
var _spring_value: Array = []
var _spring_velocity: Array = []
var _target_offset: Array = [0.0, 0.0, 0.0]
var _offset_value: Array = [0.0, 0.0, 0.0]
var _offset_velocity: Array = [0.0, 0.0, 0.0]
var _look_value: Array = [0.0, 0.0]
var _look_velocity: Array = [0.0, 0.0]
var _target_look: Array = [0.0, 0.0]
var _coefficients: Array = []
var _scratch: Array = []
var _frame: Array = []
var _joint_group: Array = []
var _event_age := {"burst": INF, "glance": INF}
var _forced := -1


static func _filled(size: int, value: float) -> Array:
	var array: Array = []
	array.resize(size)
	array.fill(value)
	return array


func _init(library: Dictionary) -> void:
	_tuning = library["graph"]
	weights = _filled(_pose_count, 0.0)
	rotations = _filled(_joint_count * 4, 0.0)
	_pose_quats = _filled(_pose_count * _joint_count * 4, 0.0)
	_defines = _filled(_pose_count * _joint_count, 0.0)
	_pose_offsets = _filled(_pose_count * 3, 0.0)
	_flight_weights = _filled(_pose_count, 0.0)
	_override_weights = _filled(_pose_count, 0.0)
	_target = _filled(_joint_count * 4, 0.0)
	_spring_value = _filled(_joint_count * 4, 0.0)
	_spring_velocity = _filled(_joint_count * 4, 0.0)
	_coefficients = _filled(24, 0.0)
	_scratch = _filled(16, 0.0)
	_frame = _filled(8, 0.0)
	for j in _joint_count:
		_joint_group.append(SPRING_GROUP[JOINTS[j]])
	var hands: Dictionary = library["hands"]
	for p in _pose_count:
		var pose_name: String = POSES[p]
		var pose: Dictionary = library["poses"][pose_name]
		var full: bool = pose["full"]
		var euler := {}
		var joints: Dictionary = pose["joints"]
		for joint in joints:
			if joints[joint] != null:
				euler[joint] = joints[joint]
		for side in ["L", "R"]:
			var shape_name = pose.get("hand" + side)
			var shape = null
			if shape_name != null:
				shape = hands[shape_name]
			elif full:
				shape = hands["open"]
			if shape == null:
				continue
			var mirror := -1.0 if side == "R" else 1.0
			var fingers: Array = shape["fingers"]
			var thumb: Array = shape["thumb"]
			euler["fingers" + side] = [float(fingers[0]), float(fingers[1]) * mirror, float(fingers[2]) * mirror]
			euler["thumb" + side] = [float(thumb[0]), float(thumb[1]) * mirror, float(thumb[2]) * mirror]
		for j in _joint_count:
			var o: int = (p * _joint_count + j) * 4
			if euler.has(JOINTS[j]):
				var angles: Array = euler[JOINTS[j]]
				quat_from_euler_xyz(_pose_quats, o, float(angles[0]), float(angles[1]), float(angles[2]))
			else:
				quat_identity(_pose_quats, o)
			if _pose_quats[o + 3] < 0.0:
				for k in 4:
					_pose_quats[o + k] = -_pose_quats[o + k]
			_defines[p * _joint_count + j] = 1.0 if (full or euler.has(JOINTS[j])) else 0.0
		var pose_offset = pose.get("offset")
		if pose_offset == null:
			pose_offset = [0.0, 0.0, 0.0]
		for k in 3:
			_pose_offsets[p * 3 + k] = float(pose_offset[k])
	for j in _joint_count:
		quat_identity(_spring_value, j * 4)
	snap(null)


# --- scalar helpers (mirror web/src/core/scalar-math.ts) ---------------------------------

static func clampf64(value: float, lo: float, hi: float) -> float:
	return minf(hi, maxf(lo, value))


static func smoothstep64(edge0: float, edge1: float, x: float) -> float:
	var t := clampf64((x - edge0) / (edge1 - edge0), 0.0, 1.0)
	return t * t * (3.0 - 2.0 * t)


static func finite(value, fallback := 0.0) -> float:
	var x := float(value)
	if is_nan(x) or is_inf(x):
		return fallback
	return x


# --- quaternions (mirror web/src/core/joint-rotation.ts) ---------------------------------

static func quat_from_euler_xyz(out: Array, o: int, x: float, y: float, z: float) -> void:
	var c1 := cos(x / 2.0)
	var c2 := cos(y / 2.0)
	var c3 := cos(z / 2.0)
	var s1 := sin(x / 2.0)
	var s2 := sin(y / 2.0)
	var s3 := sin(z / 2.0)
	out[o] = s1 * c2 * c3 + c1 * s2 * s3
	out[o + 1] = c1 * s2 * c3 - s1 * c2 * s3
	out[o + 2] = c1 * c2 * s3 + s1 * s2 * c3
	out[o + 3] = c1 * c2 * c3 - s1 * s2 * s3


static func quat_multiply(out: Array, o: int, a: Array, ao: int, b: Array, bo: int) -> void:
	var ax: float = a[ao]
	var ay: float = a[ao + 1]
	var az: float = a[ao + 2]
	var aw: float = a[ao + 3]
	var bx: float = b[bo]
	var by: float = b[bo + 1]
	var bz: float = b[bo + 2]
	var bw: float = b[bo + 3]
	out[o] = ax * bw + aw * bx + ay * bz - az * by
	out[o + 1] = ay * bw + aw * by + az * bx - ax * bz
	out[o + 2] = az * bw + aw * bz + ax * by - ay * bx
	out[o + 3] = aw * bw - ax * bx - ay * by - az * bz


static func quat_conjugate(out: Array, o: int, q: Array, qo: int) -> void:
	out[o] = -q[qo]
	out[o + 1] = -q[qo + 1]
	out[o + 2] = -q[qo + 2]
	out[o + 3] = q[qo + 3]


static func quat_normalize(q: Array, o: int) -> void:
	var length := sqrt(q[o] * q[o] + q[o + 1] * q[o + 1] + q[o + 2] * q[o + 2] + q[o + 3] * q[o + 3])
	if length < 1e-12:
		q[o] = 0.0
		q[o + 1] = 0.0
		q[o + 2] = 0.0
		q[o + 3] = 1.0
		return
	q[o] /= length
	q[o + 1] /= length
	q[o + 2] /= length
	q[o + 3] /= length


static func quat_dot(a: Array, ao: int, b: Array, bo: int) -> float:
	return a[ao] * b[bo] + a[ao + 1] * b[bo + 1] + a[ao + 2] * b[bo + 2] + a[ao + 3] * b[bo + 3]


static func quat_identity(out: Array, o: int) -> void:
	out[o] = 0.0
	out[o + 1] = 0.0
	out[o + 2] = 0.0
	out[o + 3] = 1.0


static func quat_rotate_in_frame(out: Array, o: int, p: Array, po: int, r: Array, ro: int, q: Array, qo: int, scratch: Array) -> void:
	quat_multiply(scratch, 0, r, ro, p, po)
	quat_multiply(scratch, 0, scratch, 0, q, qo)
	quat_conjugate(scratch, 4, p, po)
	quat_multiply(out, o, scratch, 4, scratch, 0)


# --- springs and pulses ------------------------------------------------------------------

static func spring_coefficients(omega: float, zeta: float, dt: float, out: Array, o: int) -> void:
	if zeta >= 0.9999:
		var ec := exp(-omega * dt)
		out[o] = ec * (1.0 + omega * dt)
		out[o + 1] = ec * dt
		out[o + 2] = -ec * omega * omega * dt
		out[o + 3] = ec * (1.0 - omega * dt)
		return
	var wd := omega * sqrt(1.0 - zeta * zeta)
	var e := exp(-zeta * omega * dt)
	var c := cos(wd * dt)
	var s := sin(wd * dt)
	out[o] = e * (c + ((zeta * omega) / wd) * s)
	out[o + 1] = (e * s) / wd
	out[o + 2] = (-e * omega * omega * s) / wd
	out[o + 3] = e * (c - ((zeta * omega) / wd) * s)


static func event_envelope(age: float, duration: float, rise: float, hold: float) -> float:
	if age < 0.0 or age >= duration:
		return 0.0
	var u := age / duration
	return minf(1.0, u / rise) * (1.0 - smoothstep64(hold, 1.0, u))


# --- the graph ---------------------------------------------------------------------------

func trigger(event: String) -> void:
	_event_age[event] = 0.0


func force(pose_name) -> void:
	_forced = -1 if pose_name == null else POSES.find(pose_name)


func snap(input) -> void:
	if input != null:
		_compute_targets(input)
	else:
		_fill_rest_targets()
	for i in _joint_count * 4:
		_spring_value[i] = _target[i]
		_spring_velocity[i] = 0.0
	for k in 3:
		_offset_value[k] = _target_offset[k]
		_offset_velocity[k] = 0.0
	for k in 2:
		_look_value[k] = _target_look[k]
		_look_velocity[k] = 0.0
	_compose(input)


func update(dt: float, input: Dictionary) -> void:
	var step := clampf64(finite(dt), 0.0, 0.25)
	time += step
	_event_age["burst"] += step
	_event_age["glance"] += step
	_compute_targets(input)
	_step_springs(step)
	_compose(input)


func _fill_rest_targets() -> void:
	var p := POSES.find("hover")
	for i in _pose_count:
		weights[i] = 0.0
	weights[p] = 1.0
	for i in _joint_count * 4:
		_target[i] = _pose_quats[p * _joint_count * 4 + i]
	for k in 3:
		_target_offset[k] = _pose_offsets[p * 3 + k]
	_target_look[0] = 0.0
	_target_look[1] = 0.0


func _compute_flight_weights(input: Dictionary) -> void:
	var f := _flight_weights
	for i in _pose_count:
		f[i] = 0.0
	var hover := clampf64(finite(input["hoverBlend"], 1.0), 0.0, 1.0)
	var fly := 1.0 - hover
	var brake := fly * clampf64(finite(input["brake"]), 0.0, 1.0)
	var rest := fly - brake
	var dive := rest * smoothstep64(_tuning["dive"]["start"], _tuning["dive"]["full"], -finite(input["pitch"]))
	var level := rest - dive
	var boost := level * clampf64(finite(input["boostBlend"]), 0.0, 1.0)
	f[POSES.find("hover")] = hover
	f[POSES.find("brake")] = brake
	f[POSES.find("dive")] = dive
	f[POSES.find("boost")] = boost
	f[POSES.find("cruise")] = level - boost


func _compute_override_weights(input: Dictionary) -> float:
	var o := _override_weights
	for i in _pose_count:
		o[i] = 0.0
	if _forced >= 0:
		o[_forced] = 1.0
		return 1.0
	var total := 0.0
	var actions = input.get("actions")
	if actions == null:
		actions = IDLE_ACTIONS
	for entry in [_tuning["actions"]["slam"].get(actions["slam"]), _tuning["actions"]["grab"].get(actions["grab"])]:
		if entry == null:
			continue
		var share := minf(clampf64(entry["weight"], 0.0, 1.0), 1.0 - total)
		var index := POSES.find(entry["pose"])
		o[index] += share
		total += share
	var events: Dictionary = _tuning["events"]
	var burst := event_envelope(_event_age["burst"], events["burst"]["duration"], events["burst"]["rise"], events["burst"]["hold"])
	var glance := event_envelope(_event_age["glance"], events["glance"]["duration"], events["glance"]["rise"], events["glance"]["hold"])
	var room := 1.0 - total
	var pulses := burst + glance
	var scale := 1.0 / pulses if pulses > 1.0 else 1.0
	o[POSES.find("burst")] += burst * scale * room
	o[POSES.find("glance")] += glance * scale * room
	total += pulses * scale * room
	return total


func _compute_targets(input: Dictionary) -> void:
	_compute_flight_weights(input)
	var override := _compute_override_weights(input)
	var f := _flight_weights
	var o := _override_weights
	var sum := 0.0
	for p in _pose_count:
		weights[p] = f[p] * (1.0 - override) + o[p]
		sum += weights[p]
	for p in _pose_count:
		weights[p] = weights[p] / sum if sum > 0.0 else 0.0

	for k in 3:
		_target_offset[k] = 0.0
	for j in _joint_count:
		var missing := 0.0
		for p in _pose_count:
			if o[p] > 0.0 and _defines[p * _joint_count + j] == 0.0:
				missing += o[p]
		var x := 0.0
		var y := 0.0
		var z := 0.0
		var w := 0.0
		for p in _pose_count:
			var e: float = f[p] * (1.0 - override + missing)
			if o[p] > 0.0 and _defines[p * _joint_count + j] != 0.0:
				e += o[p]
			if e <= 0.0:
				continue
			if j == 0:
				for k in 3:
					_target_offset[k] += _pose_offsets[p * 3 + k] * e
			var q := (p * _joint_count + j) * 4
			x += _pose_quats[q] * e
			y += _pose_quats[q + 1] * e
			z += _pose_quats[q + 2] * e
			w += _pose_quats[q + 3] * e
		var t := j * 4
		_target[t] = x
		_target[t + 1] = y
		_target[t + 2] = z
		_target[t + 3] = w
		quat_normalize(_target, t)

	var limits: Dictionary = _tuning["look"]
	var max_yaw: float = limits["maxYaw"]
	var max_pitch: float = limits["maxPitch"]
	var turn_yaw := clampf64(finite(input["yawRate"]) * limits["turnLead"], -max_yaw, max_yaw)
	var yaw := turn_yaw
	var pitch := 0.0
	var target = input.get("look")
	if target != null:
		var weight := clampf64(finite(target["weight"]), 0.0, 1.0)
		var lx := finite(target["x"])
		var ly := finite(target["y"])
		var lz := finite(target["z"])
		var flat := sqrt(lx * lx + lz * lz)
		if weight > 0.0 and flat + absf(ly) > 1e-9:
			var want_yaw := clampf64(atan2(lx, lz), -max_yaw, max_yaw)
			var want_pitch := clampf64(atan2(ly, flat), -max_pitch, max_pitch)
			yaw = turn_yaw + (want_yaw - turn_yaw) * weight
			pitch = want_pitch * weight
	_target_look[0] = yaw
	_target_look[1] = pitch


func _step_springs(dt: float) -> void:
	var springs: Dictionary = _tuning["springs"]
	var k := _coefficients
	var zeta: float = springs["dampingRatio"]
	spring_coefficients(springs["core"], zeta, dt, k, 0)
	spring_coefficients(springs["limb"], zeta, dt, k, 4)
	spring_coefficients(springs["hand"], zeta, dt, k, 8)
	spring_coefficients(springs["head"], zeta, dt, k, 12)
	spring_coefficients(springs["offset"], zeta, dt, k, 16)
	spring_coefficients(springs["look"], zeta, dt, k, 20)
	for j in _joint_count:
		var t := j * 4
		var sign := -1.0 if quat_dot(_spring_value, t, _target, t) < 0.0 else 1.0
		var g: int = _joint_group[j] * 4
		for c in 4:
			var i := t + c
			var goal: float = _target[i] * sign
			var y: float = _spring_value[i] - goal
			var v: float = _spring_velocity[i]
			_spring_value[i] = goal + k[g] * y + k[g + 1] * v
			_spring_velocity[i] = k[g + 2] * y + k[g + 3] * v
	for c in 3:
		var y: float = _offset_value[c] - _target_offset[c]
		var v: float = _offset_velocity[c]
		_offset_value[c] = _target_offset[c] + k[16] * y + k[17] * v
		_offset_velocity[c] = k[18] * y + k[19] * v
	for c in 2:
		var y: float = _look_value[c] - _target_look[c]
		var v: float = _look_velocity[c]
		_look_value[c] = _target_look[c] + k[20] * y + k[21] * v
		_look_velocity[c] = k[22] * y + k[23] * v


func _compose(input) -> void:
	for i in _joint_count * 4:
		rotations[i] = _spring_value[i]
	for j in _joint_count:
		quat_normalize(rotations, j * 4)
	for k in 3:
		offset[k] = _offset_value[k]
	look[0] = _look_value[0]
	look[1] = _look_value[1]
	if input == null:
		return

	var layers: Dictionary = _tuning["layers"]
	var t := time
	var hover: float = weights[POSES.find("hover")]
	var fly := 1.0 - clampf64(finite(input["hoverBlend"], 1.0), 0.0, 1.0)
	var bank := clampf64(finite(input["bank"]), -1.6, 1.6)
	var steer := clampf64(finite(input["steerX"]), -1.0, 1.0)
	var boost := clampf64(finite(input["boostBlend"]), 0.0, 1.0)
	var breath: float = sin(t * layers["breathRate"]) * layers["breathDepth"] * hover
	var flutter: float = sin(t * layers["flutterRate"]) * layers["flutterDepth"] * boost * fly
	var sway: float = sin(t * 1.1) * layers["idleSway"] * hover

	_add_rotation("spine2", breath, 0.0, -bank * layers["bankLean"] * fly)
	_add_rotation("clavicleL", 0.0, 0.0, breath * 0.6)
	_add_rotation("clavicleR", 0.0, 0.0, -breath * 0.6)
	_add_rotation("hipL", 0.0, 0.0, bank * layers["bankHips"] * fly + flutter)
	_add_rotation("hipR", sway, 0.0, bank * layers["bankHips"] * fly - flutter)
	_add_rotation("ankleL", flutter * 2.0, 0.0, 0.0)
	_add_rotation("ankleR", -flutter * 2.0, 0.0, 0.0)
	_add_rotation("shoulderR", 0.0, 0.0, -steer * layers["steerDrift"] * fly)
	_add_rotation("shoulderL", 0.0, 0.0, -steer * layers["steerDrift"] * 0.5 * fly)
	offset[1] += sin(t * layers["bobRate"]) * layers["bobHeight"] * hover

	_apply_look(look[0], look[1])


func _add_rotation(joint: String, x: float, y: float, z: float) -> void:
	if x == 0.0 and y == 0.0 and z == 0.0:
		return
	var j := JOINTS.find(joint)
	quat_from_euler_xyz(_scratch, 0, x, y, z)
	quat_multiply(rotations, j * 4, rotations, j * 4, _scratch, 0)


func _apply_look(yaw: float, pitch: float) -> void:
	if yaw == 0.0 and pitch == 0.0:
		return
	var r := rotations
	var share: float = _tuning["look"]["neckShare"]
	var frame := _frame
	var body := JOINTS.find("body") * 4
	for k in 4:
		frame[k] = r[body + k]
	quat_multiply(frame, 0, frame, 0, r, JOINTS.find("spine") * 4)
	quat_multiply(frame, 0, frame, 0, r, JOINTS.find("spine2") * 4)
	quat_multiply(frame, 0, frame, 0, r, JOINTS.find("chest") * 4)
	var neck := JOINTS.find("neck") * 4
	quat_from_euler_xyz(_scratch, 8, -pitch * share, 0.0, 0.0)
	quat_from_euler_xyz(_scratch, 12, 0.0, yaw * share, 0.0)
	quat_multiply(frame, 4, _scratch, 12, _scratch, 8)
	quat_rotate_in_frame(r, neck, frame, 0, frame, 4, r, neck, _scratch)
	quat_normalize(r, neck)
	var head := JOINTS.find("head") * 4
	quat_multiply(frame, 0, frame, 0, r, neck)
	quat_from_euler_xyz(_scratch, 8, -pitch * (1.0 - share), 0.0, 0.0)
	quat_from_euler_xyz(_scratch, 12, 0.0, yaw * (1.0 - share), 0.0)
	quat_multiply(frame, 4, _scratch, 12, _scratch, 8)
	quat_rotate_in_frame(r, head, frame, 0, frame, 4, r, head, _scratch)
	quat_normalize(r, head)
