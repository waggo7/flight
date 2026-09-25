# Now

- **Milestone:** M1 (look, city, facade) complete; M2 (Rapier) mostly done; M3 core (structure,
  crush planner, support check) done → next: M2 finish + M3 sim (fragment actors in Rapier).
- **Last verified:** `npm run check` green (129+ tests), `npm run e2e` green (desktop + phone,
  includes the no-pop check), look parity vs v1 green with per-pose tolerances.
- **Next steps:**
  - M2: contact harvester, governor v0, `perf:physics`, state hash after restart; delete the
    temporary `sim/city-collision-grid.ts` once nothing needs it.
  - M3 sim: destruction system (hero sweep → `applyDamage` → `checkSupport` → fragment actors),
    hinge rule, breakup, pancake, dominoes, activation quotas; wire the flight model's `smash`.
  - Dev overlay: physics bodies and step ms.
