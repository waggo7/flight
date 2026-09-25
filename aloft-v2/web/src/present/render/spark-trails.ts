import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { Vector3Like } from 'three';
import { CITY_PARK } from '../../core/island-terrain-height';
import { smoothstep } from '../../core/scalar-math';
import type { RandomSource } from '../../core/seeded-noise';

// Glowing sparks laid out in short trails that each tell you where to fly: down an
// avenue, around the twisting tower, over a cloud, skimming the sea, up a mountain.
// Generous pickup radius and a gentle magnet keep collecting forgiving.
// Ported from v1 (src/spark-trails.js). v1 read the city, terrain and cloud field directly;
// here everything it reads from the world comes through SparkWorld.

const PICKUP_RADIUS = 5.5;
const MAGNET_RADIUS = 24;
const CORE_COLOR = new Color(6, 3.7, 1.5);
const RING_COLOR = new Color(3.4, 2.1, 0.8);
const HALO_COLOR = new Color(1.1, 0.56, 0.2);

const haloVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vec3 center = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float scale = length(instanceMatrix[0].xyz);
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 world = center + (camRight * position.x + camUp * position.y) * scale;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const haloFragment = /* glsl */ `
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float glow = pow(max(1.0 - d, 0.0), 2.4);
  gl_FragColor = vec4(uColor * glow, 1.0);
}
`;

/** A cloud a trail can skim over (v1's CloudField cloud records fit). */
export interface SparkCloud {
  /** Centre on the ground plane, metres, where the cloud was generated (before any drift). */
  readonly x: number;
  readonly z: number;
  /** Height of the cloud's highest puff top, metres. */
  readonly top: number;
  /** Radius scale of the cloud, metres. */
  readonly size: number;
}

/** A landmark tower (CityBlueprint's LandmarkSpec fits). */
export interface SparkLandmark {
  /** Centre of the tower's footprint, metres. */
  readonly x: number;
  readonly z: number;
  /** Height of its highest point, metres; the spire's crown falls back to 480 without it. */
  readonly top?: number;
}

/**
 * Everything the spark trails read from the world, and nothing more. The first four are read
 * once, while the trails are laid out in the constructor; `cloudDrift` is read every update.
 */
export interface SparkWorld {
  /**
   * True when no building surface lies within `radius` metres of `position`. Layout nudges a
   * spark up in 6 m steps (at most 40) until this holds. v1: CitySkyline.isClear.
   */
  isClear(position: Vector3, radius: number): boolean;
  /** Ground height at (x, z), metres (negative out at sea). IslandHeights.heightAt fits. */
  heightAt(x: number, z: number): number;
  /**
   * The largest cloud whose generated centre lies within `maxDistance` metres of (x, z) on the
   * ground plane, or null if none does; without one the cloud trail is left out.
   * v1: CloudField.largestCloudNear.
   */
  largestCloudNear(x: number, z: number, maxDistance: number): SparkCloud | null;
  /**
   * How far the clouds have drifted on the wind since the start, metres; the cloud trail moves
   * with it. Must be current at every update (return the cloud field's live vector).
   * v1: CloudField.drift.
   */
  readonly cloudDrift: Vector3Like;
  /**
   * The twisting tower, which a trail spirals around, and the spire (the tallest tower), whose
   * needle a trail crowns 70 m below `top`. CityBlueprint.landmarks fits.
   */
  readonly landmarks: { readonly twist: SparkLandmark; readonly spire: SparkLandmark };
}

export interface SparkTrail {
  readonly name: string;
  readonly sparks: Spark[];
  /** Trails over a cloud move with the cloud drift. */
  readonly drifts: boolean;
}

export interface Spark {
  /** Where it rests, before drift and bobbing. */
  readonly base: Vector3;
  /** Where it is now: bobbing, drifting, and pulled toward the hero by the magnet. */
  readonly position: Vector3;
  collected: boolean;
  /** 0 → 1 through the pickup pop. */
  pop: number;
  readonly phase: number;
  readonly trail: SparkTrail;
  /** Instance index in the meshes. */
  readonly index: number;
}

export interface SparkCollectEvent {
  readonly type: 'collect';
  readonly position: Vector3;
  /** Pickups in a row, each within 3.5 s of the last (0 for the first). */
  readonly streak: number;
  readonly trailDone: boolean;
  readonly trailName: string;
  readonly trailsDone: number;
  readonly allDone: boolean;
}

/** All sparks came back, 6 s after the last one was collected. */
export interface SparkRespawnEvent {
  readonly type: 'respawn';
}

export type SparkEvent = SparkCollectEvent | SparkRespawnEvent;

export interface SparkTrailsOptions {
  /** Numbers in [0, 1) for each spark's bob and pulse phase (default Math.random). */
  random?: RandomSource;
}

export class SparkTrails {
  readonly sparks: Spark[] = [];
  readonly trails: SparkTrail[] = [];
  readonly total: number;
  collected = 0;
  streak = 0;
  lastCollectTime = -Infinity;
  respawnAt = Infinity;
  readonly group = new Group();
  readonly core: InstancedMesh;
  readonly ring: InstancedMesh;
  readonly halo: InstancedMesh;

  private readonly random: RandomSource;
  private readonly matrix = new Matrix4();
  private readonly quat = new Quaternion();
  private readonly scale = new Vector3();
  private readonly pos = new Vector3();
  private readonly axis = new Vector3(0.3, 1, 0.2).normalize();

  constructor(
    private readonly world: SparkWorld,
    { random = Math.random }: SparkTrailsOptions = {},
  ) {
    this.random = random;
    this.layOut(world);
    this.total = this.sparks.length;
    this.group.name = 'sparks';
    const { core, ring, halo } = this.buildMeshes();
    this.core = core;
    this.ring = ring;
    this.halo = halo;
  }

  private addTrail(name: string, points: readonly Vector3[], { drifts = false }: { drifts?: boolean } = {}): void {
    const trail: SparkTrail = { name, sparks: [], drifts };
    for (const point of points) {
      const spark: Spark = {
        base: point.clone(),
        position: point.clone(),
        collected: false,
        pop: 0,
        phase: this.random() * Math.PI * 2,
        trail,
        index: this.sparks.length,
      };
      trail.sparks.push(spark);
      this.sparks.push(spark);
    }
    this.trails.push(trail);
  }

  private layOut(world: SparkWorld): void {
    const clear = (p: Vector3, minY = 0): Vector3 => {
      // Nudge upward until the spark floats in open air.
      for (let tries = 0; tries < 40 && !world.isClear(p, 7); tries++) p.y += 6;
      p.y = Math.max(p.y, world.heightAt(p.x, p.z) + 8, minY);
      return p;
    };

    // 1. Down the avenue between the downtown towers.
    const avenue: Vector3[] = [];
    for (let k = 0; k < 7; k++) {
      avenue.push(clear(new Vector3(-36 + Math.sin(k * 1.3) * 3.5, 56 + k * 6, -612 + k * 96)));
    }
    this.addTrail('avenue', avenue);

    // 2. A rising spiral around the twisting tower.
    const twist = world.landmarks.twist;
    const spiral: Vector3[] = [];
    for (let k = 0; k < 9; k++) {
      const angle = k * 0.85;
      spiral.push(clear(new Vector3(twist.x + Math.cos(angle) * 54, 150 + k * 32, twist.z + Math.sin(angle) * 54)));
    }
    this.addTrail('spiral', spiral);

    // 3. A crown around the needle of the tallest tower.
    const spire = world.landmarks.spire;
    const crownY = (spire.top ?? 480) - 70;
    const crown: Vector3[] = [];
    for (let k = 0; k < 6; k++) {
      const angle = (k / 6) * Math.PI * 2;
      crown.push(clear(new Vector3(spire.x + Math.cos(angle) * 40, crownY + Math.sin(angle * 2) * 6, spire.z + Math.sin(angle) * 40)));
    }
    this.addTrail('crown', crown);

    // 4. Over the top of a big cloud (these drift with the wind).
    const cloud = world.largestCloudNear(0, 0, 3200);
    if (cloud) {
      const tops: Vector3[] = [];
      for (let k = 0; k < 6; k++) {
        const t = k / 5 - 0.5;
        tops.push(new Vector3(cloud.x + t * cloud.size * 1.4, cloud.top + 14 + Math.sin(k) * 5, cloud.z + t * cloud.size * 0.3));
      }
      this.addTrail('cloud', tops, { drifts: true });
    }

    // 5. Skimming the sea toward the western island.
    const seaDir = new Vector2(-0.91, -0.41).normalize();
    const sea: Vector3[] = [];
    for (let k = 0; k < 7; k++) {
      const d = 1560 + k * 85;
      const p = new Vector3(seaDir.x * d + Math.sin(k * 0.9) * 10, 6, seaDir.y * d);
      p.y = Math.max(6, world.heightAt(p.x, p.z) + 6);
      sea.push(p);
    }
    this.addTrail('sea', sea);

    // 6. A ring around the big mountain's summit.
    const summit = { x: 3350, z: 2550, y: 0 };
    for (let dx = -600; dx <= 600; dx += 40) {
      for (let dz = -600; dz <= 600; dz += 40) {
        const h = world.heightAt(3350 + dx, 2550 + dz);
        if (h > summit.y) {
          summit.x = 3350 + dx;
          summit.z = 2550 + dz;
          summit.y = h;
        }
      }
    }
    const peak: Vector3[] = [];
    for (let k = 0; k < 6; k++) {
      const angle = (k / 6) * Math.PI * 2;
      const x = summit.x + Math.cos(angle) * 170;
      const z = summit.z + Math.sin(angle) * 170;
      peak.push(new Vector3(x, Math.max(world.heightAt(x, z) + 35, summit.y - 40), z));
    }
    this.addTrail('peak', peak);

    // 7. A dive column dropping into the park.
    const parkX = (CITY_PARK.minX + CITY_PARK.maxX) / 2;
    const parkZ = (CITY_PARK.minZ + CITY_PARK.maxZ) / 2;
    const dive: Vector3[] = [];
    for (let k = 0; k < 6; k++) dive.push(new Vector3(parkX, 700 - k * 125, parkZ));
    this.addTrail('dive', dive);
  }

  private buildMeshes(): { core: InstancedMesh; ring: InstancedMesh; halo: InstancedMesh } {
    const count = this.sparks.length;
    const core = new InstancedMesh(new SphereGeometry(1, 16, 12), new MeshBasicMaterial({ color: CORE_COLOR }), count);
    const ring = new InstancedMesh(new TorusGeometry(1, 0.04, 6, 56), new MeshBasicMaterial({ color: RING_COLOR }), count);
    const halo = new InstancedMesh(
      new PlaneGeometry(1, 1),
      new ShaderMaterial({
        uniforms: { uColor: { value: HALO_COLOR } },
        vertexShader: haloVertex,
        fragmentShader: haloFragment,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
      count,
    );
    for (const mesh of [core, ring, halo]) {
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      this.group.add(mesh);
    }
    return { core, ring, halo };
  }

  reset(): void {
    for (const spark of this.sparks) {
      spark.collected = false;
      spark.pop = 0;
    }
    this.collected = 0;
    this.streak = 0;
    this.respawnAt = Infinity;
  }

  /**
   * Bob, drift, magnet and pickups, then write the instance matrices. `time` is the game clock,
   * seconds. Returns what happened this frame (pickups, and the respawn after all are found).
   */
  update(dt: number, time: number, heroPosition: Vector3Like, camera: { readonly position: Vector3Like }): SparkEvent[] {
    const events: SparkEvent[] = [];
    if (time > this.respawnAt) {
      this.reset();
      events.push({ type: 'respawn' });
    }
    const drift = this.world.cloudDrift;
    for (const spark of this.sparks) {
      const base = this.pos.copy(spark.base);
      if (spark.trail.drifts) base.add(drift);
      base.y += Math.sin(time * 1.3 + spark.phase) * 0.7;

      if (!spark.collected) {
        const d = base.distanceTo(heroPosition);
        const pull = smoothstep(MAGNET_RADIUS, 6, d) * 0.72;
        spark.position.copy(base).lerp(heroPosition, pull);
        if (spark.position.distanceTo(heroPosition) < PICKUP_RADIUS || d < PICKUP_RADIUS) {
          events.push(this.collect(spark, time));
        }
      } else {
        spark.position.copy(base);
        spark.pop = Math.min(1, spark.pop + dt * 3.2);
      }
    }
    this.writeInstances(time, camera);
    return events;
  }

  private collect(spark: Spark, time: number): SparkCollectEvent {
    spark.collected = true;
    spark.pop = 0;
    this.collected++;
    this.streak = time - this.lastCollectTime < 3.5 ? this.streak + 1 : 0;
    this.lastCollectTime = time;
    const trailDone = spark.trail.sparks.every((s) => s.collected);
    const allDone = this.collected === this.total;
    if (allDone) this.respawnAt = time + 6;
    return {
      type: 'collect',
      position: spark.position.clone(),
      streak: this.streak,
      trailDone,
      trailName: spark.trail.name,
      trailsDone: this.trails.filter((t) => t.sparks.every((s) => s.collected)).length,
      allDone,
    };
  }

  private writeInstances(time: number, camera: { readonly position: Vector3Like }): void {
    const m = this.matrix;
    const q = this.quat;
    const s = this.scale;
    for (const spark of this.sparks) {
      const i = spark.index;
      let scale = 1;
      if (spark.collected) {
        const t = spark.pop;
        scale = t < 0.25 ? 1 + t * 2.4 : Math.max(0, 1.6 * (1 - (t - 0.25) / 0.75));
      }
      const distance = spark.position.distanceTo(camera.position);
      const pulse = 1 + Math.sin(time * 3 + spark.phase) * 0.08;

      q.identity();
      m.compose(spark.position, q, s.setScalar(1.05 * scale * pulse));
      this.core.setMatrixAt(i, m);

      q.setFromAxisAngle(this.axis, time * 1.4 + spark.phase);
      m.compose(spark.position, q, s.setScalar(2.5 * scale));
      this.ring.setMatrixAt(i, m);

      q.identity();
      m.compose(spark.position, q, s.setScalar((9 + distance * 0.006) * scale * pulse));
      this.halo.setMatrixAt(i, m);
    }
    this.core.instanceMatrix.needsUpdate = true;
    this.ring.instanceMatrix.needsUpdate = true;
    this.halo.instanceMatrix.needsUpdate = true;
  }

  /** The nearest spark still to collect (its live position), or null when all are collected. */
  nearestUncollected(position: Vector3Like): Vector3 | null {
    let best: Spark | null = null;
    let bestDistance = Infinity;
    for (const spark of this.sparks) {
      if (spark.collected) continue;
      const d = spark.position.distanceToSquared(position);
      if (d < bestDistance) {
        bestDistance = d;
        best = spark;
      }
    }
    return best ? best.position : null;
  }
}
