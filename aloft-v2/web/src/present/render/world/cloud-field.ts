import { IcosahedronGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, ShaderMaterial, Vector3 } from 'three';
import { smoothstep } from '../../../core/scalar-math';
import { createRandom } from '../../../core/seeded-noise';
import { ATMOSPHERE_GLSL_WITHOUT_TIME, PALETTE, atmosphereUniforms } from './atmosphere';

// A layer of fair-weather cumulus: soft instanced puffs with flat bases, lit warm on
// the sunward side and lilac in shade. Fly through one and it parts around you,
// then slowly billows back. Ported from v1 (src/cloud-field.js).

const WIND = new Vector3(2.2, 0, 0.7);
const CELL = 320;

// The vertex stage declares uTime (for the billow), so the fragment stage takes the atmosphere
// without it.
const vertexShader = /* glsl */ `
uniform float uTime;
attribute vec4 aPuff; // cloud base, cloud top, seed
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec2 vCloudSpan;
void main() {
  mat4 world = modelMatrix * instanceMatrix;
  vec4 p = world * vec4(position, 1.0);
  vec3 n = normalize(mat3(world) * normal);
  float below = aPuff.x - p.y;
  if (below > 0.0) {
    p.y = aPuff.x - below * 0.1;
    n = normalize(mix(n, vec3(0.0, -1.0, 0.0), 0.75));
  }
  p.xyz += n * sin(uTime * 0.25 + aPuff.z * 40.0 + position.x * 2.0 + position.y * 1.5) * 1.8;
  vWorld = p.xyz;
  vNormalW = n;
  vCloudSpan = aPuff.xy;
  gl_Position = projectionMatrix * viewMatrix * p;
}
`;

const fragmentShader = /* glsl */ `
${ATMOSPHERE_GLSL_WITHOUT_TIME}
uniform vec3 uShadeLow;
uniform vec3 uShadeHigh;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec2 vCloudSpan;
void main() {
  vec3 toFrag = vWorld - cameraPosition;
  float dist = length(toFrag);
  vec3 rd = toFrag / dist;
  vec3 n = normalize(vNormalW);
  float heightT = clamp((vWorld.y - vCloudSpan.x) / max(vCloudSpan.y - vCloudSpan.x, 1.0), 0.0, 1.0);
  float wrap = clamp(dot(n, uSunDir) * 0.6 + 0.4, 0.0, 1.0);
  float light = smoothstep(0.0, 1.0, wrap * mix(0.42, 1.0, heightT));
  vec3 shade = mix(uShadeLow, uShadeHigh, heightT);
  vec3 lit = uSunColor * 1.3 + vec3(0.06, 0.05, 0.08);
  vec3 col = mix(shade, lit, light);
  col += uSkyZenith * 0.28 * max(n.y, 0.0);
  float facing = clamp(dot(n, -rd), 0.0, 1.0);
  float towardSun = pow(max(dot(rd, uSunDir), 0.0), 4.0);
  col += uSunColor * pow(1.0 - facing, 3.0) * towardSun * 2.4; // silver lining
  col = applyAerialPerspective(col, vWorld);
  float alpha = smoothstep(0.03, 0.4, facing) * smoothstep(10.0, 80.0, dist);
  gl_FragColor = vec4(col, alpha);
}
`;

/** One sphere of a cloud, in the field's undrifted frame. */
export interface CloudPuff {
  readonly center: Vector3;
  readonly radius: number;
  readonly cloudBase: number;
  cloudTop: number;
  readonly seed: number;
  /** 1 right after the hero flies through, easing back to 0 over 10 s. */
  disturb: number;
  /** Unit direction the puff is shoved (away from the flight line). */
  readonly push: Vector3;
  /** Instance index in `CloudField.mesh`. */
  index: number;
}

/** A whole cloud, in the field's undrifted frame (add `CloudField.drift` for where it is now). */
export interface Cloud {
  readonly x: number;
  readonly z: number;
  readonly base: number;
  readonly top: number;
  readonly size: number;
}

export interface CloudFieldOptions {
  /** Icosahedron subdivision per puff (v1: 2 on desktop, 1 on phones). */
  detail?: number;
  /** Number of clouds (v1: 150 on desktop, 110 on phones). */
  count?: number;
}

export class CloudField {
  readonly puffs: CloudPuff[] = [];
  readonly clouds: Cloud[] = [];
  /** How far the wind has carried the whole field; the mesh sits at this offset. */
  readonly drift = new Vector3();
  readonly mesh: InstancedMesh<IcosahedronGeometry, ShaderMaterial>;

  private readonly random = createRandom(777);
  private readonly cells = new Map<number, CloudPuff[]>();
  private readonly disturbed = new Set<CloudPuff>();
  private readonly local = new Vector3();
  private readonly matrix = new Matrix4();
  private readonly quaternion = new Quaternion();
  private readonly scale = new Vector3();
  private readonly center = new Vector3();

  constructor({ detail = 2, count = 150 }: CloudFieldOptions = {}) {
    this.generate(count);
    this.mesh = this.buildMesh(detail);
  }

  private generate(count: number): void {
    const random = this.random;
    for (let c = 0; c < count; c++) {
      const angle = random() * Math.PI * 2;
      const distance = 500 + Math.sqrt(random()) * 6400;
      const cx = Math.cos(angle) * distance;
      const cz = Math.sin(angle) * distance;
      const size = 90 + Math.pow(random(), 1.7) * 300;
      const base = 470 + random() * 80;
      const puffCount = Math.min(15, 5 + Math.floor(size / 32));
      const cloudPuffs: CloudPuff[] = [];
      let top = base;
      for (let p = 0; p < puffCount; p++) {
        const a = random() * Math.PI * 2;
        const r = Math.sqrt(random()) * size * 0.75;
        const centerWeight = 1 - r / (size * 0.75);
        const radius = size * (0.22 + 0.22 * random()) * (0.55 + 0.6 * centerWeight);
        const center = new Vector3(
          cx + Math.cos(a) * r * 1.15,
          base + radius * (0.2 + 0.5 * random() * (0.5 + centerWeight)),
          cz + Math.sin(a) * r * 0.75,
        );
        const puff: CloudPuff = { center, radius, cloudBase: base, cloudTop: 0, seed: random(), disturb: 0, push: new Vector3(), index: 0 };
        cloudPuffs.push(puff);
        top = Math.max(top, center.y + radius);
      }
      for (const puff of cloudPuffs) {
        puff.cloudTop = top;
        puff.index = this.puffs.length;
        this.puffs.push(puff);
        this.addToCells(puff);
      }
      this.clouds.push({ x: cx, z: cz, base, top, size });
    }
  }

  private cellKey(ix: number, iz: number): number {
    return (ix + 1024) * 2048 + (iz + 1024);
  }

  private addToCells(puff: CloudPuff): void {
    const r = puff.radius;
    for (let ix = Math.floor((puff.center.x - r) / CELL); ix <= Math.floor((puff.center.x + r) / CELL); ix++) {
      for (let iz = Math.floor((puff.center.z - r) / CELL); iz <= Math.floor((puff.center.z + r) / CELL); iz++) {
        const key = this.cellKey(ix, iz);
        let list = this.cells.get(key);
        if (!list) {
          list = [];
          this.cells.set(key, list);
        }
        list.push(puff);
      }
    }
  }

  /** Visits every puff whose bounds overlap the grid cell containing `local` (undrifted frame). */
  private forPuffsNear(local: Vector3, visit: (puff: CloudPuff) => void): void {
    const list = this.cells.get(this.cellKey(Math.floor(local.x / CELL), Math.floor(local.z / CELL)));
    if (list) for (const puff of list) visit(puff);
  }

  private buildMesh(detail: number): InstancedMesh<IcosahedronGeometry, ShaderMaterial> {
    const geometry = new IcosahedronGeometry(1, detail);
    const data = new Float32Array(this.puffs.length * 4);
    this.puffs.forEach((puff, i) => data.set([puff.cloudBase, puff.cloudTop, puff.seed, 0], i * 4));
    geometry.setAttribute('aPuff', new InstancedBufferAttribute(data, 4));
    const material = new ShaderMaterial({
      uniforms: {
        ...atmosphereUniforms,
        uShadeLow: { value: PALETTE.cloudShadeLow },
        uShadeHigh: { value: PALETTE.cloudShadeHigh },
      },
      vertexShader,
      fragmentShader,
      alphaToCoverage: true,
    });
    const mesh = new InstancedMesh(geometry, material, this.puffs.length);
    const matrix = new Matrix4();
    this.puffs.forEach((puff, i) => {
      matrix.makeScale(puff.radius, puff.radius, puff.radius).setPosition(puff.center);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.frustumCulled = false;
    return mesh;
  }

  /** Writes the puff's current (possibly shoved and shrunk) centre into `outCenter` and returns its radius. */
  private currentShape(puff: CloudPuff, outCenter: Vector3): number {
    const ease = puff.disturb * puff.disturb * (3 - 2 * puff.disturb);
    outCenter.copy(puff.center).addScaledVector(puff.push, puff.radius * 0.5 * ease);
    return puff.radius * (1 - 0.42 * ease);
  }

  /** Drifts the field with the wind and parts puffs the hero flies through. Call once per sim step (or frame) with sim dt. */
  update(dt: number, heroPosition: Vector3, heroVelocity: Vector3): void {
    this.drift.addScaledVector(WIND, dt);
    this.mesh.position.copy(this.drift);

    const local = this.local.copy(heroPosition).sub(this.drift);
    if (local.y > 400 && local.y < 1100 && heroVelocity.lengthSq() > 25) {
      this.forPuffsNear(local, (puff) => {
        const radius = this.currentShape(puff, this.center);
        const offset = this.center.sub(local);
        if (offset.length() < radius * 0.95 && local.y > puff.cloudBase - 4) {
          // Push the puff sideways, away from the flight line.
          const along = heroVelocity.clone().normalize();
          const away = puff.center.clone().sub(local);
          away.addScaledVector(along, -away.dot(along));
          if (away.lengthSq() < 1e-3) away.set(along.z, 0.3, -along.x);
          puff.push.lerp(away.normalize(), puff.disturb > 0.2 ? 0.2 : 1);
          puff.disturb = 1;
          this.disturbed.add(puff);
        }
      });
    }

    if (this.disturbed.size > 0) {
      for (const puff of this.disturbed) {
        puff.disturb = Math.max(0, puff.disturb - dt / 10);
        const radius = this.currentShape(puff, this.center);
        this.matrix.compose(this.center, this.quaternion, this.scale.setScalar(radius));
        this.mesh.setMatrixAt(puff.index, this.matrix);
        if (puff.disturb === 0) this.disturbed.delete(puff);
      }
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** 0..1: how deep inside a cloud a point is (drives the white-out and muffled wind). */
  immersion(position: Vector3): number {
    const local = this.local.copy(position).sub(this.drift);
    let best = 0;
    this.forPuffsNear(local, (puff) => {
      if (local.y < puff.cloudBase - 3) return;
      const radius = this.currentShape(puff, this.center);
      const d = this.center.distanceTo(local) / radius;
      best = Math.max(best, 1 - smoothstep(0.5, 1.0, d));
    });
    return best;
  }

  /** Top-centre of the largest cloud near a point: a landmark for sparks above the clouds. */
  largestCloudNear(x: number, z: number, maxDistance: number): Cloud | null {
    let best: Cloud | null = null;
    for (const cloud of this.clouds) {
      const d = Math.hypot(cloud.x - x, cloud.z - z);
      if (d > maxDistance) continue;
      if (!best || cloud.size > best.size) best = cloud;
    }
    return best;
  }
}
