# Aloft — Godot 4.7 pivot scaffold

Kept ready so the project can move from the web to Godot at any time without losing the design.

- `core/` — GDScript ports of the web `core/` modules (flight model so far), checked against
  `../conformance/*.json`.
- `autoload/` — `Content` (shared JSON), `Events` (signal bus mirroring the web event map),
  `InputActions` (shared key and gamepad bindings).
- `tests/conformance_runner.gd` — headless runner used by CI.

Run the checks from `aloft-v2/web`:

```bash
npm run godot:check   # downloads Godot 4.7.2 once, syncs shared JSON, runs the runner
```

See `../docs/godot-pivot.md` for the concept map and porting order.
