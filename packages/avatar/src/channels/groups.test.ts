import { describe, expect, test } from 'bun:test';
import { CHANNEL_GROUP_CHILDREN, CHANNEL_GROUP_IDS, CHANNEL_GROUPS, getChannelGroup } from './groups';
import { CHANNELS } from './registry';
import { VRM_CHANNELS } from './vrm-registry';

describe('getChannelGroup', () => {
  test('cubism head channels', () => {
    expect(getChannelGroup('head.yaw')).toBe('head');
    expect(getChannelGroup('head.pitch')).toBe('head');
    expect(getChannelGroup('head.roll')).toBe('head');
  });

  test('cubism body channels', () => {
    expect(getChannelGroup('body.x')).toBe('body');
    expect(getChannelGroup('body.y')).toBe('body');
    expect(getChannelGroup('body.z')).toBe('body');
  });

  test('cubism arm channels', () => {
    expect(getChannelGroup('arm.left')).toBe('arm');
    expect(getChannelGroup('arm.right')).toBe('arm');
  });

  test('cubism face sub-groups are disjoint', () => {
    expect(getChannelGroup('eye.open.left')).toBe('eye');
    expect(getChannelGroup('eye.ball.x')).toBe('eye');
    expect(getChannelGroup('eye.smile.left')).toBe('eye');
    expect(getChannelGroup('mouth.open')).toBe('mouth');
    expect(getChannelGroup('mouth.smile')).toBe('mouth');
    expect(getChannelGroup('brow')).toBe('brow');
    expect(getChannelGroup('brow.left')).toBe('brow');
    expect(getChannelGroup('cheek.puff')).toBe('cheek');
  });

  test('breath is its own group', () => {
    expect(getChannelGroup('breath')).toBe('breath');
  });

  test('vrm head/neck → head', () => {
    expect(getChannelGroup('vrm.head.x')).toBe('head');
    expect(getChannelGroup('vrm.neck.y')).toBe('head');
  });

  test('vrm torso bones → body', () => {
    expect(getChannelGroup('vrm.hips.x')).toBe('body');
    expect(getChannelGroup('vrm.spine.y')).toBe('body');
    expect(getChannelGroup('vrm.chest.z')).toBe('body');
    expect(getChannelGroup('vrm.upperChest.x')).toBe('body');
  });

  test('vrm arm bones → arm', () => {
    expect(getChannelGroup('vrm.leftShoulder.x')).toBe('arm');
    expect(getChannelGroup('vrm.leftUpperArm.z')).toBe('arm');
    expect(getChannelGroup('vrm.rightLowerArm.y')).toBe('arm');
    expect(getChannelGroup('vrm.rightHand.x')).toBe('arm');
  });

  test('vrm leg bones → leg', () => {
    expect(getChannelGroup('vrm.leftUpperLeg.x')).toBe('leg');
    expect(getChannelGroup('vrm.rightFoot.z')).toBe('leg');
  });

  test('vrm root → root', () => {
    expect(getChannelGroup('vrm.root.x')).toBe('root');
    expect(getChannelGroup('vrm.root.z')).toBe('root');
    expect(getChannelGroup('vrm.root.rotY')).toBe('root');
  });

  test('vrm expression → expression', () => {
    expect(getChannelGroup('vrm.expression.happy')).toBe('expression');
    expect(getChannelGroup('vrm.expression.neutral')).toBe('expression');
  });

  test('unknown channel returns undefined', () => {
    expect(getChannelGroup('unknown.channel')).toBeUndefined();
    expect(getChannelGroup('vrm.unknownBone.x')).toBeUndefined();
    expect(getChannelGroup('nonsense')).toBeUndefined();
  });
});

describe('CHANNEL_GROUPS precomputed map', () => {
  test('every registered cubism channel is classified', () => {
    for (const ch of CHANNELS) {
      expect(getChannelGroup(ch.id)).toBeDefined();
    }
  });

  test('every registered vrm channel is classified', () => {
    for (const ch of VRM_CHANNELS) {
      expect(getChannelGroup(ch.id)).toBeDefined();
    }
  });

  test('groups are disjoint — no channel appears in two groups', () => {
    const seen = new Map<string, string>();
    for (const group of CHANNEL_GROUP_IDS) {
      if (group === 'face') continue; // umbrella, intentionally empty
      for (const ch of CHANNEL_GROUPS[group]) {
        const prev = seen.get(ch);
        if (prev) throw new Error(`channel ${ch} appears in both ${prev} and ${group}`);
        seen.set(ch, group);
      }
    }
  });

  test('face umbrella is empty by design', () => {
    expect(CHANNEL_GROUPS.face).toEqual([]);
  });

  test('CHANNEL_GROUP_CHILDREN.face covers 4 sub-groups', () => {
    expect(CHANNEL_GROUP_CHILDREN.face).toEqual(['eye', 'mouth', 'brow', 'cheek']);
  });
});
