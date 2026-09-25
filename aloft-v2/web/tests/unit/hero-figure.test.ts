import { Quaternion, ShaderLib, Vector3 } from 'three';
import type { Vector3Like, WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { FlightControls, FlightModel } from '../../src/core/flight-model';
import type { FlightSnapshot } from '../../src/features/flight-feature';
import { CapeCloth } from '../../src/present/render/hero/cape-cloth';
import { createHeroMaterials, HERO_JOINTS, HeroFigure, type HeroFlightState, type HeroSteering } from '../../src/present/render/hero/hero-figure';

const DT = 1 / 60;

// Only the fields the rig reads, like FlightModel / FlightSnapshot.
function stubFlight(hoverBlend: number) {
  return {
    position: new Vector3(12, 60, -30),
    quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7),
    hoverBlend,
    bank: 0.25,
    boostBlend: 0.8,
    yawRate: -0.6,
  };
}

function allFinite(values: ArrayLike<number>): boolean {
  return Array.from(values).every(Number.isFinite);
}

describe('hero figure', () => {
  test('takes the flight model or the interpolated snapshot, and the flight controls', () => {
    expectTypeOf<FlightModel>().toExtend<HeroFlightState>();
    expectTypeOf<FlightSnapshot>().toExtend<HeroFlightState>();
    expectTypeOf<FlightControls>().toExtend<HeroSteering>();
    // The cape steps with the model's velocity and either one's acceleration.
    expectTypeOf<FlightModel['velocity']>().toExtend<Vector3Like>();
    expectTypeOf<FlightSnapshot['acceleration']>().toExtend<Vector3Like>();
  });

  test('builds all 17 joints and poses them to finite unit quaternions and cape anchors', () => {
    const hero = new HeroFigure();
    expect(Object.keys(hero.joints).sort()).toEqual([...HERO_JOINTS].sort());
    for (let i = 0; i < 180; i++) hero.update(DT, stubFlight(Math.max(0, 1 - i / 90)), { steerX: 0.6 });

    for (const name of HERO_JOINTS) {
      const q = hero.joints[name].quaternion;
      expect(allFinite([q.x, q.y, q.z, q.w]), name).toBe(true);
      expect(q.length()).toBeCloseTo(1, 6);
    }
    const anchors = hero.refreshCapeFrame();
    expect(anchors).toHaveLength(33);
    expect(allFinite(anchors)).toBe(true);
    for (let i = 0; i < anchors.length; i += 3) {
      // Relative to the hero root: on the upper back, never far from the body.
      expect(Math.hypot(anchors[i], anchors[i + 1], anchors[i + 2])).toBeLessThan(1);
    }
    const { a, b, radius } = hero.capsule;
    expect(allFinite([a.x, a.y, a.z, b.x, b.y, b.z])).toBe(true);
    expect(a.distanceTo(b)).toBeCloseTo(1.37, 5);
    expect(radius).toBe(0.19);
  });

  test('tips the body flat to fly and stands it upright to hover', () => {
    const hero = new HeroFigure();
    for (let i = 0; i < 120; i++) hero.update(DT, stubFlight(0));
    expect(hero.fly).toBeGreaterThan(0.99);
    expect(hero.body.rotation.x).toBeCloseTo(Math.PI / 2, 2);
    expect(hero.root.position.toArray()).toEqual([12, 60, -30]);
    for (let i = 0; i < 120; i++) hero.update(DT, stubFlight(1), null);
    expect(hero.fly).toBeLessThan(0.01);
    expect(hero.body.rotation.x).toBeCloseTo(0, 2);
  });

  test('drives the cape: drape and step from its anchors and capsule stay finite', () => {
    const hero = new HeroFigure();
    const cape = new CapeCloth();
    const flight = stubFlight(0);
    hero.update(0, flight);
    cape.drape(hero.refreshCapeFrame(), new Vector3(0, -1, 0), new Vector3(0, 0, -1).applyQuaternion(flight.quaternion));
    const velocity = new Vector3(0, 0, 60).applyQuaternion(flight.quaternion);
    for (let i = 0; i < 120; i++) {
      hero.update(DT, flight);
      cape.setAnchors(hero.refreshCapeFrame());
      cape.step(DT, velocity, new Vector3(), hero.capsule);
    }
    expect(cape.isFinite()).toBe(true);
  });

  test('gets its own materials unless given a shared set', () => {
    const first = new HeroFigure();
    const second = new HeroFigure();
    expect(first.capeMaterial).not.toBe(second.capeMaterial);
    const shared = createHeroMaterials();
    expect(new HeroFigure(shared).capeMaterial).toBe(shared.cape);
    expect(new HeroFigure(shared).materials.suit).toBe(shared.suit);
  });

  test('the rim light patches three’s physical shader at the checked chunks', () => {
    const { cape } = createHeroMaterials();
    const shader = {
      uniforms: {},
      vertexShader: ShaderLib.physical.vertexShader,
      fragmentShader: ShaderLib.physical.fragmentShader,
    } as unknown as WebGLProgramParametersWithUniforms;
    cape.onBeforeCompile(shader, {} as unknown as WebGLRenderer);
    const fragment = shader.fragmentShader;
    expect(fragment).toContain('#include <common>\nuniform vec3 uRimColor;\nuniform float uRimStrength;');
    expect(fragment).toContain('#include <color_fragment>\ndiffuseColor.rgb *= gl_FrontFacing ? 1.0 : 0.62;');
    expect(fragment).toContain('totalEmissiveRadiance += uRimColor * pow(rimFacing, 3.0) * uRimStrength;');
    expect(fragment.indexOf('uRimStrength;')).toBeLessThan(fragment.indexOf('void main'));
    expect(shader.uniforms.uRimStrength?.value).toBe(0.3);
    expect(cape.customProgramCacheKey()).toBe('hero-rim:0.3:0.62');
  });
});
