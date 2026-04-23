import { describe, expect, test } from 'bun:test';
import { AmbientAudioLayer } from '../AmbientAudioLayer';

// Test A: AmbientAudioLayer tunable params API

describe('AmbientAudioLayer tunable params', () => {
  test('getTunableParams() returns 5 entries with expected ids', () => {
    const layer = new AmbientAudioLayer();
    const params = layer.getTunableParams();
    expect(params).toHaveLength(5);
    const ids = params.map((p) => p.id);
    expect(ids).toContain('silenceFloor');
    expect(ids).toContain('powerExponent');
    expect(ids).toContain('bodyZMax');
    expect(ids).toContain('browMax');
    expect(ids).toContain('smoothingAlpha');
  });

  test('setTunableParam updates bodyZMax visible in getTunableParams', () => {
    const layer = new AmbientAudioLayer();
    layer.setTunableParam('bodyZMax', 2.0);
    const params = layer.getTunableParams();
    const bodyZMax = params.find((p) => p.id === 'bodyZMax');
    expect(bodyZMax?.value).toBe(2.0);
  });

  test('setTunableParam with unknown id does not throw and leaves other values unchanged', () => {
    const layer = new AmbientAudioLayer();
    const before = layer.getTunableParams();
    const silenceFloorBefore = before.find((p) => p.id === 'silenceFloor')!.value;

    expect(() => layer.setTunableParam('no-such-id', 99)).not.toThrow();

    const after = layer.getTunableParams();
    const silenceFloorAfter = after.find((p) => p.id === 'silenceFloor')!.value;
    expect(silenceFloorAfter).toBe(silenceFloorBefore);
  });
});
