# Aloft v2 — real collapse physics, collapse sound, two powers, Godot-ready

## At a glance

- **Where:** a new `aloft-v2/` folder in this repo. v1 stays as the reference.
- **More real collapses:** structural rules decide what fails, and the Rapier physics engine moves the pieces. Towers topple forward, pancake floor by floor, knock into neighbours, and leave rubble.
- **Collapse sound:** buildings groan before they go, then crack, rumble and boom. Sound is spatial and arrives later with distance, like real sound.
- **Powers:** ground slam, and grab and throw. Both run on one damage system, which becomes the base for sky fights.
- **Character revision:** each hero is one JSON file, with 3 presets to start. A new rig adds hands, heroic proportions and no gaps at the joints. There are 13 poses (including a superhero landing on slam) with springy, weighty transitions, and the head turns toward the action.
- **First-person upgrade:** you see your own arms and fists. You can look around without changing course and throw where you look. Comfort settings, visor effects and a minimal visor HUD round it out.
- **Godot 4.7, always ready:** portable core logic, shared JSON content, and conformance tests that a Godot scaffold runs on every push.
- **The coding binge:** 10 milestones (M0–M9), in this order: physics and sound first (the coolest part), then character, powers, first person and ship. Each one ends playable, tested, committed and pushed, and the last publishes a new link.

## Context

- **Why:** v1 (repo root) is a great prototype on a weak foundation.
  - One feature touched 12 of 26 files, and `main.js` wires 20 modules.
  - Towers topple on a scripted rod equation, and tall sections crumble away in mid-air.
  - A stale-extents bug brings back pieces that already fell when a stump is hit again.
  - Audio is mono, and a bug cuts off every long noise layer after 0.8–2 s.
- **What you asked for:**
  - More real physics and sound for collapsing buildings (the coolest part).
  - Cooler for a demo now, and scalable toward "any superhero fighting in the sky".
  - A new folder, built in one intensive push (the "coding binge").
  - Character revisions and first-person mode upgrades (your follow-up).
    - v1's hero has 17 joints, 2 poses, no hands, and ~40 separate meshes.
    - v1's first person hides the whole body, looks along 82% of the flight pitch, and shares chase's roll.
- **Your decisions:**
  - Web + a real physics engine, always ready to pivot to Godot 4.7.
  - The folder `aloft-v2/` in this repo; v1 untouched.
  - Two powers: ground slam, and grab and throw.
- **Outcome:** a playable single-file demo.
  - Towers fail from structural rules, and rigid-body physics moves the pieces: topple, pancake, domino, rubble that stays.
  - Collapses have layered, spatial, physics-driven sound.
  - New heroes, powers and enemies drop in without editing a central file.

## The fine line

| Build now (scalable core) | Defer (keeps the demo fast) |
|---|---|
| TypeScript strict; features install themselves; fixed 60 Hz sim; typed event bus | ECS library (koota once enemies arrive; data stays in flat arrays with integer ids, so the move is mechanical) |
| One `DamageEvent` → `Damageable` pipeline (buildings now; hero and enemies later) | Enemies/AI, missions, saves, multiplayer |
| Rapier rigid bodies + support-graph destruction | Beam slice (the `cut` damage kind stays in the type), HRTF panning, a camera that takes control |
| Engine-neutral JSON content + conformance vectors + Godot scaffold | Editor, hand-built levels, WebGPU/TSL (three.js calls it experimental) |
| Procedural spatial audio engine | Recorded samples (offline renders double as samples) |
| Unit, sim (Node), e2e, audio, perf and Godot checks in CI | Bench UI, replay editor |

## Layout

```
flight/                        v1 frozen; root AGENTS.md + README get a 3-line pointer to aloft-v2/
├─ .github/workflows/aloft-v2.yml    CI for v2 only (path filter aloft-v2/**)
└─ aloft-v2/
   ├─ AGENTS.md (canonical for v2) · CLAUDE.md (= @AGENTS.md) · README.md
   ├─ content/       engine-neutral JSON, the source of truth for web and Godot
   │                 tuning/, materials, archetypes, powers, audio-recipes, scenarios/,
   │                 heroes/ (one file per hero + the shared pose library)
   ├─ conformance/   golden vectors (inputs → expected outputs) for every core module
   ├─ docs/          godot-pivot.md · destruction-model.md · audio-design.md
   │                 now.md + LOG_build-ledger.md (session state, never in AGENTS.md)
   ├─ godot/         Godot 4.7 scaffold: project.godot, autoload/, core/ (ported), tests/, shared/ (synced, gitignored)
   └─ web/           package.json · tsconfig.*.json · vite.config.ts · eslint.config.js · index.html
      ├─ src/core/      portable pure logic (Godot port target)
      ├─ src/engine/    loop, phases, event bus, random streams, content loader, contexts
      ├─ src/sim/       headless simulation with Rapier (runs in Node)
      ├─ src/present/   render/, audio/, input/, ui/ (browser only)
      ├─ src/features/  install modules (the only place systems get wired)
      ├─ src/app/       main.ts, feature-list.ts, quality-profile.ts, test-api.ts
      ├─ tests/         unit/ · sim/ (Rapier in Node) · e2e/ (Playwright) · audio/
      └─ scripts/       conformance-write · godot-sync · godot-check · physics-perf · audio-render · screenshots · size-check
```

**Boundaries** (ESLint `no-restricted-imports` + a no-DOM `tsconfig.core.json`):
- `core/` imports only `core/`, with three's math via `core/math.ts`.
- `sim/` adds `engine/` and Rapier.
- `present/` may import anything.
- `Math.random` is banned in `core/` and `sim/`.

**Where things live:**

| Layer | Contents |
|---|---|
| `core/` | flight model (world contract `sweepSphere`), city blueprint (v1 generation, same seed), storey layout, footprint polygons, support graph, crush planner, support check, islands, power state machines, hero pose graph, view state (camera modes, free look, comfort) |
| `sim/` | physics world, collision groups, collider owners (alive flags), world queries, contact harvester, hero sweep, building activator, fragment actors, secondary fracture, rubble governor, destruction system, power glue |
| `present/` | ported look, facade material, building instances, dust, debris, glass, camera shake, camera rig, hero rig builder, first-person arms, visor effects, cape, audio engine and recipes, HUD, hero select, input |

## Architecture

- **Composition root:** `app/feature-list.ts` lists features.
  - Each feature's `install(ctx)` registers systems, event handlers and UI.
  - A new feature means one folder plus one line. (In v1, one feature touched 12 files.)
- **Loop:**
  - Fixed 1/60 s steps from an accumulator: at most 4 per frame on desktop, 2 on phone; when behind, sim time is dropped rather than spiralling.
  - Render interpolation is mandatory, because at 0.12× a step runs only every ~8 frames.
  - Hit-stop (×0.12 for 0.13 s) and slow-mo on the first big failure (×0.35 plus an FOV kick) scale sim time only.
- **Phases:**
  - Per step: `Input → Powers → Hero → DestructionApply → Physics → Contacts → Fracture → Governor → SyncPoses`.
  - Per frame: `Present → Audio → Render`.

```ts
interface Feature<C extends SimContext = SimContext> { name: string; install(ctx: C): void | Promise<void> }
interface System { name: string; phase: Phase; fixed?(dt: number): void; frame?(realDt: number, alpha: number): void; reset?(): void }
interface DamageEvent { kind: 'blunt'|'blast'|'cut'; shape: DamageShape /* sweep | sphere | plane */; energyJ: number;
  impulseNs: number; generation: number; source: { type: 'hero'|'actor'|'power'|'projectile'|'scenario'; id: number } }
interface Damageable { applyDamage(ev: DamageEvent): DamageResult }   // buildings now; hero and enemies later
const enum NodeState { Intact, Crushed, Detached }                   // only moves forward, which fixes v1's stump re-hit bug
declare function planCrush(g: SupportGraph, ev: DamageEvent, t: DestructionTuning): CrushPlan;                    // core, pure
declare function checkSupport(g: SupportGraph, island: Island, fromStorey: number, t: DestructionTuning): Verdict; // core, pure
```

- **Events** (typed, queued, flushed once per step):
  - `hero:hit`
  - `structure:strain`, `structure:crushed`, `structure:failed`
  - `actor:impact`, `actor:breakup`
  - `rubble:contacts`, `collapse:energy`
  - `power:slam`, `power:grab`, `power:throw`
  - `world:restart`

## Destruction model: rules decide, Rapier moves

1. **Blueprint (core, pure).** Levels go tier → storey → chunk.
   - Storey height = tier height / round(h/3.7 stone or 3.45 glass), anchored at the tier base, so one storey = one window row.
   - Bays are whole window columns (stone 2 × 2.9 m, glass 4 × 1.6 m), so breaks fall on floor lines and mullions.
   - Footprints are convex polygons: rotated rectangles, 16-sided rounds, and the twist tower's 62 rotated slabs (real colliders replace its stand-in cylinder).
   - Podiums are fixed anchors.
   - Crowns, spires, beacons and roof kit are ornaments: they ride their storey and snap off on hard contact.
2. **Strength that scales with building size:** storey capacity = reserve × dead load above.
   - A storey fails in compression when its surviving area / intact area < 1/reserve.
   - Crush energy per m³ sets the hole size, so outcomes follow impact energy vs. building size.
3. **Damage = the crush planner.**
   - A hero hit bores a tunnel (hero radius + 1.5 m), then spends the remaining energy from the **exit face inward** (a blow-out cone), capped at 80% of the path depth.
   - The entry-side hinge strip survives, so the top falls forward along the flight path, in view, instead of back onto the camera.
   - Blasts use a sphere.
   - Crushed nodes become debris bodies, particles and dust, and their colliders are removed.
4. **Support check (core, pure):** from the lowest damaged storey upward, using prefix sums of the load above.
   - Compression is checked by the area ratio.
   - Overturning is checked by whether the centre of mass leaves the hull of the remaining support.
   - An off-centre failure crushes the edge on the centre-of-mass side and re-checks (≤ 8 passes). Off-centre damage topples; centred damage (slam, dive-bomb) pancakes.
   - `strain` fires from a load ratio of 0.7, so towers groan before they go.
5. **Motion:** a failing interface turns everything above it into a fragment actor.
   - The actor is a dynamic body with ≤ 6 band colliders, spawned with 2 cm clearance and CCD on.
   - Rapier tips it over the stump edge; there's no scripted pivot.
   - Hinge rule: past 6° of tilt, crush the hinge chunks.
   - Unanchored islands under 30 m³ become particles.
6. **Secondary fracture:**
   - Breakup: contact energy ≥ 0.3 × a band's crush energy splits the actor into bands, and the band at the contact expands into chunks.
   - Pancake: crush ahead analytically before the step. If a contact still stopped the actor, restore v·M/(M+0.5m).
   - Dominoes emerge: an actor hitting a building sends a generation+1 `DamageEvent` at 0.5× energy.
7. **Limits:**
   - Generation ≤ 2.
   - 3 concurrent collapses on desktop, 2 on phone.
   - A 1.5 s cooldown per building.
   - Pancakes capped at 40 storeys (20 on phone).
   - Past a cap, a "demolition sink" plays: a scripted settle plus dust, with no bodies.
8. **Activation:** lazy.
   - First damage creates storey nodes (≤ 160). Only damaged storeys ±1 expand to chunks.
   - Collider creation has a per-step quota, and the rest queues.
   - One warm-up collapse in a scratch world at load readies the code paths and shader variants.
9. **Restart:** `world.free()` + `World.restoreSnapshot()` of the pristine city (handles unchanged), plus the pristine instance buffers and cleared scorch.

**One fixed step:**

| # | Phase | What happens |
|---|---|---|
| 1 | Hero | flight model integrates; up to 3 sweeps; a hit calls `applyDamage` (activate → crush plan → remove colliders → burst / dent / glance) |
| 2 | Apply | islands via union-find; support check; failures → actors; hinge rule; pancake crush-ahead; activation queue drained within quota |
| 3 | Physics | snapshot pre-step velocities; `world.step(queue)` |
| 4 | Contacts | drain force events; keep the strongest per owner pair; localize ≤ 32 with `contactPair`; energy = ½·m_real·v_rel² from the snapshot (never raw solver forces); cluster by 8 m and 50 ms |
| 5 | Fracture | breakup, pancake accretion, generation+1 damage, projectile damage |
| 6 | Governor | sleep scan over 1/8 of bodies per step; freeze after 1 s asleep; cull the oldest/farthest over budget; delete below y = −5; shrink budgets 20% if physics p95 runs over |
| 7 | Sync | poses → interpolation buffers; dirty instance ranges; flush events |

Typical cost: physics 1–3 ms, destruction < 0.5 ms, activation about 1 ms per 150 colliders (quota-bound).

**Starting tuning** (`content/tuning/destruction.json`; phone values after "/"):

| Key | Start |
|---|---|
| Punch mass | 60 t (≈48 MJ at 40 m/s, ≈350 MJ at 108 m/s); dent/break speed 12/40 m/s as in v1 |
| Crush energy per m³ | glass 80 kJ · stone 120 kJ · landmark 150 kJ |
| Reserve | glass 1.7 · stone 2.2 · landmark 2.5 · podium ∞ |
| Bulk density (kg/m³) | glass 260 · stone 330 · crown 400 · debris (solver) 1,600 |
| Blow-out | half-angle 25°→60° over 40→110 m/s; ≤ 0.8 of path depth; hinge crush at 6° |
| Breakup | fraction 0.3 · bands per breakup 4 / 2 |
| Pancake | accretion 0.5 · max storeys 40 / 20 |
| Chains | generation decay 0.5 · max generation 2 · building cooldown 1.5 s |
| Solver mass | m_sim = 50 t·√(m/50 t), so ratios stay ≤ ~30:1 |
| Dominance | section +1 · chunk 0 · debris −1 |
| Force-event threshold | 3·g·m_sim (sections, chunks) · 5·g·m_sim (debris) |
| Debris | nudge cap 25 m/s |
| Rubble | freeze after 1 s asleep; lives 25 s / 15 s, then a 3 s sink; islands below 30 m³ / 80 m³ → particles |

**Expected outcomes** (asserted in the sim tests):
- 30 m glass tower: a hole at 40 m/s; stands and groans at 55; topples at 70 and 108.
- 15 m stone block: topples from 50 m/s.
- Spire: the base survives a boost hit; the upper tiers topple.
- Round tower: needs 2–3 hits.

**Budgets:**

| Budget | Desktop | Phone |
|---|---|---|
| Awake bodies | 600 | 200 |
| Dynamic colliders | 3,000 | 900 |
| Colliders created per step | 300 | 100 |
| Debris bodies | 350 | 100 |
| Particle debris | 1,500 | 600 |
| Chunk instances | 12,000 | 4,000 |
| Dust puffs | 600 | 250 |
| Glass shards | 1,500 | 500 |
| Audio voices | 32 | 16 |
| Physics step p95 | 5 ms | 7 ms |

## Physics integration (`@dimforge/rapier3d-compat` 0.20.0, pinned; wasm inlined, about +2.7 MB)

| Object | Body | Colliders | Groups: member → collides with |
|---|---|---|---|
| Building / stump | fixed, one per building | box per piece (with yaw), cylinders, cones, twist boxes; after activation: band + chunk boxes | CITY → ACTOR, CHUNK, DEBRIS, QUERY |
| Ground | fixed | flat city: cylinder slab (radius 1,300 m, 24 m thick, top at y = 4) so corners can't tunnel; elsewhere: the terrain height grid | GROUND → ACTOR, CHUNK, DEBRIS, QUERY |
| Falling section | dynamic, dominance +1, CCD, contact-force events | ≤ 6 band boxes/cylinders, compressed mass | ACTOR → everything |
| Chunk | dynamic, dominance 0, contact-force events | 1–4 boxes | CHUNK → everything |
| Debris | dynamic, dominance −1, contact-force events (audio only) | one 1.5–4 m box | DEBRIS → CITY, GROUND, ACTOR, CHUNK (+DEBRIS on desktop) |

- **Hero: query-only, not a body.** (A kinematic hero would fling debris at up to 146 m/s.)
  - `castShape` sweeps a ball with identity rotation, `stopAtPenetration`, and a predicate: alive, and not within v1's 0.25 s exclusion keyed by building id.
  - An overlap at t = 0 pushes out via `projectPoint`.
  - Nearby debris gets capped nudges.
- **Queries:**
  - Camera: `castRay` (CITY + sections).
  - `floorAt`: a downward `castRay`.
  - `nearestSurface`: `projectPoint`.
  - Blast gathering: `intersectionsWithShape`.
  - `groundHeight` stays analytic.
  - The alive filter covers query staleness: new or removed colliders only update at the next step.
- **Freeze / unfreeze:** `setBodyType(Fixed, false)` / `setBodyType(Dynamic, true)` when damage lands nearby.
- **Step:** 1/60 s, 4 solver iterations, g = −9.81. `RAPIER.init()` starts at boot, in parallel with city generation.
- **Contract tests (Node) pin Rapier's conventions:**
  - normal and witness spaces
  - force events + localization
  - dominance
  - freeze/unfreeze
  - snapshot keeps handles
  - query staleness
  - two-sided group encoding
- **Determinism:** seeded random streams per subsystem. Golden hashes compare two runs in one process; tolerance checks everywhere else. No deterministic Rapier build.

## Rendering the destruction

- **One facade material** for intact pieces, bands and chunks, computed in building space.
  - Per-instance data: column offset within the tier, the tier's column counts, a 6-bit exterior-face mask, and v1's seed and style.
  - Street-level grime keys off building height, so falling chunks keep their look.
  - Activation never pops (checked by a pixel diff).
- **Fracture faces:** dark concrete, floor-slab lines, rebar flecks.
- **Instance pools** (intact / band / chunk) attach to bodies, with partial GPU uploads.
- **Dust:** a surge that rolls along the 72 m street grid after big impacts, and horizontal jets out of every crushed storey. Engulf culling and near-camera fades are kept.
- **Glass and particles:** glass shard sprites with glints, plus particle debris.
- **Camera:** two-band shake (low rumble + sharp impact); slow-mo + FOV kick on the first big failure.

## Collapse sound

- **Engine:**
  - Buses (sfx / sub / ambience) into a master limiter.
  - Procedural "street canyon" reverb: early reflections off facades plus a 2.5 s tail, with the wet level falling as you climb.
  - Ducking under booms; a low-pass dip during slow-mo.
- **Spatial voice:** recipe → air-absorption low-pass → equal-power panner, gain 1/(1+d/ref) → bus.
  - Speed-of-sound delay d/343 (capped at 5 s). The listener follows the camera.
- **Voice limiter:** 32 voices on desktop, 16 on phone, loudness priority, steals the quietest, clusters contacts.
- **Noise bank:** looping white, pink and brown noise, seeded. This fixes the truncation bug class.

| Recipe | How | Driven by |
|---|---|---|
| Modal impact | noise excitation → 4-mode resonator bank; ratios: concrete 1/1.7/2.9/4.1, glass 1/2.32/4.25/6.63, steel 1/2.76/5.40/8.93; bigger = lower | `actor:impact` |
| Crack + rebar snap | 1–3 ms click, high-passed tail, 30% steel ping | `structure:crushed` |
| Steel groan | detuned low saws, swept resonant filter, stick-slip pulses, high creaks | `structure:strain`; actor angular speed |
| Rubble grains | Poisson scheduler (≤ 400/s) over 32 pre-rendered grain buffers | `rubble:contacts` |
| Rumble bed | looping brown + pink noise, low-passed | `collapse:energy` |
| Glass cascade | decaying burst of glass modes; "glass rain" arrives √(2h/g) later | glass storeys failing |
| Ground boom | sub sweep 55→24 Hz + thump + grain spray; ducks the mix | ground impacts |
| Dust whoosh | band-passed pink swell | dust front passing the listener |

## Powers

- **Ground slam** (Q · gamepad Y · touch "Slam"):
  - States: `ready → windup 0.25 s → dive (1.6× boost speed; instant under 20 m) → impact → recover 0.6 s → cooldown 2 s`.
  - Impact sends a `blast` sphere event with radius 25–60 m, scaled by dive speed.
  - Radial nudges fall off as (1−d/R)²; base crushes topple nearby towers.
  - Effects: shockwave ring, street dust ring, ground boom.
- **Grab and throw** (E · gamepad X · touch "Grab"):
  - Grab takes the best chunk or debris piece within 12 m ahead under a mass limit, including frozen rubble.
  - While held, it follows a spring-damped hold point. Its groups skip debris, and the hero is slightly slower.
  - A second press throws it: velocity = hero velocity + camera forward × 80 m/s, CCD on.
  - For 5 s it's a projectile, so its contacts become `blunt` events. This is the first combat primitive.
  - Ramming a building while holding adds the chunk's mass to the smash, and the chunk shatters.
- **Other:** gamepad "view" moves to D-pad up. The HUD gets cooldown rings, a hold reticle and an updated key legend.
- **Free bonus:** falling sections are damageable, so you can punch a falling top apart.
- **Poses:** both powers' poses come from the pose graph (Character revision). The first-person arm versions are in First-person upgrade.

## Character revision

**The hero is data** (`content/heroes/<id>.json`), the step toward "any superhero":
- **`look`:** palette (suit, trim, accent, cape, skin, hair); build (height 1.7–2.1 m, shoulders, bulk); cape length/width, or none; emblem (diamond / star / bolt / ring); mask (none / domino / cowl); hair style.
- **`flight`:** multipliers on the flight tuning (speeds, turn rate).
- **`powers`:** loadout plus overrides (slam radius, throw speed, grab mass limit).
- **Three original presets:**
  - **Aurora:** v1's ivory, gold and crimson look; balanced.
  - **Bastion:** charcoal and teal, heavy build, no cape; slam ×1.3, speed ×0.9.
  - **Swift:** navy and yellow, light build, short cape; speed ×1.15, slam ×0.8.
- Adding a hero = one JSON file.

**Rig and model** (still procedural, no asset files):
- About 24 joints: v1's 17 plus `spine2`, clavicles, and a finger group + thumb per hand.
- Hands take fist, open and grip poses (needed for grab/throw and for first person).
- The build drives heroic proportions: V-taper torso, deltoids, traps; boots with soles; cowl, mask and hair variants; extruded emblems.
- **One rigid-skinned `SkinnedMesh` per material.** Each vertex binds to its joint, with soft 2-bone weights at the shoulders, elbows, hips and knees.
  - That's ≤ 4 draw calls instead of ~40 meshes, and no gaps at the joints.
- **Suit detail in the shader:** panel seams and a faint weave from object-space coordinates. The emblem glows while boosting or charging a slam.
- **Materials:** built per hero by a factory (v1 used module-level singletons). The rim light is shared through the patch registry.

**Pose graph** (`core/hero-pose-graph.ts`, pure; its Godot counterpart is an AnimationTree):
- Takes flight and power state, and outputs weights over a pose library (`content/heroes/poses.json`).
- **Poses:**
  - `hover`, `cruise` (one fist forward), `boost` (both fists, streamlined)
  - `dive` (arms swept back), `brake` (upright, arms flared)
  - `burst` (a shoulder charge when breaking through a building), `glance` (brace)
  - `slamWindup`, `slamLand` (the superhero landing: one knee down, fist in the street)
  - `grabReach`, `hold` (overhead carry), `throwWindup`, `throwRelease`
- **Transitions:** critically damped springs per joint give anticipation, a small overshoot and a sense of weight, replacing v1's linear blend.
- **Additive layers:** bank lean, arm drift from steering, breathing, boost flutter.
- **Head look-at:** toward the grab target, a failing tower within 400 m, or the free-look direction.

**Cape:** length and width per hero; a no-cape hero skips the cloth sim. Slam impacts and burst-throughs kick the cloth.

**Hero select:** on the title screen (the showcase camera already exists). ←/→ or a tap cycles presets, and the choice is saved in settings.

## First-person upgrade

- **You see your body.** A first-person arms pass renders the hero's own arms and hands, built by the same rig builder.
  - It draws in a camera-attached scene with a fixed 60° FOV and cleared depth, after the world and before post-processing.
  - So the arms never clip into walls, and bloom and tone mapping match the world. They're lit by the same sun and sky colours.
- **Arm poses follow the pose graph:**
  - cruise: one fist at the lower right; boost: both fists forward; hover: hands at the bottom edge
  - slam: fist raised, then driven down
  - grab/hold: the chunk carried in view; throw: arm swing
- **Look where you fly:** the first-person view follows 100% of the flight pitch with a small lag. The chase camera keeps its 0.82 share.
- **Free look:** hold F (keyboard/mouse) · right stick (gamepad) · two-finger drag (touch).
  - The head turns up to ±110° left/right and ±70° up/down without changing the flight path, and springs back in 0.35 s.
  - Throws follow the view direction, so you throw where you look. The third-person hero's head follows the same direction.
- **Comfort settings (saved):**
  - Roll share: default 0.5 in first person (chase stays 0.28), adjustable 0–1.
  - Horizon-lock toggle.
  - Max FOV, default 90°.
  - Reduced motion scales buffet and shake to 35%, as v1 does.
- **Feel:**
  - Boost punch: a short FOV kick and a pressure vignette.
  - Glance: a directional jolt along the wall normal instead of random shake.
  - Burst-through: a flash, debris streaming past the lens, a close crack.
  - Sea skim: spray droplets bead on the visor and clear with speed.
  - The dust veil and near-camera cutaways are tuned for the 0.12 m near plane.
- **Visor HUD** (first person only, minimal):
  - Speed and altitude ticks at the edges.
  - Power cooldown arcs around a centre reticle.
  - A grab highlight on the target chunk.
  - During a slam windup, an impact marker projected on the ground (both views).
- **Switching views:** chase ↔ first person dollies with an FOV morph. The body hides past a 0.6 blend (as v1 does), and the arms fade in from 0.7.

## Godot 4.7 pivot, always on

1. **Portable core:** the lint and tsconfig boundaries keep `core/` free of Rapier, the DOM and rendering.
2. **Shared content:** `content/*.json` is the only tuning source, with TS types plus runtime validation; Godot reads the same files.
3. **Conformance vectors:** `npm run conformance:write` generates them from the TS core. Web tests assert the committed vectors, so they never drift.
4. **`godot/` scaffold:**
   - `project.godot`: 4.7, Jolt, 60 ticks, an input map mirroring the web actions, `Content` and `Events` autoloads.
   - `core/flight_model.gd` is ported now as the proof, with sim math in scalar 64-bit floats (Godot's `Vector3` is 32-bit) and documented tolerances.
   - `tests/conformance_runner.gd` runs headless.
5. **"At all times":** the CI `godot` job downloads 4.7.2 headless, syncs the JSON, and runs every ported vector on each push. Other core modules port only at pivot time, mechanically, against their vectors.
6. **`docs/godot-pivot.md`:** a concept map and the porting order.
   - features → scenes/autoloads; event bus → signals; fixed step → `_physics_process`.
   - Compound colliders → `CollisionShape3D` children; force events → Jolt contact monitoring.
   - InstancedMesh → MultiMesh; GLSL → Godot shaders.
   - Audio recipes → WAVs from the offline render.

## Reuse from v1 (`/home/user/flight/src`)

- **Port nearly as-is (add types):**
  - `input-controls.js` (+ slam, grab, free-look actions), `cape-cloth.js` (+ per-hero size, impulse kicks)
  - `post-pipeline.js`, `sky-dome.js`, `ocean-surface.js`, `cloud-field.js`
  - `particle-pool.js`, `seeded-noise.js`, `scalar-math.js`
  - `flight-tuning.js` → `content/tuning/flight.json`
- **Port with changes:**
  - `flight-model.js`: `#resolveWorld` uses `sweepSphere`.
  - `atmosphere.js`: a typed patch registry plus a test that each of the 16 three.js anchors still exists.
  - `hero-figure.js`: ported as-is in M1 for parity, then rebuilt in M6 as the data-driven rig. Its joint layout, the `fly`/`hover` poses, the rim light and the cape anchors are the starting point.
  - `chase-camera.js`: ported in M1; M8 adds view state, free look, comfort settings and the first-person arms.
  - `island-terrain.js`: height grid → ground collider.
  - `city-skyline.js`: generation → `core/city-blueprint.ts`, plus the meshes and the building-space facade.
  - `dust-plumes.js`: surge and jets.
  - `speed-effects.js`, `hud-overlay.js`, `index.html`, `styles.css`.
- **Replace:**
  - `main.js` → composition root.
  - `flight-audio.js` → engine + recipes; the v1 sounds become presets.
  - `city-destruction.js` and `debris-field.js` → the `core/` graph + `sim/` destruction.
- **Tests and tooling:**
  - Port `tests/flight-model.test.js` and `tests/cape-cloth.test.js`.
  - The scratch `shoot.mjs` pattern (proxy bypass, font routing, `?test` API) becomes `web/scripts/screenshots.ts`.

## Build order: the coding binge

One continuous run. Each milestone ends playable, is verified, updates `docs/now.md` and the build ledger, and is committed and pushed to `claude/compassionate-mendel-ypd9fk`. (Open PR #1 grows; merge it first if you want v2 as its own PR.)

| M | Result | Size | Done when |
|---|---|---|---|
| M0 | Folder, docs, CI; tooling (TypeScript 6.0 strict, since typescript-eslint supports < 6.1 and 7.0 waits; Vite 8.3 + singlefile; Vitest 5.0; ESLint 10 boundaries; Playwright 1.63 launching the preinstalled Chromium via `executablePath`); engine core; flight model + input + chase camera over grey-box ground; flight vectors + Godot scaffold + `flight_model.gd` | 1 | `npm run check` green; ported v1 flight tests pass; frame pacing at 30/60/144 Hz gives identical sim state after 10 s; slow-mo steps every 8–9 frames; `npm run godot:check` passes |
| M1 | Full look; city blueprint + storeys; building-space facade + instance pools; v1 grid collision as a temporary stand-in; v1 audio ported with looping noise + uncapped delay | 3 | blueprint digest equals v1 (2,648 ids, same sizes); 4 fixed shots vs v1 baselines within 3% pixel diff, desktop + 390×844; no-pop ≤ 0.5%; rumble render stays above −60 dB for ≥ 5 s |
| M2 | Rapier: ground, static city, queries, hero sweep, snapshot restart, contact harvester, governor v0; grid removed | 2 | Rapier contract tests in Node; flight tests against a Rapier tower match v1 outcomes; `perf:physics` p95 ≤ 2 ms; state hash equals pristine after 3 collapses + restart |
| M3 | Full destruction: graph, crush planner, support check, actors, hinge, breakup, capped pancake, dominoes, quotas, warm-up, all building kinds; chunks rendered; vectors for storey layout, crush plan, support check | 5 | outcome matrix (widths 15/30/46 m × 40/55/70/108 m/s); topple along the flight direction (dot ≥ 0.7); first ground hit 2.5–9 s; hero keeps ≥ 0.74× speed; pancake ≥ 10 storeys, stump top only descends; round/twist/spire runs: no NaN, nothing below ground, no energy gain; 5 simultaneous collapses stay in budget, p95 ≤ 5 ms; stump re-hit regression; equal hashes at steps 60/300/900; stills (hit, 15° tilt, mid-fall, landing) on desktop + phone |
| M4 | Fracture faces, dust surge + jets, glass, particles, two-band shake, slow-mo + FOV kick, near-camera fades | 2 | screenshot set; camera engulfed in dust keeps mean luminance 0.15–0.85; phone-profile budgets hold |
| M5 | Audio engine, reverb, spatial voices, limiter, recipes, soundscape mapping | 2.5 | offline renders: peak ≤ −1 dBFS, no NaN; the roar outlasts its drive by 2 s, boom ≥ 2.5 s; centroids: concrete 0.3–1.2 kHz, glass 3–7 kHz, groan 80–400 Hz; 1,000 contacts/s stays ≤ 32 voices; 1,000 m arrives 2.77 s after 50 m and ≥ 18 dB quieter; WAVs sent to you |
| M6 | **Character revision:** hero JSON + 3 presets; rig builder (~24 joints, hands, rigid-skinned meshes); pose library + pose graph with springs and head look-at; per-hero cape; hero select | 2.5 | all presets validate; pose-graph tests (weights in [0,1] summing to 1, springs settle with ≤ 5% overshoot, no NaN); pose-graph vectors pass in Godot; stills of each preset × {hover, cruise, boost, dive, brake, burst, slamLand, hold}, desktop + phone; hero ≤ 4 draw calls, ≤ 30k triangles, rig update < 0.2 ms |
| M7 | Powers: ground slam, grab and throw, input, HUD; vectors for the power timelines | 2.5 | state-machine tests; slam fails ≥ 3 buildings with generation ≤ 2 inside budgets; an 80 m/s throw topples a 15 m block; ramming with a held chunk shatters it; slam ends in `slamLand` |
| M8 | **First-person upgrade:** arms pass, look-where-you-fly, free look, comfort settings, boost/glance/burst feel, visor droplets, visor HUD + reticle, view transition | 1.5 | view-state tests (free look never changes the flight path; limits; 0.35 s spring-back; comfort applied; body/arms visibility rule); sim test: a throw during free look leaves within 2° of the view; stills: first person in cruise/boost/hover/slam/hold, pressed against a wall (arms fully visible, no clipping), sea-skim droplets, burst frame (debris covers < 30%); settings persist across reload |
| M9 | Polish + ship: demo-scenes menu (title + pause → topple, pancake, domino, slam, throw), settings (destruction intensity, quality presets), adaptive quality, docs, size gate ≤ 4.0 MB, artifact | 1 | all checks green; new artifact link published |

## Verification

All commands run in `aloft-v2/web`.

| Command | What it checks |
|---|---|
| `npm run check` | typecheck + lint + unit + Node sim tests (contracts, scenario outcomes, invariants, determinism, budgets) + build + size gate |
| `npm run e2e` | Playwright stills at desktop and 390×844: world, collapses, hero presets and poses, first-person views; no-pop diff; dust luminance; first-person clipping and coverage checks |
| `npm run audio:render` | OfflineAudioContext renders; the M5 assertions; WAV files |
| `npm run perf:physics` | Node p50/p95 per scenario against budgets. In-game, F3 shows bodies and step ms |
| `npm run godot:check` | cached Godot 4.7.2 headless runs the conformance vectors |

- **CI:** runs `check`, `e2e`, `audio:render` and `godot:check`.
- **Final ship check:** build, serve `dist/`, play `?test` and `?scenario=…`, publish the artifact.
- **Real-device fps:** your check on the link. SwiftShader here can't measure it.

## Risks → mitigations

| Risk | Mitigation |
|---|---|
| Collapses don't read (wrong direction, too slow, just stands) | blow-out crush, off-centre crush, hinge rule; outcome matrix + timing assertions; gravity-scale lever |
| Solver pops or tunnelling | mass compression + dominance, spawn clearance, CCD, solid ground slab, energy check |
| Activation hitches | three-level lazy nodes, per-step quotas, warm-up collapse, spire-base perf test (< 2 ms) |
| Phone CPU/GPU | budget table, 2 steps per frame with time shedding, no debris-on-debris collisions, particle fallback |
| Rapier 0.20 is 7 weeks old and just changed repos | exact pin, one adapter, loud contract tests |
| Runaway chains | generation cap, concurrency cap, cooldowns, demolition sink, intensity setting |
| Audio overload or clipping | limiter, voice cap, clustering, pre-rendered grains, offline test suite |
| Push refused for the workflow file (app permissions) | keep it at `aloft-v2/ci/` and ask you to move it |
| Godot download blocked | the CI job still runs it (github.com was reachable when checked) |
| First-person arms look pasted on | same sun and sky lighting, drawn before post so bloom and tone mapping match; cleared depth stops clipping |
| Motion sickness in first person | comfort defaults (roll 0.5, max FOV 90°, horizon lock), reduced motion, directional jolts instead of random shake |
| The new rig looks worse than v1 | v1's poses and proportions are the baseline; preset × pose stills are reviewed each run; Aurora keeps v1's palette |

## Out of scope (next rounds)

- Sky enemies (`Damageable` + koota).
- A full hero editor (presets only for now), facial animation, cape tearing.
- The beam slice.
- Missions and saves.
- WebGPU.
- Patching the v1 bugs in place (v2 fixes them by design).
