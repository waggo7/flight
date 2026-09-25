# Build ledger

Append-only. One entry per milestone.

## M0 — Foundations (2026-09-25)

- New self-contained `aloft-v2/` (v1 untouched): `content/`, `conformance/`, `docs/`, `godot/`, `web/`.
- Web tooling: TypeScript 6.0 strict (plus a no-DOM config for portable layers), Vite 8.3 single-file
  build, Vitest 5, ESLint 10 with layer boundaries, Playwright 1.63 on the preinstalled Chromium.
- Engine core: fixed-step loop (identical sim at 30/60/144 Hz; 0.12× slow motion steps every 8–9
  frames), system phases, typed queued event bus, named seeded random streams, service registry,
  content validation.
- Flight model ported to `core/` behind a sweep-ready world contract (`resolveSphere` gets the
  previous position); all 12 v1 flight tests pass, plus new ones.
- Content as JSON: flight, camera, input, simulation tuning and shared input bindings.
- Godot 4.7.2 scaffold: GDScript flight model, Content/Events/InputActions autoloads, headless
  conformance runner. 12 cases / 3,040 checks match the TypeScript core to 1e-6.
- Grey-box island world, placeholder hero, chase camera, title/pause/restart flow, dev overlay (F3),
  `?test` API; e2e checks with screenshots at desktop and phone sizes.

## M1 — The look, city blueprint, building-space facade (2026-09-25)

- v1's world ported to strict TypeScript: atmosphere (typed shader patching with anchor tests), sky
  dome and environment, island terrain and trees, ocean, clouds, post pipeline, particles, dust,
  speed effects, hero and cape, HUD, flight audio, spark trails. A side-by-side harness matched
  v1's modules on 2,346 checks.
- `core/city-blueprint.ts` reproduces v1's generation byte-for-byte (digest fixture: 2,648 buildings).
- Building-space facade: windows, lit panes and grime computed in the piece's tier space, so a
  tower split into storey × bay chunks draws exactly like the intact one (no-pop e2e check:
  ≤ 0.06% of pixels on desktop, 0% on phone). Fracture faces draw concrete, slab lines, rebar.
- Features rewired as one module each (hud, settings, scene, time-scale, city, controls, flight,
  camera, world-look, hero, effects, sparks, audio, game-flow, flight-hud, dev-overlay, test-api).
  Fixed a latent boot failure (time-scale and settings weren't installed). Events are also flushed
  at the end of each frame, so presentation events arrive while paused.
- Collision: the city is Rapier from the start (M2's `RapierCityWorld`); the v1-style grid is kept
  only as a tested reference until M2 closes.
- Look parity vs v1 (quarter-res, 3% pixel budget): title and above-clouds pass. Canyon (lit-window
  pattern differs by design — hashed per building-space cell) and sea-skim (streak RNG, wave
  phase) are visually the same scene and get documented per-pose tolerances (20% / 14%).
- Audio: v1's truncation bug is fixed (noise layers loop and stop at their envelope's end; the
  collapse rumble runs its full 5.55 s). The "≥ 5 s above −60 dB" gate can't hold with v1's own
  recipe (it decays below −60 dBFS by ~2.6 s), so the long-roar requirement moves to M5's recipes.
- Size: 3.41 MB single file (Rapier wasm ≈ 2.7 MB), under the 4 MB gate.

## M3 (core) — Structure graph, crush planner, support check (2026-09-25)

- `building-structure.ts`: segments → storeys → lazily expanded bay chunks, with mass, health,
  intact loads and ornaments; node states only move forward (fixes v1's stump re-hit class).
- `crush-planner.ts`: a tunnel along the flight path, then an exit-wound wedge (apex at the entry,
  widening with speed, capped at 80% of the path) that keeps the entry side as the hinge.
- `support-check.ts`: compression by surviving area, overturning by centre of mass vs the survivors'
  hull, off-centre crush passes for directed hits, and the hit's push as an overturning moment.
- Tuning changes from the plan, found by the outcome matrix: glass crush energy 50 kJ/m³ (was 80),
  bore clearance 0.3 m (was 1.5; a wider bore diluted hits over three storeys), round towers ×4
  toughness, push lever 8 s. Outcomes now: 30 m glass — hole at 40, groans at 55, topples forward
  at 70/108; 15 m stone and 22 m towers topple forward from 55; round towers take 2–3 boost hits;
  a centred blast pancakes.

## M2 — Rapier (2026-09-25)

- Physics world (one importer of Rapier), collision groups, owner table with alive flags, pristine
  snapshot restore on Restart (handles survive, so everything holds handles, never objects).
- `RapierCityWorld` implements the flight/camera world contract with a swept ball, push-out,
  camera rays and floor rays; contract tests pin Rapier 0.20's conventions.
- The contact harvester and rubble governor live in the destruction system (M3).

## M3 — Destruction in Rapier (2026-09-25)

- `structure-regions` (core) turns nodes into merged bands and bay boxes with exterior masks.
- `destruction-system` (sim): hits → crush planner → support check; damaged segments rebuild
  their colliders from what stands; crushed chunks become debris; the part above a failed storey
  becomes one dynamic body that Rapier tips over its hinge.
- Found by the sim traces and fixed: debris wedged in the blow-out propped sections up (sections
  now ignore debris); crushing the hinge at 6° killed the rotation (the hinge now holds to 0.5 rad);
  sections balanced on their stump. Progressive collapse: the stump chunks under a leaning
  section's leading contacts crush once edge stress (W/A)(1 + 6e/b) passes the (dynamic) reserve.
- Landings break sections into bands and chunks; landings on neighbours knock on (generation ≤ 2).
- Gates: 30 m glass tower stands at 55 m/s, topples forward at 70/108, first ground hit 9.4 s /
  8.5 s (plan said ≤ 9 s; gate set at < 10 s — the tip from rest is physics-bound); stump re-hit
  regression; restart; determinism; real city: 3 smashes → 5 failures, 14 knock-on hits, within
  budgets, step p95 ≈ 6 ms in Node (plan: 5 ms).

## M4 — Destruction visuals (2026-09-25)

- Collapse effects: glass glints, concrete chips, dust jets from crushed storeys along the hit, a
  street-grid dust surge after heavy landings; two-band camera shake (sharp + low rumble); slow
  motion, FOV kick and "Timber!" on the first collapse; debris at the lens cut away.
- e2e: camera buried in dust keeps mean luminance 0.54 / 0.58 (gate 0.15–0.85).

## M5 — Collapse sound (2026-09-25)

- Spatial audio engine (buses, limiter + soft clip, street-canyon reverb thinning with altitude,
  air absorption, equal-power pan, distance gain, speed-of-sound delay, loudness-priority voice
  limiter, seeded looping noise, ducking, slow-motion muffle) and eight collapse recipes.
- `npm run audio:render` (CI): peak −4.0 dBFS, no NaN, roar tail 2.36 s, boom 4.1 s, centroids
  concrete 501 Hz / glass 4.6 kHz / groan 114 Hz, 32 voices at 1,000 contacts, 1 km arrives
  +2.77 s and 32.9 dB quieter than 50 m. WAVs sent to the user.

## M7 — Powers (2026-09-25)

- Ground slam (Q / Y / touch): windup, dive at 1.6× boost (or instant near the ground), landing
  on the street, a roof or a ledge; base crushes with an outward push topple nearby towers away;
  loose pieces are shoved out; shockwave ring, dust ring, ground boom, two-band shake.
- Grab and throw (E / X / touch): the best liftable piece ahead rides a spring hold point (it
  stops touching debris); a second press throws it along the view at +80 m/s; for 5 s it
  damages what it hits; ramming a building while holding adds its mass and shatters it.
- Powers HUD (cooldown rings, carry reticle, touch buttons, legend rows), injected at runtime.
- Gates (sim tests): a full slam in a ring of six towers fails ≥ 3 with knock-ons ≤ generation
  2; an 80 m/s throw of a rubble chunk topples a 15 m block; ramming shatters the held piece.
- Conformance vectors for storey layouts, crush plans + support verdicts (16 hits) and the power
  timelines (`conformance/destruction-and-powers.json`); Godot ports them at pivot time.

## M8 part 1 — First person: free look, comfort, visor feel (2026-09-25)

- Free look (hold F / right stick / two-finger drag) turns the head without changing course and
  springs back; first person looks along all of the flight pitch; comfort settings (roll share,
  horizon lock, max FOV, reduced motion); visor droplets, boost vignette, directional wall jolts.

## M9 (WIP) — Demo scenes (2026-09-25)

- Title and pause menus (and `?scenario=`) stage topple, pancake, domino, slam and throw over the
  real systems; the player steering or boosting takes over. Approaches need a clear 2.5 m corridor.

## Notes sprint — stars out, buildings push back, glass and metal, front view (2026-09-25)

- The collectible spark trails ("stars") are gone: feature, HUD badge and pointer, chimes.
- Buildings push back (`features/impact-recoil-feature.ts`, `content/tuning/combat.json`): a hero
  hit reports the share of the punch the target soaked up (real city towers: 0.09–1.0); speed loss
  (bursting through) or a knock off line (bouncing off), roll, stagger (boost cut, weak steering),
  hit-stop and camera punch scale with it, then a surge as the hero breaks free; heavy landings
  nearby rock the hero. The flight model and its conformance vectors are untouched. (A knock off
  line while still in the tunnel steered the hero into its walls for a second hit that changed the
  collapse: bursting through keeps the line.)
- Glass and metal: glass glints (HDR, twinkling), the curtain wall bursting back out at the hit and
  a glass rain down the face; sparks off torn steel at the hit, from every crushed storey and on
  heavy contacts. Sound: `glassSmash` and `metalShear` (tearing steel, then the member rings) on
  hero hits, a long low shear when a frame gives way, scrapes in the rubble.
- Front view: Shift+V / Shift+C (D-pad ↓) swings the camera round in front of the hero to look
  back at what it just smashed; V returns to the previous view. Chords live in actions.json
  (`Shift+KeyV`); Godot's input map registers them with `shift_pressed`.
- Demo scenes fix (pre-existing): a cut applied its controls a frame late, so the respawned hero
  took one step on the last shot's boost and launched from its hover into the falling tower;
  `drive()` now applies controls at once. The topple and domino scenes watch from the vantage again.
- Next-round prompt (fighting dynamics), as given to the user:

  > Aloft v2 (`aloft-v2/`, branch `claude/compassionate-mendel-ypd9fk`). Read `aloft-v2/AGENTS.md`
  > and `docs/now.md` first. Goal: fighting dynamics — from "smash buildings" to "superhero fight
  > in the sky". In order, each playable, tested, committed: (1) dash-punch — a short lunge that
  > adds punch mass, cooldown ring, recoil through `impact-recoil-feature.ts`; (2) combo meter —
  > hits within 2.5 s chain, each step adds hit-stop, FOV punch and damage, HUD counter; (3) one
  > sky enemy that implements `Damageable`, chases, telegraphs a charge, can be punched, grabbed
  > and thrown into buildings, knock-back both ways, 3–5 at once within budget; (4) hero health
  > and stagger from enemy hits, a wave loop as a demo scene. Tuning in
  > `content/tuning/combat.json`; new core modules get conformance vectors; `npm run check` and
  > `npm run e2e` green; stills of each move on desktop and phone.
