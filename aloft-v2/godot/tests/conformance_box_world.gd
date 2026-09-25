extends RefCounted
## The conformance test world: open sea (seabed at -40) and at most one box tower.
## Mirrors web/tests/conformance/box-world.ts exactly.

var tower = null  # null or {"min": [x, y, z], "max": [x, y, z]}
var smash_behaviour := "none"


func _init(tower_spec, behaviour: String) -> void:
	if tower_spec != null:
		tower = {"min": (tower_spec["min"] as Array).duplicate(), "max": (tower_spec["max"] as Array).duplicate()}
	smash_behaviour = behaviour


func ground_height(_x: float, _z: float) -> float:
	return -40.0


func nearest_surface(_position: Array, _max_distance: float) -> float:
	return INF


func resolve_sphere(p: Array, _previous: Array, r: float, normal: Array):
	if tower == null:
		return null
	var mn: Array = tower["min"]
	var mx: Array = tower["max"]
	var qx: float = minf(maxf(p[0], mn[0]), mx[0])
	var qy: float = minf(maxf(p[1], mn[1]), mx[1])
	var qz: float = minf(maxf(p[2], mn[2]), mx[2])
	var dx: float = p[0] - qx
	var dy: float = p[1] - qy
	var dz: float = p[2] - qz
	var dist := sqrt(dx * dx + dy * dy + dz * dz)
	if dist >= r or dist == 0.0:
		return null
	normal[0] = dx / dist
	normal[1] = dy / dist
	normal[2] = dz / dist
	for i in 3:
		p[i] += normal[i] * (r - dist)
	return "tower"


func has_smash() -> bool:
	return smash_behaviour != "none"


func smash(_hit, _point: Array, _normal: Array, _velocity: Array, _impact: float):
	if smash_behaviour == "burst":
		tower = null  # the section above is gone
		return {"brokeThrough": true, "strength": 1.0, "kind": "topple"}
	return {"brokeThrough": false, "strength": 0.3, "kind": "dent"}
