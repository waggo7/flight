// Rapier interaction groups: (membership << 16) | filter. Two colliders (or a query and a
// collider) interact only if each one's membership overlaps the other's filter — so every
// collider that queries must see has QUERY in its filter (tests/sim/rapier-contract checks this).

export const Membership = {
  CITY: 1 << 0,
  GROUND: 1 << 1,
  ACTOR: 1 << 2,
  CHUNK: 1 << 3,
  DEBRIS: 1 << 4,
  QUERY: 1 << 5,
  HELD: 1 << 6,
} as const;

export const interactionGroups = (membership: number, filter: number): number => (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;

const { CITY, GROUND, ACTOR, CHUNK, DEBRIS, QUERY, HELD } = Membership;

export function collisionGroups(options: { debrisHitsDebris: boolean }) {
  return {
    city: interactionGroups(CITY, ACTOR | CHUNK | DEBRIS | QUERY | HELD),
    ground: interactionGroups(GROUND, ACTOR | CHUNK | DEBRIS | QUERY | HELD),
    actor: interactionGroups(ACTOR, CITY | GROUND | ACTOR | CHUNK | DEBRIS | QUERY | HELD),
    chunk: interactionGroups(CHUNK, CITY | GROUND | ACTOR | CHUNK | DEBRIS | QUERY | HELD),
    debris: interactionGroups(DEBRIS, CITY | GROUND | ACTOR | CHUNK | QUERY | (options.debrisHitsDebris ? DEBRIS : 0)),
    /** A carried chunk: hits buildings and big pieces, never debris (so it can't fling rubble). */
    held: interactionGroups(HELD, CITY | GROUND | ACTOR | CHUNK),
    /** The hero's sweep: buildings, sections and chunks; small debris never stops the hero. */
    heroQuery: interactionGroups(QUERY, CITY | ACTOR | CHUNK),
    /** Camera wall avoidance: buildings and big falling sections only. */
    cameraQuery: interactionGroups(QUERY, CITY | ACTOR),
    /** Blasts and grabs: anything movable. */
    movableQuery: interactionGroups(QUERY, ACTOR | CHUNK | DEBRIS),
    /** Floors under a point: ground and buildings. */
    floorQuery: interactionGroups(QUERY, CITY | GROUND),
  };
}

export type CollisionGroups = ReturnType<typeof collisionGroups>;
