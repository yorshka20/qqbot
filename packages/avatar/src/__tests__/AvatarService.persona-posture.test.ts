import 'reflect-metadata';

import { describe, expect, mock, test } from 'bun:test';
import { AvatarService } from '../AvatarService';
import type { PersonaPostureBias } from '../compiler/layers/PersonaPostureLayer';

// ─────────────────────────────────────────────────────────────────────────────
// setPersonaPostureBias — no-op safety
// ─────────────────────────────────────────────────────────────────────────────

describe('AvatarService.setPersonaPostureBias — before compiler init', () => {
  test('does not throw when compiler is null', () => {
    const s = new AvatarService();
    // No initialize() call — compiler stays null
    expect(() => s.setPersonaPostureBias({})).not.toThrow();
  });

  test('does not throw with partial bias before init', () => {
    const s = new AvatarService();
    expect(() => s.setPersonaPostureBias({ postureLean: 0.3, headTiltBias: -0.1 })).not.toThrow();
  });

  test('does not throw with all fields populated before init', () => {
    const s = new AvatarService();
    expect(() =>
      s.setPersonaPostureBias({
        postureLean: 0.5,
        headTiltBias: 0.2,
        gazeContactPreference: 0.8,
      }),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setPersonaPostureBias — forwarding to fake layer
// ─────────────────────────────────────────────────────────────────────────────

describe('AvatarService.setPersonaPostureBias — forwarding to layer', () => {
  /** Build a minimal fake compiler that returns the given layer for 'persona-posture'. */
  function makeCompilerWithPostureLayer(layer: object | undefined) {
    return {
      getLayer: mock((id: string) => (id === 'persona-posture' ? layer : undefined)),
    };
  }

  test('forwards exact partial bias object to setBias', () => {
    const s = new AvatarService();
    const setBias = mock((_bias: PersonaPostureBias) => {});
    const fakeLayer = { setBias };
    (s as any).compiler = makeCompilerWithPostureLayer(fakeLayer);

    const bias: PersonaPostureBias = { postureLean: 0.4, headTiltBias: -0.2 };
    s.setPersonaPostureBias(bias);

    expect(setBias).toHaveBeenCalledTimes(1);
    expect(setBias.mock.calls[0][0]).toEqual(bias);
  });

  test('forwards all three fields when provided', () => {
    const s = new AvatarService();
    const setBias = mock((_bias: PersonaPostureBias) => {});
    (s as any).compiler = makeCompilerWithPostureLayer({ setBias });

    const bias: PersonaPostureBias = {
      postureLean: 0.7,
      headTiltBias: 0.1,
      gazeContactPreference: 0.9,
    };
    s.setPersonaPostureBias(bias);

    expect(setBias.mock.calls[0][0]).toEqual(bias);
  });

  test('setPersonaPostureBias({}) does not throw and calls setBias with empty object', () => {
    const s = new AvatarService();
    const setBias = mock((_bias: PersonaPostureBias) => {});
    (s as any).compiler = makeCompilerWithPostureLayer({ setBias });

    expect(() => s.setPersonaPostureBias({})).not.toThrow();
    expect(setBias).toHaveBeenCalledTimes(1);
    expect(setBias.mock.calls[0][0]).toEqual({});
  });

  test('no-op when compiler has no persona-posture layer (getLayer returns undefined)', () => {
    const s = new AvatarService();
    (s as any).compiler = makeCompilerWithPostureLayer(undefined);

    // Should not throw even though layer is absent
    expect(() => s.setPersonaPostureBias({ postureLean: 0.5 })).not.toThrow();
  });

  test('no-op when layer exists but has no setBias method', () => {
    const s = new AvatarService();
    // Layer object without setBias
    (s as any).compiler = makeCompilerWithPostureLayer({ someOtherMethod: () => {} });

    expect(() => s.setPersonaPostureBias({ postureLean: 0.3 })).not.toThrow();
  });

  test('only the persona-posture layer id is queried', () => {
    const s = new AvatarService();
    const getLayer = mock((_id: string) => undefined);
    (s as any).compiler = { getLayer };

    s.setPersonaPostureBias({ headTiltBias: 0.1 });

    expect(getLayer).toHaveBeenCalledTimes(1);
    expect(getLayer.mock.calls[0][0]).toBe('persona-posture');
  });
});
