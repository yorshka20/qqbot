/**
 * Maps semantic channel names (e.g. "head.yaw", "mouth.smile") to VTube
 * Studio tracking parameter IDs (e.g. "FaceAngleX", "MouthSmile").
 *
 * Channel values are authored in their natural ranges and forwarded to VTS
 * as-is. Channels without an entry in this map are silently skipped when
 * sending to VTS. Adapters for other renderers (Cubism SDK, WebGPU) live
 * next to this file and translate the same channel inventory to their own
 * parameter systems.
 */

export const VTS_CHANNEL_MAP: Record<string, string> = {
  // Head rotation — degrees in [-30, 30]
  'head.yaw': 'FaceAngleX',
  'head.pitch': 'FaceAngleY',
  'head.roll': 'FaceAngleZ',

  // Body offset — normalized in [-1, 1] / depth in [0, 1]
  'body.x': 'FacePositionX',
  'body.y': 'FacePositionY',
  'body.z': 'FacePositionZ',

  // Eyes — [0, 1]
  'eye.open.left': 'EyeOpenLeft',
  'eye.open.right': 'EyeOpenRight',

  // Mouth — [0, 1]
  'mouth.open': 'MouthOpen',
  'mouth.smile': 'MouthSmile',

  // Brows — VTS only exposes a single "Brows" input; both .left and .right
  // map to the same tracking param (the model config decides how to split).
  'brow': 'Brows',
  'brow.left': 'Brows',
  'brow.right': 'Brows',

  // Cheeks — [0, 1]
  'cheek.puff': 'CheekPuff',
};

/**
 * Translate a channel-keyed param bag into a VTS tracking param bag.
 * Drops channels without a VTS mapping (logged by caller if desired).
 */
export function translateChannelsToVTS(
  channels: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [ch, val] of Object.entries(channels)) {
    const vtsId = VTS_CHANNEL_MAP[ch];
    if (vtsId !== undefined) {
      // If multiple channels map to the same VTS param (e.g. brow.left + brow.right
      // → Brows), average them; otherwise just assign.
      if (out[vtsId] !== undefined) {
        out[vtsId] = (out[vtsId] + val) / 2;
      } else {
        out[vtsId] = val;
      }
    }
  }
  return out;
}
