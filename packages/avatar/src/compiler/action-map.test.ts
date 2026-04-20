import { describe, expect, it } from 'bun:test';
import { ActionMap } from './action-map';

describe('ActionMap.resolveAction', () => {
  const map = new ActionMap();

  it('returns a ResolvedAction with targets for a known action', () => {
    const result = map.resolveAction('smile', 'happy', 1.0);
    expect(result).not.toBeNull();
    expect(result!.targets).toBeDefined();
    expect(result!.targets.length).toBeGreaterThan(0);
  });

  it('returns null for an unknown action', () => {
    const result = map.resolveAction('nonexistent_action', 'neutral', 1.0);
    expect(result).toBeNull();
  });

  it('scales targets.targetValue by intensity', () => {
    const full = map.resolveAction('smile', 'happy', 1.0);
    const half = map.resolveAction('smile', 'happy', 0.5);
    expect(full).not.toBeNull();
    expect(half).not.toBeNull();
    for (let i = 0; i < full!.targets.length; i++) {
      expect(half!.targets[i].targetValue).toBeCloseTo(full!.targets[i].targetValue * 0.5);
    }
  });

  it('does not scale endPose.value by intensity', () => {
    // cross_arms has endPose entries
    const full = map.resolveAction('cross_arms', 'neutral', 1.0);
    const half = map.resolveAction('cross_arms', 'neutral', 0.5);
    expect(full).not.toBeNull();
    expect(half).not.toBeNull();
    expect(full!.endPose).toBeDefined();
    expect(half!.endPose).toBeDefined();
    // endPose values must be identical regardless of intensity
    for (let i = 0; i < full!.endPose!.length; i++) {
      expect(half!.endPose![i].value).toBe(full!.endPose![i].value);
    }
  });

  it('returns endPose for cross_arms with arm channels only', () => {
    const result = map.resolveAction('cross_arms', 'neutral', 1.0);
    expect(result).not.toBeNull();
    expect(result!.endPose).toBeDefined();
    const channels = result!.endPose!.map((e) => e.channel);
    expect(channels).toContain('arm.left');
    expect(channels).toContain('arm.right');
    // body.z and brow should NOT be in the endPose
    expect(channels).not.toContain('body.z');
    expect(channels).not.toContain('brow');
  });

  it('returns endPose for hand_on_hip with arm.right and body.x', () => {
    const result = map.resolveAction('hand_on_hip', 'neutral', 1.0);
    expect(result).not.toBeNull();
    expect(result!.endPose).toBeDefined();
    const channels = result!.endPose!.map((e) => e.channel);
    expect(channels).toContain('arm.right');
    expect(channels).toContain('body.x');
  });

  it('returns endPose for point_forward with arm.right only', () => {
    const result = map.resolveAction('point_forward', 'neutral', 1.0);
    expect(result).not.toBeNull();
    expect(result!.endPose).toBeDefined();
    const channels = result!.endPose!.map((e) => e.channel);
    expect(channels).toContain('arm.right');
    // head and body should NOT persist in endPose
    expect(channels).not.toContain('head.pitch');
    expect(channels).not.toContain('body.z');
  });

  it('endPose.value is smaller than the corresponding param peak', () => {
    // For point_forward, arm.right endPose.value should be less than params targetValue
    const result = map.resolveAction('point_forward', 'neutral', 1.0);
    expect(result).not.toBeNull();
    const armTarget = result!.targets.find((t) => t.channel === 'arm.right');
    const armEnd = result!.endPose!.find((e) => e.channel === 'arm.right');
    expect(armTarget).toBeDefined();
    expect(armEnd).toBeDefined();
    expect(armEnd!.value).toBeLessThan(armTarget!.targetValue);
  });
});

describe('ActionMap.listActions', () => {
  const map = new ActionMap();

  it('exposes description and category for cross_arms', () => {
    const actions = map.listActions();
    const entry = actions.find((a) => a.name === 'cross_arms');
    expect(entry).toBeDefined();
    expect(entry!.description).toBeTruthy();
    expect(entry!.category).toBe('movement');
  });

  it('exposes description and category for hand_on_hip', () => {
    const actions = map.listActions();
    const entry = actions.find((a) => a.name === 'hand_on_hip');
    expect(entry).toBeDefined();
    expect(entry!.description).toBeTruthy();
    expect(entry!.category).toBe('movement');
  });

  it('exposes description and category for point_forward', () => {
    const actions = map.listActions();
    const entry = actions.find((a) => a.name === 'point_forward');
    expect(entry).toBeDefined();
    expect(entry!.description).toBeTruthy();
    expect(entry!.category).toBe('movement');
  });

  it('lists channels for new actions', () => {
    const actions = map.listActions();
    const crossArms = actions.find((a) => a.name === 'cross_arms');
    expect(crossArms!.channels).toContain('arm.left');
    expect(crossArms!.channels).toContain('arm.right');

    const pointFwd = actions.find((a) => a.name === 'point_forward');
    expect(pointFwd!.channels).toContain('arm.right');
  });
});
