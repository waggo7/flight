import { serviceToken } from '../engine/service-registry';
import type { GameWorld } from '../sim/world-contracts';

// The world the hero flies through: grey boxes (M0), the ported city (M1), Rapier (M2+).
export const WorldToken = serviceToken<GameWorld>('world');
