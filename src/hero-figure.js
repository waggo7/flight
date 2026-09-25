import * as THREE from 'three';
import { clamp, damp, lerp } from './scalar-math.js';

// The hero: an ivory suit, charcoal gloves and boots, gold belt and crest, crimson cape.
// Built standing (head +Y, facing +Z). A pivot at the navel tips the body 90° into the
// classic flying pose — one fist forward — and back upright to hover, hands on hips.

const JOINTS = [
  'pelvis', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR',
  'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR',
];

const POSES = {
  fly: {
    spine: [0.04, 0, 0], chest: [-0.07, 0, 0], neck: [-0.45, 0, 0], head: [-0.32, 0, 0],
    shoulderR: [-2.9, 0, 0.12], elbowR: [-0.08, 0, 0], wristR: [0, 0, 0],
    shoulderL: [-0.2, 0, 0.22], elbowL: [-0.35, 0, 0], wristL: [0.2, 0, 0],
    hipL: [0.05, 0, 0.05], hipR: [-0.03, 0, -0.05],
    kneeL: [0.42, 0, 0], kneeR: [0.12, 0, 0],
    ankleL: [0.9, 0, 0], ankleR: [0.85, 0, 0],
  },
  hover: {
    spine: [0, 0, 0], chest: [-0.05, 0, 0], neck: [0.05, 0, 0], head: [0.07, 0, 0],
    shoulderL: [0.18, 0, 0.72], elbowL: [0, 0, -1.5], wristL: [0, 0, -0.3],
    shoulderR: [0.18, 0, -0.72], elbowR: [0, 0, 1.5], wristR: [0, 0, 0.3],
    hipL: [-0.05, 0, 0.07], hipR: [-0.45, 0, -0.06],
    kneeL: [0.1, 0, 0], kneeR: [0.85, 0, 0],
    ankleL: [0.35, 0, 0], ankleR: [0.45, 0, 0],
  },
};

function toQuaternions(pose) {
  const result = {};
  for (const name of JOINTS) {
    const [x, y, z] = pose[name] ?? [0, 0, 0];
    result[name] = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
  }
  return result;
}

function withRimLight(material, { strength = 0.35, color = '#ffd9b0', innerShade = 1 } = {}) {
  const rimColor = new THREE.Color(color);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.uniforms.uRimStrength = { value: strength };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRimColor;\nuniform float uRimStrength;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb *= gl_FrontFacing ? 1.0 : ${innerShade.toFixed(2)};`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float rimFacing = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
        totalEmissiveRadiance += uRimColor * pow(rimFacing, 3.0) * uRimStrength;`,
      );
  };
  material.customProgramCacheKey = () => `hero-rim:${strength}:${innerShade}`;
  return material;
}

const MATERIALS = {
  suit: withRimLight(
    new THREE.MeshPhysicalMaterial({
      color: '#ebe5da', roughness: 0.45, sheen: 0.6, sheenColor: new THREE.Color('#fff0da'), sheenRoughness: 0.45,
      clearcoat: 0.25, clearcoatRoughness: 0.5,
    }),
  ),
  trim: withRimLight(new THREE.MeshPhysicalMaterial({ color: '#2a2e38', roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.3 }), { strength: 0.25 }),
  cape: withRimLight(
    new THREE.MeshPhysicalMaterial({
      color: '#a3121c', roughness: 0.6, sheen: 1, sheenColor: new THREE.Color('#ff6d55'), sheenRoughness: 0.35,
      side: THREE.DoubleSide,
    }),
    { strength: 0.3, color: '#ff9a70', innerShade: 0.62 },
  ),
  skin: new THREE.MeshStandardMaterial({ color: '#d69c7a', roughness: 0.6 }),
  hair: new THREE.MeshStandardMaterial({ color: '#221612', roughness: 0.42 }),
  gold: new THREE.MeshStandardMaterial({ color: '#e8b658', metalness: 1, roughness: 0.28 }),
};

export class HeroFigure {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'hero';
    this.body = new THREE.Group();
    this.root.add(this.body);
    this.joints = {};
    this.flyPose = toQuaternions(POSES.fly);
    this.hoverPose = toQuaternions(POSES.hover);
    this.#build();

    // Cape anchors across the upper back, in chest-joint space (left shoulder → right shoulder).
    this.capeAnchorsLocal = [];
    const count = 11;
    for (let i = 0; i < count; i++) {
      const u = i / (count - 1);
      const x = lerp(0.18, -0.18, u);
      const middle = 1 - Math.pow(2 * u - 1, 2);
      this.capeAnchorsLocal.push(new THREE.Vector3(x, 0.27 - middle * 0.025, -0.095 - middle * 0.035));
    }
    this.capeAnchors = new Float32Array(count * 3);
    this.capsule = { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0.19 };
    this._capsuleTop = new THREE.Vector3(0, 0.42, -0.03);
    this._capsuleBottom = new THREE.Vector3(0, -0.95, -0.03);
    this._scratch = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._euler = new THREE.Euler();
    this.time = 0;
    this.fly = 0;
  }

  #joint(name, parent, x, y, z) {
    const joint = new THREE.Group();
    joint.name = name;
    joint.position.set(x, y, z);
    parent.add(joint);
    this.joints[name] = joint;
    return joint;
  }

  #part(parent, geometry, material, { position = [0, 0, 0], scale = [1, 1, 1], rotation = [0, 0, 0] } = {}) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    mesh.rotation.set(...rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  #build() {
    const M = MATERIALS;
    const capsule = (r, l, seg = 14) => new THREE.CapsuleGeometry(r, l, 6, seg);
    const sphere = (r) => new THREE.SphereGeometry(r, 24, 16);

    const pelvis = this.#joint('pelvis', this.body, 0, -0.1, 0);
    this.#part(pelvis, sphere(0.155), M.suit, { scale: [1, 0.72, 0.8] });
    this.#part(pelvis, new THREE.TorusGeometry(0.13, 0.021, 10, 36), M.gold, {
      position: [0, 0.07, 0], rotation: [Math.PI / 2, 0, 0], scale: [1.12, 0.86, 1],
    });

    for (const side of [1, -1]) {
      const tag = side > 0 ? 'L' : 'R';
      const hip = this.#joint(`hip${tag}`, pelvis, 0.095 * side, -0.06, 0);
      this.#part(hip, capsule(0.078, 0.3), M.suit, { position: [0, -0.21, 0] });
      const knee = this.#joint(`knee${tag}`, hip, 0, -0.44, 0);
      this.#part(knee, capsule(0.06, 0.3), M.suit, { position: [0, -0.2, 0] });
      this.#part(knee, capsule(0.067, 0.14), M.trim, { position: [0, -0.33, 0] });
      const ankle = this.#joint(`ankle${tag}`, knee, 0, -0.43, 0);
      this.#part(ankle, capsule(0.05, 0.12, 10), M.trim, { position: [0, -0.02, 0.05], rotation: [Math.PI / 2, 0, 0] });
    }

    const spine = this.#joint('spine', this.body, 0, 0.02, 0);
    this.#part(spine, capsule(0.12, 0.1), M.suit, { position: [0, 0.06, 0], scale: [1.1, 1, 0.85] });
    const chest = this.#joint('chest', spine, 0, 0.16, 0);
    this.#part(chest, capsule(0.15, 0.12), M.suit, { position: [0, 0.12, 0], scale: [1.32, 1, 0.82] });
    this.#part(chest, new THREE.OctahedronGeometry(1, 0), M.gold, { position: [0, 0.14, 0.123], scale: [0.05, 0.072, 0.018] });
    this.#part(chest, sphere(0.022), M.gold, { position: [0.14, 0.25, 0.07] });
    this.#part(chest, sphere(0.022), M.gold, { position: [-0.14, 0.25, 0.07] });

    const neck = this.#joint('neck', chest, 0, 0.3, 0);
    this.#part(neck, new THREE.CylinderGeometry(0.048, 0.055, 0.1, 14), M.skin, { position: [0, 0.03, 0] });
    const head = this.#joint('head', neck, 0, 0.07, 0);
    this.#part(head, sphere(0.108), M.skin, { position: [0, 0.1, 0.005], scale: [0.92, 1.08, 1] });
    this.#part(head, new THREE.SphereGeometry(0.114, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.56), M.hair, {
      position: [0, 0.112, -0.012], rotation: [-0.32, 0, 0], scale: [0.95, 1.05, 1.06],
    });

    for (const side of [1, -1]) {
      const tag = side > 0 ? 'L' : 'R';
      const shoulder = this.#joint(`shoulder${tag}`, chest, 0.2 * side, 0.25, 0);
      this.#part(shoulder, sphere(0.07), M.suit);
      this.#part(shoulder, capsule(0.054, 0.2), M.suit, { position: [0, -0.15, 0] });
      const elbow = this.#joint(`elbow${tag}`, shoulder, 0, -0.29, 0);
      this.#part(elbow, capsule(0.047, 0.17), M.suit, { position: [0, -0.13, 0] });
      this.#part(elbow, capsule(0.053, 0.07), M.trim, { position: [0, -0.2, 0] });
      const wrist = this.#joint(`wrist${tag}`, elbow, 0, -0.26, 0);
      this.#part(wrist, sphere(0.053), M.trim, { position: [0, -0.045, 0.005], scale: [0.9, 1.15, 1.1] });
    }
  }

  get capeMaterial() {
    return MATERIALS.cape;
  }

  // Pose from the flight state; call before reading anchors.
  update(dt, flight, input) {
    this.time += dt;
    this.fly = damp(this.fly, 1 - flight.hoverBlend, 12, dt);
    const fly = this.fly;
    this.root.position.copy(flight.position);
    this.root.quaternion.copy(flight.quaternion);

    this.body.rotation.x = fly * (Math.PI / 2);
    const bob = (1 - fly) * Math.sin(this.time * 1.6) * 0.045;
    this.body.position.set(0, bob, 0);

    const bank = flight.bank;
    const boost = flight.boostBlend;
    for (const name of JOINTS) {
      this.joints[name].quaternion.slerpQuaternions(this.hoverPose[name], this.flyPose[name], fly);
    }

    // Secondary motion layered on top of the base poses.
    const add = (name, x, y, z) => {
      this._quat.setFromEuler(this._euler.set(x, y, z));
      this.joints[name].quaternion.multiply(this._quat);
    };
    const flutter = Math.sin(this.time * 17) * 0.02 * boost * fly;
    add('hipL', 0, 0, bank * 0.12 * fly + flutter);
    add('hipR', 0, 0, bank * 0.12 * fly - flutter);
    add('kneeL', -0.28 * boost * fly, 0, 0);
    add('neck', 0, clamp(-flight.yawRate * 0.18, -0.25, 0.25) * fly, 0);
    add('shoulderR', 0, 0, clamp(-(input?.steerX ?? 0) * 0.1, -0.1, 0.1) * fly);
    const breathe = 1 + Math.sin(this.time * 1.9) * 0.012 * (1 - fly);
    this.joints.chest.scale.set(breathe, 1, breathe);
    add('hipR', Math.sin(this.time * 1.1) * 0.05 * (1 - fly), 0, 0);

    this.root.updateMatrixWorld(true);
  }

  // Cape anchor points and body capsule, relative to the hero root, in world orientation.
  refreshCapeFrame() {
    const origin = this.root.position;
    const chestMatrix = this.joints.chest.matrixWorld;
    this.capeAnchorsLocal.forEach((local, i) => {
      this._scratch.copy(local).applyMatrix4(chestMatrix).sub(origin);
      this.capeAnchors[i * 3] = this._scratch.x;
      this.capeAnchors[i * 3 + 1] = this._scratch.y;
      this.capeAnchors[i * 3 + 2] = this._scratch.z;
    });
    const bodyMatrix = this.body.matrixWorld;
    this.capsule.a.copy(this._capsuleTop).applyMatrix4(bodyMatrix).sub(origin);
    this.capsule.b.copy(this._capsuleBottom).applyMatrix4(bodyMatrix).sub(origin);
    return this.capeAnchors;
  }
}
