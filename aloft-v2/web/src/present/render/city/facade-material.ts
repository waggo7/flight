import { DoubleSide, FrontSide, MeshStandardMaterial, Vector4 } from 'three';
import { FaceBit } from '../../../core/structure-regions';
import { afterInclude, applyAtmosphere, NOISE_GLSL } from '../world/atmosphere';

// One facade material for everything built: intact pieces, falling bands and loose chunks.
// Windows, lit panes, streaks and street grime are computed in *building space* (a position
// within the piece's tier), not per instance, so a tower split into chunks looks exactly like
// the intact tower did — activation never pops. Faces that were inside the building (fracture
// surfaces) draw broken concrete with floor-slab lines instead of windows.
//
// Per-instance attributes (all flat):
//   aFacade  = (style, seed, glassTint, litFraction)              — as v1
//   aGrid    = (storeyHeight, columnsX, columnsZ, _)              — core/storey-layout.ts
//   aTier    = (tierWidth, tierHeight, tierDepth, tierBaseY)      — the whole piece
//   aChunk   = (offsetX, offsetY, offsetZ, exteriorMask)          — this instance's min corner in the tier;
//              mask bits: 1 +x, 2 −x, 4 +y, 8 −y, 16 +z, 32 −z (1 = outside face)
// An intact piece is one instance with offset 0 and mask 63 minus the bottom (55).

export const DAMAGE_SLOTS = 16;
/** Scorch marks from impacts, shared by every facade material (ring buffer of world spheres). */
export const damageUniform = { value: Array.from({ length: DAMAGE_SLOTS }, () => new Vector4(0, -1e5, 0, 0)) };

/** Exterior-face bits (the convention lives in core so structure regions share it). */
export const EXTERIOR = FaceBit;
/** Every face outside except the base (sits on the ground or the piece below). */
export const INTACT_EXTERIOR_MASK = EXTERIOR.px | EXTERIOR.nx | EXTERIOR.py | EXTERIOR.pz | EXTERIOR.nz;

export type FacadeShape = 'box' | 'round';

export function createFacadeMaterial(shape: FacadeShape, { doubleSided = false }: { doubleSided?: boolean } = {}): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    roughness: 0.8,
    metalness: 0,
    envMapIntensity: 1,
    side: doubleSided ? DoubleSide : FrontSide,
  });
  const key = `facade-${shape}${doubleSided ? '-double' : ''}`;
  return applyAtmosphere(material, {
    key,
    patch: (shader) => {
      const where = `facade ${shape}`;
      shader.uniforms.uDamage = damageUniform;
      let vertex = afterInclude(
        shader.vertexShader,
        'common',
        `attribute vec4 aFacade;
        attribute vec4 aGrid;
        attribute vec4 aTier;
        attribute vec4 aChunk;
        flat varying vec4 vFacade;
        flat varying vec4 vGrid;
        flat varying vec4 vTier;
        flat varying float vExterior;
        varying vec3 vTierLocal;
        varying vec3 vFacadeNormal;`,
        where,
      );
      vertex = afterInclude(
        vertex,
        'begin_vertex',
        `vec3 facadeScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        // Unit geometry spans x,z in [-0.5, 0.5] and y in [0, 1]; map it into the tier.
        vTierLocal = aChunk.xyz + (position + vec3(0.5, 0.0, 0.5)) * facadeScale;
        vFacadeNormal = normal;
        vFacade = aFacade;
        vGrid = aGrid;
        vTier = aTier;
        vExterior = aChunk.w;`,
        where,
      );
      let fragment = afterInclude(
        shader.fragmentShader,
        'common',
        `${NOISE_GLSL}
        uniform vec4 uDamage[${DAMAGE_SLOTS}];
        flat varying vec4 vFacade;
        flat varying vec4 vGrid;
        flat varying vec4 vTier;
        flat varying float vExterior;
        varying vec3 vTierLocal;
        varying vec3 vFacadeNormal;`,
        where,
      );
      fragment = afterInclude(
        fragment,
        'color_fragment',
        `float glassStyle = 1.0 - step(0.5, vFacade.x);
        float plainStyle = step(1.5, vFacade.x);
        vec3 facadeN = normalize(vFacadeNormal);
        float wall = 1.0 - step(0.5, abs(facadeN.y));
        float faceIndex = abs(facadeN.x) > 0.5 ? (facadeN.x > 0.0 ? 0.0 : 1.0)
          : abs(facadeN.y) > 0.5 ? (facadeN.y > 0.0 ? 2.0 : 3.0)
          : (facadeN.z > 0.0 ? 4.0 : 5.0);
        ${shape === 'round'
          // Round pieces: side faces are always outside; only caps can be fracture surfaces.
          ? 'float exterior = wall > 0.5 ? 1.0 : mod(floor(vExterior / exp2(faceIndex)), 2.0);'
          : 'float exterior = mod(floor(vExterior / exp2(faceIndex)), 2.0);'}
        ${shape === 'round'
          ? `vec2 facadeRadial = vTierLocal.xz - vTier.xz * 0.5;
             float cellU = (atan(facadeRadial.y, facadeRadial.x) / 6.2831853 + 0.5) * vGrid.y;`
          : `float cellU = abs(facadeN.x) > 0.5 ? vTierLocal.z / vTier.z * vGrid.z : vTierLocal.x / vTier.x * vGrid.y;`}
        float buildingHeight = vTier.w + vTierLocal.y;
        float cellV = vTierLocal.y / vGrid.x;
        vec2 cell = vec2(cellU, cellV);
        vec2 cellId = floor(cell);
        vec2 cellF = fract(cell);
        vec2 cellFw = fwidth(cell);
        vec2 paneLo = mix(vec2(0.2, 0.25), vec2(0.07, 0.12), glassStyle);
        vec2 paneHi = mix(vec2(0.8, 0.8), vec2(0.93, 0.95), glassStyle);
        vec2 inLo = smoothstep(paneLo - cellFw, paneLo + cellFw, cellF);
        vec2 inHi = 1.0 - smoothstep(paneHi - cellFw, paneHi + cellFw, cellF);
        float pane = inLo.x * inLo.y * inHi.x * inHi.y;
        float paneAverage = (paneHi.x - paneLo.x) * (paneHi.y - paneLo.y);
        float farBlend = smoothstep(0.3, 0.85, max(cellFw.x, cellFw.y));
        pane = mix(pane, paneAverage, farBlend) * wall * (1.0 - plainStyle) * exterior;

        // Scorch and blown-out windows around impacts.
        float scorch = 0.0;
        for (int i = 0; i < ${DAMAGE_SLOTS}; i++) {
          vec4 damage = uDamage[i];
          if (damage.w <= 0.0) continue;
          float reach = length(vAerialWorld - damage.xyz) / damage.w;
          if (reach > 1.4) continue;
          float jag = valueNoise(vAerialWorld.xz * 0.23 + vAerialWorld.y * 0.19 + float(i) * 7.3);
          scorch = max(scorch, 1.0 - smoothstep(0.4, 1.05, reach + (jag - 0.5) * 0.6));
        }
        pane *= 1.0 - smoothstep(0.15, 0.55, scorch);

        // Opposite faces get their own lit pattern (faceIndex in the hash).
        float windowLit = step(hash12(cellId + vec2(faceIndex * 37.0, floor(vFacade.y * 997.0))), vFacade.w) * pane * (1.0 - farBlend * 0.8);
        vec3 glassTint = vFacade.z < 0.5 ? vec3(0.1, 0.15, 0.22)
          : vFacade.z < 1.5 ? vec3(0.07, 0.15, 0.16)
          : vFacade.z < 2.5 ? vec3(0.21, 0.13, 0.08)
          : vec3(0.17, 0.18, 0.2);
        diffuseColor.rgb = mix(diffuseColor.rgb, glassTint, pane);

        // Weathering: rain streaks down the walls, soot at street level, patchy roofs. Heights are
        // building heights, so a falling chunk keeps the grime it had.
        float streaks = valueNoise(vec2(cellU * 0.45 + vFacade.y * 31.0, buildingHeight * 0.035));
        float grime = wall * smoothstep(0.45, 0.95, streaks) * 0.16 * (1.0 - farBlend * 0.5);
        grime += (1.0 - wall) * valueNoise(vTierLocal.xz * 0.12 + vFacade.y * 9.0) * 0.18;
        diffuseColor.rgb *= 1.0 - grime * exterior;
        diffuseColor.rgb *= mix(0.48, 1.0, smoothstep(4.0, 48.0, buildingHeight));
        diffuseColor.rgb *= mix(0.72, 1.0, wall);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045, 0.04, 0.036), scorch * 0.9);

        // Fracture surfaces: dark broken concrete, a slab line at every storey, rebar flecks.
        if (exterior < 0.5) {
          float slab = 1.0 - smoothstep(0.0, 0.08 + cellFw.y, abs(fract(cellV + 0.5) - 0.5) * 2.0);
          float rubble = valueNoise(vTierLocal.xz * 1.7 + vTierLocal.y * 0.9) * 0.5 + valueNoise(vTierLocal.zy * 4.3) * 0.5;
          vec3 concrete = mix(vec3(0.16, 0.15, 0.14), vec3(0.3, 0.28, 0.26), rubble);
          concrete = mix(concrete, vec3(0.42, 0.4, 0.37), slab * wall);
          float rebar = step(0.965, hash12(floor(vTierLocal.xz * 3.0 + vTierLocal.y * 2.0)));
          concrete = mix(concrete, vec3(0.23, 0.12, 0.07), rebar * 0.8);
          diffuseColor.rgb = concrete;
          windowLit = 0.0;
        }`,
        where,
      );
      fragment = afterInclude(fragment, 'roughnessmap_fragment', 'roughnessFactor = mix(roughnessFactor, 0.1, pane);', where);
      fragment = afterInclude(fragment, 'metalnessmap_fragment', 'metalnessFactor = mix(metalnessFactor, mix(0.55, 0.88, glassStyle), pane);', where);
      fragment = afterInclude(fragment, 'emissivemap_fragment', 'totalEmissiveRadiance += vec3(1.0, 0.62, 0.32) * windowLit * 0.9;', where);
      shader.vertexShader = vertex;
      shader.fragmentShader = fragment;
    },
  });
}

export function createSpireMaterial(): MeshStandardMaterial {
  return applyAtmosphere(new MeshStandardMaterial({ color: '#d9d2c6', metalness: 0.9, roughness: 0.28 }), { key: 'spire' });
}
