import {
  BufferAttribute, BufferGeometry, ClampToEdgeWrapping, Color, ConeGeometry, CylinderGeometry, DataTexture, InstancedMesh,
  LinearFilter, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, Quaternion, RGBAFormat, SRGBColorSpace, Vector3, Vector4,
} from 'three';
import type { WebGLProgramParametersWithUniforms } from 'three';
import { CITY_BLOCK, CITY_ISLAND, CITY_PARK, SEABED, WILD_ISLANDS, terrainDetailNoise, type IslandHeights } from '../../../core/island-terrain-height';
import { clamp, lerp, smoothstep } from '../../../core/scalar-math';
import { createRandom, fractalNoise } from '../../../core/seeded-noise';
import { afterInclude, applyAtmosphere } from './atmosphere';
import type { ShallowWaterMap } from './ocean-surface';

// The archipelago as you see it: the height grid as a vertex-coloured mesh (seabed, sand,
// meadow, forest, rock and snow; flat city ground with streets, lane markings and the park
// drawn on it), instanced trees, and the shallow-water map the ocean shader reads. Everything
// is built from the same IslandHeights grid that flight and physics use, so they agree with
// the mesh you see. Ported from the rendering half of v1 (src/island-terrain.js); the heights
// live in core/island-terrain-height.ts.

/** The rendered terrain. Add `mesh` and `trees` to the scene; pass `createDepthTexture()` to `createOcean`. */
export interface IslandTerrainGraphics {
  readonly heights: IslandHeights;
  readonly mesh: Mesh<PlaneGeometry, MeshStandardMaterial>;
  readonly trees: InstancedMesh<BufferGeometry, MeshStandardMaterial>;
  /** Builds a new shallow-water map (a `resolution`² texture, 512 by default) on every call. */
  createDepthTexture(resolution?: number): TerrainDepthTexture;
}

export interface TerrainDepthTexture extends ShallowWaterMap {
  readonly texture: DataTexture;
}

export function createIslandTerrain(heights: IslandHeights): IslandTerrainGraphics {
  return {
    heights,
    mesh: createTerrainMesh(heights),
    trees: createTerrainTrees(heights),
    createDepthTexture: (resolution = 512) => createShallowWaterMap(heights, resolution),
  };
}

/** The ground surface: one vertex per height sample, coloured by height, slope and noise. */
export function createTerrainMesh(heights: IslandHeights): Mesh<PlaneGeometry, MeshStandardMaterial> {
  const { size, segments, cellSize } = heights;
  const geometry = new PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position;
  const verts = segments + 1;
  // PlaneGeometry rows run from +y to -y; after rotation that is -z to +z.
  for (let index = 0; index < position.count; index++) {
    const i = index % verts;
    const j = Math.floor(index / verts);
    position.setY(index, Math.max(heights.heights[j * verts + i], SEABED - 6));
    position.setX(index, -size / 2 + i * cellSize);
    position.setZ(index, -size / 2 + j * cellSize);
  }
  geometry.computeVertexNormals();

  const normal = geometry.attributes.normal;
  const colors = new Float32Array(position.count * 3);
  const sand = new Color('#d2b98f');
  const grass = new Color('#5d7a43');
  const meadow = new Color('#8a8b52');
  const forest = new Color('#3f5a35');
  const rock = new Color('#7b6c61');
  const snow = new Color('#f1ebe4');
  const cityGround = new Color('#8e8880');
  const seabed = new Color('#355a57');
  const color = new Color();
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    const slope = 1 - normal.getY(index);
    const inCity = Math.hypot(x - CITY_ISLAND.x, z - CITY_ISLAND.z) < CITY_ISLAND.radius * 0.97 && y > 2.5 && y < 6;
    const variation = terrainDetailNoise(x * 0.004, z * 0.004) * 0.5 + 0.5;
    if (y < -1) color.copy(seabed).lerp(sand, smoothstep(-14, -1, y));
    else if (inCity) color.copy(cityGround);
    else if (y < 5) color.copy(sand);
    else {
      color.copy(grass).lerp(meadow, variation * 0.6).lerp(forest, smoothstep(20, 120, y) * (1 - variation) * 0.7);
      color.lerp(rock, smoothstep(0.28, 0.5, slope + variation * 0.08));
      color.lerp(snow, smoothstep(250, 330, y + variation * 40) * (1 - smoothstep(0.45, 0.65, slope)));
    }
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));

  const material = applyAtmosphere(new MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 }), {
    key: 'terrain',
    patch: patchCityStreets,
  });
  const mesh = new Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

interface TreeSpot {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
}

/**
 * Forests on the wild islands (up to 6,500 trees from 42,000 tries) plus a 520-tree grove in the
 * city park, as one instanced mesh. Seeded, so the same trees grow on every load.
 */
export function createTerrainTrees(heights: IslandHeights): InstancedMesh<BufferGeometry, MeshStandardMaterial> {
  const random = createRandom(4242);
  const spots: TreeSpot[] = [];
  const tryAdd = (x: number, z: number, scale: number): void => {
    const y = heights.heightAt(x, z);
    spots.push({ x, y: y - 0.5, z, scale });
  };
  // Forests on the wild islands.
  for (let attempt = 0; attempt < 42000 && spots.length < 6500; attempt++) {
    const island = WILD_ISLANDS[Math.floor(random() * WILD_ISLANDS.length)];
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * island.radius;
    const x = island.x + Math.cos(angle) * radius;
    const z = island.z + Math.sin(angle) * radius;
    const y = heights.heightAt(x, z);
    if (y < 6 || y > 190) continue;
    const slope = Math.abs(heights.heightAt(x + 12, z) - y) + Math.abs(heights.heightAt(x, z + 12) - y);
    if (slope > 9) continue;
    if (fractalNoise(terrainDetailNoise, x * 0.004, z * 0.004, 2) < -0.08) continue;
    tryAdd(x, z, 0.75 + random() * 0.7);
  }
  // A grove in the city park.
  for (let k = 0; k < 520; k++) {
    const x = lerp(CITY_PARK.minX + 10, CITY_PARK.maxX - 10, random());
    const z = lerp(CITY_PARK.minZ + 10, CITY_PARK.maxZ - 10, random());
    tryAdd(x, z, 0.55 + random() * 0.4);
  }

  const cone = new ConeGeometry(3.2, 11, 7, 1);
  cone.translate(0, 7.5, 0);
  const trunk = new CylinderGeometry(0.45, 0.6, 3, 5);
  trunk.translate(0, 1.5, 0);
  const geometry = mergeTreeParts(cone, trunk);
  const material = applyAtmosphere(new MeshStandardMaterial({ color: '#ffffff', roughness: 0.88, vertexColors: true }), {
    key: 'trees',
  });
  const mesh = new InstancedMesh(geometry, material, spots.length);
  const matrix = new Matrix4();
  const rotation = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const tint = new Color();
  spots.forEach((spot, index) => {
    rotation.setFromAxisAngle(up, random() * Math.PI * 2);
    const s = spot.scale;
    matrix.compose(new Vector3(spot.x, spot.y, spot.z), rotation, new Vector3(s, s * (0.85 + random() * 0.4), s));
    mesh.setMatrixAt(index, matrix);
    tint.setHSL(0.24 + random() * 0.07, 0.32 + random() * 0.18, 0.2 + random() * 0.1, SRGBColorSpace);
    mesh.setColorAt(index, tint);
  });
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

/** Shallow-water map for the ocean shader: 0 at the shoreline, 1 at 60 m depth. */
export function createShallowWaterMap(heights: IslandHeights, resolution = 512): TerrainDepthTexture {
  const { size } = heights;
  const data = new Uint8Array(resolution * resolution * 4);
  for (let j = 0; j < resolution; j++) {
    const z = -size / 2 + ((j + 0.5) / resolution) * size;
    for (let i = 0; i < resolution; i++) {
      const x = -size / 2 + ((i + 0.5) / resolution) * size;
      const depth = clamp(-heights.heightAt(x, z) / 60, 0, 1);
      const k = (j * resolution + i) * 4;
      data[k] = Math.round(depth * 255);
      data[k + 3] = 255;
    }
  }
  const texture = new DataTexture(data, resolution, resolution, RGBAFormat);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return { texture, bounds: new Vector4(-size / 2, -size / 2, 1 / size, 1 / size) };
}

/** One tree geometry: the crown white (tinted per instance) and the trunk bark-brown, as vertex colours. */
function mergeTreeParts(crown: BufferGeometry, trunk: BufferGeometry): BufferGeometry {
  const parts = [crown.toNonIndexed(), trunk.toNonIndexed()];
  const green = new Color('#ffffff');
  const bark = new Color('#5a4636');
  let count = 0;
  for (const part of parts) count += part.attributes.position.count;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  let offset = 0;
  parts.forEach((part, index) => {
    positions.set(part.attributes.position.array, offset * 3);
    normals.set(part.attributes.normal.array, offset * 3);
    const c = index === 0 ? green : bark;
    for (let v = 0; v < part.attributes.position.count; v++) {
      colors[(offset + v) * 3] = c.r;
      colors[(offset + v) * 3 + 1] = c.g;
      colors[(offset + v) * 3 + 2] = c.b;
    }
    offset += part.attributes.position.count;
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}

// Streets, lane markings and the park, drawn procedurally on the flat city ground.
const CITY_STREETS_GLSL = /* glsl */ `
{
  vec2 xz = vAerialWorld.xz;
  float cityMask = smoothstep(2.4, 3.2, vAerialWorld.y) * (1.0 - smoothstep(5.2, 6.0, vAerialWorld.y))
    * (1.0 - smoothstep(${(CITY_ISLAND.radius * 0.9).toFixed(1)}, ${(CITY_ISLAND.radius * 0.99).toFixed(1)}, length(xz)));
  vec2 toStreet = abs(fract(xz / ${CITY_BLOCK.spacing.toFixed(1)}) - 0.5) * ${CITY_BLOCK.spacing.toFixed(1)};
  float streetDist = min(toStreet.x, toStreet.y);
  float px = max(fwidth(xz.x), fwidth(xz.y));
  float street = 1.0 - smoothstep(${(CITY_BLOCK.street / 2 - 0.6).toFixed(2)} - px, ${(CITY_BLOCK.street / 2).toFixed(2)} + px, streetDist);
  float curb = (1.0 - smoothstep(${(CITY_BLOCK.street / 2 + 2.2).toFixed(2)} - px, ${(CITY_BLOCK.street / 2 + 2.8).toFixed(2)} + px, streetDist)) - street;
  float lane = (1.0 - smoothstep(0.12, 0.28 + px, streetDist)) * street * (1.0 - smoothstep(1.0, 3.0, px));
  float park = step(${CITY_PARK.minX.toFixed(1)} + 8.0, xz.x) * step(xz.x, ${CITY_PARK.maxX.toFixed(1)} - 8.0)
    * step(${CITY_PARK.minZ.toFixed(1)} + 8.0, xz.y) * step(xz.y, ${CITY_PARK.maxZ.toFixed(1)} - 8.0);
  vec3 asphalt = vec3(0.045, 0.045, 0.05);
  vec3 pavement = vec3(0.36, 0.34, 0.32);
  vec3 lawn = vec3(0.16, 0.24, 0.09) * (0.85 + 0.3 * sin(xz.x * 0.05) * sin(xz.y * 0.043));
  vec3 ground = diffuseColor.rgb;
  ground = mix(ground, pavement, curb * (1.0 - park));
  ground = mix(ground, asphalt, street * (1.0 - park));
  ground = mix(ground, vec3(0.55, 0.47, 0.3), lane * (1.0 - park) * 0.7);
  ground = mix(ground, lawn, park);
  diffuseColor.rgb = mix(diffuseColor.rgb, ground, cityMask);
}`;

function patchCityStreets(shader: WebGLProgramParametersWithUniforms): void {
  shader.fragmentShader = afterInclude(shader.fragmentShader, 'color_fragment', CITY_STREETS_GLSL, 'material "terrain" (city streets)');
}
