import * as THREE from 'three';
import { createNoise2D, createRandom, fractalNoise } from './seeded-noise.js';
import { applyAtmosphere } from './atmosphere.js';
import { clamp, lerp, smoothstep } from './scalar-math.js';

// An archipelago: a flat city island at the centre, wild mountainous islands around it.
// The analytic shape is sampled once into a height grid; physics, trees and the ocean's
// shallow-water map all read that grid so they agree with the mesh you see.

export const CITY_ISLAND = { x: 0, z: 0, radius: 1380, ground: 4 };
export const CITY_BLOCK = { spacing: 72, street: 16 };
export const CITY_PARK = { minX: -612, maxX: -396, minZ: 252, maxZ: 468 };

const WILD_ISLANDS = [
  { x: 3350, z: 2550, radius: 1250, peak: 430, rugged: 1.0 },
  { x: -3150, z: 2950, radius: 950, peak: 300, rugged: 0.9 },
  { x: -2950, z: -1350, radius: 700, peak: 165, rugged: 0.75 },
  { x: 2350, z: -2300, radius: 540, peak: 115, rugged: 0.6 },
  { x: 350, z: 3950, radius: 620, peak: 200, rugged: 0.85 },
  { x: -1150, z: -3300, radius: 400, peak: 70, rugged: 0.5 },
  { x: 4300, z: -850, radius: 450, peak: 95, rugged: 0.6 },
];

const SEABED = -44;
const SIZE = 13000;
const SEGMENTS = 360;

const shapeNoise = createNoise2D(7);
const ridgeNoise = createNoise2D(19);
const detailNoise = createNoise2D(31);

function cityIslandHeight(x, z) {
  const dx = x - CITY_ISLAND.x;
  const dz = z - CITY_ISLAND.z;
  const distance = Math.hypot(dx, dz);
  if (distance > CITY_ISLAND.radius * 1.4) return SEABED;
  const angle = Math.atan2(dz, dx);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const coast =
    CITY_ISLAND.radius * (1 + 0.07 * shapeNoise(ca * 1.6 + 11.3, sa * 1.6 - 3.1) + 0.03 * shapeNoise(ca * 4.1, sa * 4.1));
  const t = (distance - coast) / 170;
  if (t < -0.3) return CITY_ISLAND.ground;
  return lerp(CITY_ISLAND.ground, SEABED, smoothstep(-0.3, 1, t));
}

function wildIslandHeight(island, x, z) {
  const dx = x - island.x;
  const dz = z - island.z;
  const d = Math.hypot(dx, dz) / island.radius;
  if (d > 1.5) return SEABED;
  const warp = fractalNoise(shapeNoise, x * 0.0008 + island.x * 0.01, z * 0.0008, 3) * 0.38;
  const r = d + warp;
  const dome = Math.max(0, 1 - r);
  const shape = Math.pow(dome, 1.3);
  const ridges = 1 - Math.abs(fractalNoise(ridgeNoise, x * 0.0024, z * 0.0024, 4));
  let h = island.peak * shape * (0.7 + 0.5 * ridges * island.rugged);
  h += 8 + 6 * detailNoise(x * 0.01, z * 0.01) * shape;
  h -= (8 - SEABED) * smoothstep(0.82, 1.35, r);
  return h;
}

export function analyticHeight(x, z) {
  let h = Math.max(SEABED + 3 * detailNoise(x * 0.002, z * 0.002), cityIslandHeight(x, z));
  for (const island of WILD_ISLANDS) {
    const dx = x - island.x;
    const dz = z - island.z;
    if (dx * dx + dz * dz > island.radius * island.radius * 2.25) continue;
    h = Math.max(h, wildIslandHeight(island, x, z));
  }
  return h;
}

export class IslandTerrain {
  constructor() {
    this.size = SIZE;
    this.segments = SEGMENTS;
    this.cellSize = SIZE / SEGMENTS;
    const verts = SEGMENTS + 1;
    this.heights = new Float32Array(verts * verts);
    for (let j = 0; j < verts; j++) {
      const z = -SIZE / 2 + j * this.cellSize;
      for (let i = 0; i < verts; i++) {
        const x = -SIZE / 2 + i * this.cellSize;
        this.heights[j * verts + i] = analyticHeight(x, z);
      }
    }
    this.mesh = this.#buildMesh();
    this.trees = this.#buildTrees();
  }

  heightAt(x, z) {
    const verts = SEGMENTS + 1;
    const fx = clamp((x + SIZE / 2) / this.cellSize, 0, SEGMENTS - 1e-3);
    const fz = clamp((z + SIZE / 2) / this.cellSize, 0, SEGMENTS - 1e-3);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const h = this.heights;
    const a = h[j * verts + i];
    const b = h[j * verts + i + 1];
    const c = h[(j + 1) * verts + i];
    const d = h[(j + 1) * verts + i + 1];
    // Match the mesh triangulation: each quad splits along its (i, j+1)–(i+1, j) diagonal.
    if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
    return d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }

  #buildMesh() {
    const geometry = new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS);
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.attributes.position;
    const verts = SEGMENTS + 1;
    // PlaneGeometry rows run from +y to -y; after rotation that is -z to +z.
    for (let index = 0; index < position.count; index++) {
      const i = index % verts;
      const j = Math.floor(index / verts);
      position.setY(index, Math.max(this.heights[j * verts + i], SEABED - 6));
      position.setX(index, -SIZE / 2 + i * this.cellSize);
      position.setZ(index, -SIZE / 2 + j * this.cellSize);
    }
    geometry.computeVertexNormals();

    const normal = geometry.attributes.normal;
    const colors = new Float32Array(position.count * 3);
    const sand = new THREE.Color('#d2b98f');
    const grass = new THREE.Color('#5d7a43');
    const meadow = new THREE.Color('#8a8b52');
    const forest = new THREE.Color('#3f5a35');
    const rock = new THREE.Color('#7b6c61');
    const snow = new THREE.Color('#f1ebe4');
    const cityGround = new THREE.Color('#8e8880');
    const seabed = new THREE.Color('#355a57');
    const color = new THREE.Color();
    for (let index = 0; index < position.count; index++) {
      const x = position.getX(index);
      const y = position.getY(index);
      const z = position.getZ(index);
      const slope = 1 - normal.getY(index);
      const inCity = Math.hypot(x - CITY_ISLAND.x, z - CITY_ISLAND.z) < CITY_ISLAND.radius * 0.97 && y > 2.5 && y < 6;
      const variation = detailNoise(x * 0.004, z * 0.004) * 0.5 + 0.5;
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
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = applyAtmosphere(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 }),
      { key: 'terrain', patch: patchCityStreets },
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    return mesh;
  }

  #buildTrees() {
    const random = createRandom(4242);
    const spots = [];
    const tryAdd = (x, z, scale) => {
      const y = this.heightAt(x, z);
      spots.push({ x, y: y - 0.5, z, scale });
    };
    // Forests on the wild islands.
    for (let attempt = 0; attempt < 42000 && spots.length < 6500; attempt++) {
      const island = WILD_ISLANDS[Math.floor(random() * WILD_ISLANDS.length)];
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random()) * island.radius;
      const x = island.x + Math.cos(angle) * radius;
      const z = island.z + Math.sin(angle) * radius;
      const y = this.heightAt(x, z);
      if (y < 6 || y > 190) continue;
      const slope = Math.abs(this.heightAt(x + 12, z) - y) + Math.abs(this.heightAt(x, z + 12) - y);
      if (slope > 9) continue;
      if (fractalNoise(detailNoise, x * 0.004, z * 0.004, 2) < -0.08) continue;
      tryAdd(x, z, 0.75 + random() * 0.7);
    }
    // A grove in the city park.
    for (let k = 0; k < 520; k++) {
      const x = lerp(CITY_PARK.minX + 10, CITY_PARK.maxX - 10, random());
      const z = lerp(CITY_PARK.minZ + 10, CITY_PARK.maxZ - 10, random());
      tryAdd(x, z, 0.55 + random() * 0.4);
    }

    const cone = new THREE.ConeGeometry(3.2, 11, 7, 1);
    cone.translate(0, 7.5, 0);
    const trunk = new THREE.CylinderGeometry(0.45, 0.6, 3, 5);
    trunk.translate(0, 1.5, 0);
    const geometry = mergeTreeParts(cone, trunk);
    const material = applyAtmosphere(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.88, vertexColors: true }), {
      key: 'trees',
    });
    const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const tint = new THREE.Color();
    spots.forEach((spot, index) => {
      rotation.setFromAxisAngle(up, random() * Math.PI * 2);
      const s = spot.scale;
      matrix.compose(new THREE.Vector3(spot.x, spot.y, spot.z), rotation, new THREE.Vector3(s, s * (0.85 + random() * 0.4), s));
      mesh.setMatrixAt(index, matrix);
      tint.setHSL(0.24 + random() * 0.07, 0.32 + random() * 0.18, 0.2 + random() * 0.1, THREE.SRGBColorSpace);
      mesh.setColorAt(index, tint);
    });
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    return mesh;
  }

  // Shallow-water map for the ocean shader: 0 at the shoreline, 1 at 60 m depth.
  createDepthTexture(resolution = 512) {
    const data = new Uint8Array(resolution * resolution * 4);
    for (let j = 0; j < resolution; j++) {
      const z = -SIZE / 2 + ((j + 0.5) / resolution) * SIZE;
      for (let i = 0; i < resolution; i++) {
        const x = -SIZE / 2 + ((i + 0.5) / resolution) * SIZE;
        const depth = clamp(-this.heightAt(x, z) / 60, 0, 1);
        const k = (j * resolution + i) * 4;
        data[k] = Math.round(depth * 255);
        data[k + 3] = 255;
      }
    }
    const texture = new THREE.DataTexture(data, resolution, resolution, THREE.RGBAFormat);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return { texture, bounds: new THREE.Vector4(-SIZE / 2, -SIZE / 2, 1 / SIZE, 1 / SIZE) };
  }
}

function mergeTreeParts(crown, trunk) {
  const parts = [crown.toNonIndexed(), trunk.toNonIndexed()];
  const green = new THREE.Color('#ffffff');
  const bark = new THREE.Color('#5a4636');
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
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

// Streets, lane markings and the park, drawn procedurally on the flat city ground.
function patchCityStreets(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    `#include <color_fragment>
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
    }`,
  );
}
