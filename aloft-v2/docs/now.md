# Now

- **Milestone:** M0–M4 done (look, Rapier, destruction, collapse visuals) → next M5 (collapse sound).
- **Last verified:** `npm run check` green (136 tests incl. Rapier sim scenarios), `npm run e2e` green
  on desktop + phone (smash → topple → collapse → rubble stills, no-pop, dust engulf luminance).
- **Next steps:**
  - M5: audio engine (buses, limiter, street-canyon reverb, spatial voices with distance delay),
    recipes (modal impacts, cracks, groans, rubble grains, rumble bed, glass cascade, ground boom),
    offline render checks + WAVs.
  - Open M3 items: explicit round / twist / spire scenario tests; 5-collapse perf in the browser
    (Node p95 ≈ 6 ms for 3 smashes; lever = debris budget); delete `sim/city-collision-grid.ts`.
