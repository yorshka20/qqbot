import { describe, expect, it } from 'bun:test';
import { VRM_CHANNEL_BY_ID, VRM_CHANNELS } from './vrm-registry';

describe('vrm-registry', () => {
  it('contains at least 63 channels (20 bones × 3 axes + 3 root)', () => {
    expect(VRM_CHANNELS.length).toBeGreaterThanOrEqual(63);
  });

  it('has canonical bone channels', () => {
    for (const id of ['vrm.hips.x', 'vrm.head.y', 'vrm.leftUpperArm.z', 'vrm.rightFoot.z']) {
      expect(VRM_CHANNEL_BY_ID.get(id)).toBeDefined();
    }
  });

  it('has root motion channels', () => {
    expect(VRM_CHANNEL_BY_ID.get('vrm.root.x')).toBeDefined();
    expect(VRM_CHANNEL_BY_ID.get('vrm.root.z')).toBeDefined();
    expect(VRM_CHANNEL_BY_ID.get('vrm.root.rotY')).toBeDefined();
  });

  it('omits cubismParam and vtsParam for every vrm channel', () => {
    for (const c of VRM_CHANNELS) {
      expect(c.cubismParam).toBeUndefined();
      expect(c.vtsParam).toBeUndefined();
      expect(c.id.startsWith('vrm.')).toBe(true);
    }
  });
});
