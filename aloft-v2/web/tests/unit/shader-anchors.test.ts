import { ShaderLib } from 'three';
import { describe, expect, test } from 'vitest';
import { afterInclude, PATCHED_CHUNKS, ShaderPatchError } from '../../src/present/render/world/atmosphere';

// Our materials patch three.js's built-in shaders at named chunks. If an upgrade renames or
// removes one, the look would silently break; this fails first.

describe('three.js shader anchors', () => {
  const sources = [ShaderLib.standard.vertexShader, ShaderLib.standard.fragmentShader, ShaderLib.physical.vertexShader, ShaderLib.physical.fragmentShader];

  for (const chunk of PATCHED_CHUNKS) {
    test(`#include <${chunk}> exists in the standard/physical shaders`, () => {
      expect(sources.some((source) => source.includes(`#include <${chunk}>`))).toBe(true);
    });
  }

  test('patching a missing chunk throws instead of silently doing nothing', () => {
    expect(() => afterInclude('void main() {}', 'common', 'float x;', 'test')).toThrow(ShaderPatchError);
  });
});
