import { BackSide, Color, HalfFloatType, Matrix4, PerspectiveCamera, Quaternion, Scene, ShaderLib, UniformsUtils, Vector3 } from 'three';
import type { Material, Mesh, Object3D, ShaderMaterial, WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';
import { describe, expect, test } from 'vitest';
import { CITY_PARK, IslandHeights, SEABED, TERRAIN_SEGMENTS, TERRAIN_SIZE } from '../../src/core/island-terrain-height';
import { createRandom } from '../../src/core/seeded-noise';
import { DustPlumes } from '../../src/present/render/effects/dust-plumes';
import { ParticlePool } from '../../src/present/render/effects/particle-pool';
import { SpeedEffects, type SpeedEffectsFlight } from '../../src/present/render/effects/speed-effects';
import { PostPipeline, type PostRenderer } from '../../src/present/render/post/post-pipeline';
import { ATMOSPHERE_GLSL, ATMOSPHERE_GLSL_WITHOUT_TIME, NOISE_GLSL, VALUE_NOISE_GLSL, atmosphereUniforms } from '../../src/present/render/world/atmosphere';
import { CloudField } from '../../src/present/render/world/cloud-field';
import { createIslandTerrain } from '../../src/present/render/world/island-terrain-mesh';
import { createOcean } from '../../src/present/render/world/ocean-surface';
import { createSkyDome } from '../../src/present/render/world/sky-dome';

// The world look (sky, sea, terrain, clouds, post, particles, dust, speed effects) builds in Node:
// three.js objects need no WebGL until they are drawn. These check the ports' shape and
// invariants; exact parity with v1 was verified by running both side by side when porting.
// createSkyEnvironment needs a live renderer and is covered by the browser e2e.

const allFinite = (values: ArrayLike<number>): boolean => Array.from(values).every(Number.isFinite);
const squash = (glsl: string): string => glsl.replace(/\s+/g, ' ').trim();

/** Runs a built-in material's onBeforeCompile on three's real standard shader, as the renderer would. */
function compileStandard(material: Material): WebGLProgramParametersWithUniforms {
  const shader = {
    uniforms: UniformsUtils.clone(ShaderLib.standard.uniforms),
    vertexShader: ShaderLib.standard.vertexShader,
    fragmentShader: ShaderLib.standard.fragmentShader,
  } as unknown as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, null as unknown as WebGLRenderer);
  return shader;
}

const heights = new IslandHeights();
const terrain = createIslandTerrain(heights);
const verts = TERRAIN_SEGMENTS + 1;

describe('island terrain graphics', () => {
  test('the mesh has one vertex per height sample, laid on the grid', () => {
    const position = terrain.mesh.geometry.attributes.position;
    expect(verts).toBe(361);
    expect(position.count).toBe(361 * 361);
    expect(allFinite(position.array)).toBe(true);
    for (let index = 0; index < position.count; index += 997) {
      const i = index % verts;
      const j = Math.floor(index / verts);
      expect(position.getX(index)).toBeCloseTo(-TERRAIN_SIZE / 2 + i * heights.cellSize, 2);
      expect(position.getZ(index)).toBeCloseTo(-TERRAIN_SIZE / 2 + j * heights.cellSize, 2);
      expect(position.getY(index)).toBeCloseTo(Math.max(heights.heights[j * verts + i], SEABED - 6), 4);
    }
  });

  test('normals are finite and vertex colours stay in [0, 1]; the city centre is city ground', () => {
    const { normal, color } = terrain.mesh.geometry.attributes;
    expect(allFinite(normal.array)).toBe(true);
    expect(color.count).toBe(361 * 361);
    expect(Array.from(color.array).every((c) => c >= 0 && c <= 1)).toBe(true);
    const centre = 180 * verts + 180;
    const cityGround = new Color('#8e8880');
    expect(color.getX(centre)).toBeCloseTo(cityGround.r, 6);
    expect(color.getY(centre)).toBeCloseTo(cityGround.g, 6);
    expect(color.getZ(centre)).toBeCloseTo(cityGround.b, 6);
  });

  test('trees: v1’s 7,020 (the 6,500 forest cap plus the 520-tree park grove), all standing on the ground', () => {
    const { trees } = terrain;
    expect(trees.count).toBe(7020);
    expect(trees.instanceColor?.count).toBe(trees.count);
    expect(allFinite(trees.instanceMatrix.array)).toBe(true);
    const matrix = new Matrix4();
    const at = new Vector3();
    const rotation = new Quaternion();
    const scale = new Vector3();
    const forest = trees.count - 520;
    for (let index = 0; index < trees.count; index += 7) {
      trees.getMatrixAt(index, matrix);
      matrix.decompose(at, rotation, scale);
      expect(at.y).toBeCloseTo(heights.heightAt(at.x, at.z) - 0.5, 1);
      if (index < forest) {
        expect(at.y + 0.5).toBeGreaterThanOrEqual(6 - 0.05);
        expect(at.y + 0.5).toBeLessThanOrEqual(190 + 0.05);
      } else {
        expect(at.x).toBeGreaterThanOrEqual(CITY_PARK.minX + 10 - 0.01);
        expect(at.x).toBeLessThanOrEqual(CITY_PARK.maxX - 10 + 0.01);
        expect(at.z).toBeGreaterThanOrEqual(CITY_PARK.minZ + 10 - 0.01);
        expect(at.z).toBeLessThanOrEqual(CITY_PARK.maxZ - 10 + 0.01);
      }
    }
  });

  test('the shallow-water map is 0 on land and depth / 60 m at sea, over the whole grid', () => {
    const { texture, bounds } = terrain.createDepthTexture();
    const { data, width, height } = texture.image;
    expect([width, height]).toEqual([512, 512]);
    expect(data).toBeInstanceOf(Uint8Array);
    expect(bounds.toArray()).toEqual([-TERRAIN_SIZE / 2, -TERRAIN_SIZE / 2, 1 / TERRAIN_SIZE, 1 / TERRAIN_SIZE]);
    const texel = (i: number, j: number): number => data![(j * 512 + i) * 4];
    expect(texel(256, 256)).toBe(0); // the city island
    for (const [i, j] of [[0, 0], [511, 3], [40, 470], [300, 100]]) {
      const x = -TERRAIN_SIZE / 2 + ((i + 0.5) / 512) * TERRAIN_SIZE;
      const z = -TERRAIN_SIZE / 2 + ((j + 0.5) / 512) * TERRAIN_SIZE;
      expect(texel(i, j)).toBe(Math.round(Math.min(1, Math.max(0, -heights.heightAt(x, z) / 60)) * 255));
    }
    expect(Array.from(data!).filter((_, k) => k % 4 === 3).every((alpha) => alpha === 255)).toBe(true);
    expect(terrain.createDepthTexture(64).texture.image.width).toBe(64);
  });

  test('terrain and tree materials patch three’s standard shader: haze everywhere, streets on the city ground', () => {
    const ground = compileStandard(terrain.mesh.material);
    const colourAt = ground.fragmentShader.indexOf('#include <color_fragment>');
    expect(colourAt).toBeGreaterThan(-1);
    expect(ground.fragmentShader.indexOf('float streetDist', colourAt)).toBeGreaterThan(colourAt);
    expect(ground.fragmentShader).toContain('smoothstep(1242.0, 1366.2, length(xz))');
    expect(ground.fragmentShader).toContain('applyAerialPerspective(gl_FragColor.rgb, vAerialWorld)');
    expect(ground.fragmentShader).not.toContain('#include <fog_fragment>');
    expect(ground.uniforms.uSunDir).toBe(atmosphereUniforms.uSunDir);
    const trees = compileStandard(terrain.trees.material);
    expect(trees.vertexShader).toContain('aerialWorld = instanceMatrix * aerialWorld;');
    expect(trees.fragmentShader).not.toContain('streetDist');
    expect(terrain.mesh.material.customProgramCacheKey()).toBe('atmosphere:terrain');
    expect(terrain.trees.material.customProgramCacheKey()).toBe('atmosphere:trees');
  });
});

describe('sky and sea', () => {
  test('the sky dome is a far-plane sphere drawn after opaque geometry, sharing the atmosphere clock', () => {
    const sky = createSkyDome();
    expect(sky.geometry.attributes.position.count).toBe(65 * 33);
    expect(sky.material.side).toBe(BackSide);
    expect(sky.material.depthWrite).toBe(false);
    expect(sky.renderOrder).toBe(1000);
    expect(sky.frustumCulled).toBe(false);
    expect(sky.material.uniforms.uSunDisc.value).toBe(1);
    expect(sky.material.uniforms.uTime).toBe(atmosphereUniforms.uTime);
  });

  test('the ocean reads the terrain’s shallow-water map and follows the camera in 200 m steps', () => {
    const depth = terrain.createDepthTexture(64);
    const ocean = createOcean(depth);
    const { uniforms } = ocean.mesh.material;
    expect(uniforms.uDepthMap.value).toBe(depth.texture);
    expect(uniforms.uDepthBounds.value).toBe(depth.bounds);
    expect(uniforms.uTime).toBe(atmosphereUniforms.uTime);
    expect(ocean.mesh.scale.x).toBe(56000);
    const camera = new PerspectiveCamera();
    camera.position.set(349, 80, -251);
    ocean.follow(camera);
    expect(ocean.mesh.position.toArray()).toEqual([400, 0, -200]);
  });
});

describe('shared GLSL is composed, not cut', () => {
  test('the split snippets reassemble the shared ones', () => {
    expect(ATMOSPHERE_GLSL.replace('uniform float uTime;\n', '')).toBe(ATMOSPHERE_GLSL_WITHOUT_TIME);
    expect(NOISE_GLSL.startsWith(VALUE_NOISE_GLSL)).toBe(true);
    expect(NOISE_GLSL.slice(VALUE_NOISE_GLSL.length).startsWith('float fbm(')).toBe(true);
  });

  test('clouds and dust get the shaders v1’s string surgery produced', () => {
    const clouds = new CloudField({ detail: 0, count: 3 });
    const { vertexShader, fragmentShader } = clouds.mesh.material;
    expect(vertexShader).toContain('uniform float uTime;');
    expect(fragmentShader).not.toContain('uTime');
    expect(squash(fragmentShader).startsWith(squash(ATMOSPHERE_GLSL.replace('uniform float uTime;', '')))).toBe(true);

    const dust = new DustPlumes(4).mesh.material.fragmentShader;
    expect(dust).toContain(`${ATMOSPHERE_GLSL}\n${NOISE_GLSL.replace(/float fbm[\s\S]*$/, '')}\n`);
    expect(dust).not.toContain('fbm');
  });
});

describe('cloud field', () => {
  test('builds the requested number of clouds, 5–15 puffs each, one instance per puff', () => {
    const clouds = new CloudField({ detail: 1, count: 40 });
    expect(clouds.clouds).toHaveLength(40);
    expect(clouds.puffs.length).toBeGreaterThanOrEqual(40 * 5);
    expect(clouds.puffs.length).toBeLessThanOrEqual(40 * 15);
    expect(clouds.mesh.count).toBe(clouds.puffs.length);
    expect(clouds.mesh.geometry.attributes.aPuff.count).toBe(clouds.puffs.length);
    expect(allFinite(clouds.mesh.instanceMatrix.array)).toBe(true);
    clouds.puffs.forEach((puff, index) => {
      expect(puff.index).toBe(index);
      expect(puff.cloudTop).toBeGreaterThan(puff.cloudBase);
    });
    expect(new CloudField().clouds).toHaveLength(150);
  });

  test('drifts with the wind, reports immersion, and parts around the hero then billows back', () => {
    const clouds = new CloudField({ detail: 0, count: 60 });
    const puff = clouds.puffs.reduce((best, p) => (p.radius > best.radius ? p : best));
    const still = new Vector3();
    clouds.update(1, new Vector3(0, -500, 0), still);
    expect(clouds.drift.toArray()).toEqual([2.2, 0, 0.7]);
    expect(clouds.mesh.position.equals(clouds.drift)).toBe(true);

    const inside = puff.center.clone().add(clouds.drift);
    expect(clouds.immersion(inside)).toBe(1);
    expect(clouds.immersion(new Vector3(0, 3000, 0))).toBe(0);

    clouds.update(1 / 60, inside, new Vector3(60, 0, 0));
    expect(puff.disturb).toBeCloseTo(1 - 1 / 600, 9); // set to 1, then eased back by one step
    const matrix = new Matrix4();
    const scale = new Vector3();
    clouds.mesh.getMatrixAt(puff.index, matrix);
    matrix.decompose(new Vector3(), new Quaternion(), scale);
    expect(scale.x / puff.radius).toBeCloseTo(0.58, 4); // shrunk by 42% while parted

    for (let t = 0; t < 10.5; t += 0.5) clouds.update(0.5, new Vector3(0, -500, 0), still);
    expect(puff.disturb).toBe(0);
    const centre = new Vector3();
    clouds.mesh.getMatrixAt(puff.index, matrix);
    matrix.decompose(centre, new Quaternion(), scale);
    expect(scale.x).toBeCloseTo(puff.radius, 3);
    expect(centre.distanceTo(puff.center)).toBeLessThan(1e-3);
  });

  test('largestCloudNear finds the biggest cloud in range', () => {
    const clouds = new CloudField({ detail: 0, count: 30 });
    const biggest = clouds.clouds.reduce((best, c) => (c.size > best.size ? c : best));
    expect(clouds.largestCloudNear(0, 0, 1e9)).toBe(biggest);
    expect(clouds.largestCloudNear(0, 0, 1)).toBeNull();
  });
});

describe('particles, dust and speed effects', () => {
  test('a particle pool recycles the oldest slot, flies ballistically and fades', () => {
    const pool = new ParticlePool({ capacity: 4, color: '#ffffff', gravity: 10, drag: 0 });
    for (let k = 0; k < 6; k++) pool.spawn(k, 10, 0, 1, 0, 0, 1, 2);
    expect(pool.cursor).toBe(2);
    expect(Array.from(pool.positions.subarray(0, 3))).toEqual([4, 10, 0]);
    pool.update(0.25, 600);
    expect(pool.positions[0]).toBeCloseTo(4.25, 5);
    expect(pool.velocities[1]).toBeCloseTo(-2.5, 5);
    expect(pool.alphas[0]).toBeCloseTo(0.5625, 5); // t = 0.25: min(1, 8t)(1 - t)²
    expect(pool.sizes[0]).toBeCloseTo(2 * (0.6 + 0.25 * 0.9), 5);
    expect(pool.material.uniforms.uScale.value).toBe(600);
    pool.clear();
    pool.update(0.25, 600);
    expect(Array.from(pool.alphas).every((a) => a === 0)).toBe(true);
  });

  test('dust plumes: 340 slots, live puffs packed to the front, density near a puff', () => {
    const dust = new DustPlumes();
    expect(dust.capacity).toBe(340);
    expect(dust.mesh.count).toBe(0);
    dust.puff(0, 10, 0, { size: 10 });
    dust.puff(50, 10, 0, { size: 10, life: 0.01 });
    const wind = new Vector3(2.2, 0, 0.7);
    dust.update(1 / 60, wind);
    dust.update(1 / 60, wind);
    expect(dust.active).toBe(1);
    expect(dust.mesh.count).toBe(1);
    expect(allFinite(dust.position)).toBe(true);
    expect(dust.densityAt(new Vector3(0, 10, 0))).toBeGreaterThan(0);
    expect(dust.densityAt(new Vector3(0, 10, 0))).toBeLessThanOrEqual(1);
    expect(dust.densityAt(new Vector3(500, 10, 0))).toBe(0);
    dust.clear();
    dust.update(1 / 60, wind);
    expect(dust.active).toBe(0);
  });

  test('dust plumes are reproducible with a seeded random source', () => {
    const a = new DustPlumes(16, createRandom(3));
    const b = new DustPlumes(16, createRandom(3));
    for (const plumes of [a, b]) {
      for (let k = 0; k < 20; k++) plumes.puff(k, 0, -k, { darkness: 0.1 });
      plumes.update(0.1, new Vector3(1, 0, 0));
    }
    expect(Array.from(a.packed)).toEqual(Array.from(b.packed));
    expect(Array.from(a.mesh.instanceMatrix.array)).toEqual(Array.from(b.mesh.instanceMatrix.array));
  });

  test('speed effects: bursts, shockwave, sea spray, street dust and air streaks', () => {
    const scene = new Scene();
    const dust = new DustPlumes(64, createRandom(1));
    const effects = new SpeedEffects(scene, dust);
    expect(scene.children).toHaveLength(6);
    const camera = new PerspectiveCamera();
    const flight: SpeedEffectsFlight = {
      position: new Vector3(0, 3, 0),
      velocity: new Vector3(0, 0, 60),
      forward: new Vector3(0, 0, 1),
      speed: 60,
      surfaceRush: 0.5,
      overWater: true,
      groundClearance: 3,
    };
    const frame = { camera, flight, projectionScale: 650 };
    const wind = new Vector3(2.2, 0, 0.7);
    let time = 0;
    const step = (): void => {
      effects.update(1 / 60, (time += 1 / 60), frame);
      dust.update(1 / 60, wind);
    };

    effects.burstSparks(new Vector3(1, 2, 3));
    expect(effects.sparks.cursor).toBe(48);
    effects.onBoom(flight.position, flight.forward);
    expect(effects.shockwave.ring.visible && effects.shockwave.cone.visible).toBe(true);

    for (let k = 0; k < 30; k++) step();
    expect(Array.from(effects.spray.alphas).some((a) => a > 0)).toBe(true);
    expect(dust.active).toBe(0); // no street dust over water
    expect(effects.streaks.mesh.visible).toBe(true);
    expect(allFinite(effects.streaks.positions)).toBe(true);

    Object.assign(flight, { overWater: false, groundClearance: 2 });
    for (let k = 0; k < 90; k++) step();
    expect(dust.active).toBeGreaterThan(0);
    expect(effects.shockwave.ring.visible || effects.shockwave.cone.visible).toBe(false);

    for (const pool of [effects.sparks, effects.spray, effects.grit]) expect(allFinite(pool.positions)).toBe(true);
    effects.clear();
    effects.update(1 / 60, (time += 1 / 60), { ...frame, flight: { ...flight, speed: 0, groundClearance: 50 } });
    for (const pool of [effects.sparks, effects.spray, effects.grit]) expect(Array.from(pool.alphas).every((a) => a === 0)).toBe(true);
  });
});

describe('post pipeline (recording renderer, no WebGL)', () => {
  test('HDR scene → prefilter → bloom down/up chain → composite to the canvas', () => {
    const world = new Scene();
    const targets: unknown[] = [];
    const drawn: (Material | Material[] | 'world')[] = [];
    let clears = 0;
    const renderer: PostRenderer = {
      setRenderTarget(target) {
        targets.push(target);
      },
      clear() {
        clears++;
      },
      render(scene: Object3D) {
        drawn.push(scene === world ? 'world' : (scene.children[0] as Mesh).material);
      },
    };
    const post = new PostPipeline(renderer);
    post.setSize(1280, 720);
    expect([post.sceneTarget.width, post.sceneTarget.height]).toEqual([1280, 720]);
    expect(post.sceneTarget.samples).toBe(4);
    expect(post.sceneTarget.texture.type).toBe(HalfFloatType);
    expect(post.levels.map((level) => `${level.width}x${level.height}`)).toEqual(['640x360', '320x180', '160x90', '80x45', '40x22']);

    post.settings.uCloud.value = 0.4;
    post.render(world, new PerspectiveCamera());
    const named = targets.map((target) =>
      target === null ? 'canvas' : target === post.sceneTarget ? 'scene' : `L${post.levels.findIndex((level) => level === target)}`,
    );
    expect(named).toEqual(['scene', 'L0', 'L1', 'L2', 'L3', 'L4', 'L3', 'L2', 'L1', 'L0', 'canvas']);
    expect(clears).toBe(1);
    expect(drawn[0]).toBe('world');
    expect(drawn).toHaveLength(11);
    const composite = drawn[10] as ShaderMaterial;
    expect(composite.uniforms).toBe(post.settings);
    expect(composite.uniforms.uCloud.value).toBe(0.4);
    expect(post.settings.uResolution.value.toArray()).toEqual([1280, 720]);
  });
});
