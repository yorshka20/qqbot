import type { ChannelInfo } from './types';

/**
 * Canonical registry of every semantic channel the avatar system drives.
 *
 * This is the **single source of truth** for "what channels exist" in the
 * animation pipeline. Layers, the action map, and the compiler all produce
 * values keyed on these channel ids. Drivers (VTS, preview-to-renderer)
 * translate channels to their native parameter systems.
 *
 * Channel inventory is defined *against the Cubism SDK* — each entry's
 * `cubismParam` field is the Live2D parameter it conceptually represents.
 * VTS aliases (`vtsParam`) are optional: when absent, the VTS driver simply
 * drops that channel from its frame.
 */
export const CHANNELS: ChannelInfo[] = [
  // ── Head rotation — degrees in [-30, 30]. Natural Cubism ParamAngle* unit. ──
  {
    id: 'head.yaw',
    range: [-30, 30],
    description: 'Head rotation around vertical axis (left/right turn), degrees',
    cubismParam: 'ParamAngleX',
    vtsParam: 'FaceAngleX',
  },
  {
    id: 'head.pitch',
    range: [-30, 30],
    description: 'Head rotation around horizontal axis (up/down tilt), degrees',
    cubismParam: 'ParamAngleY',
    vtsParam: 'FaceAngleY',
  },
  {
    id: 'head.roll',
    range: [-30, 30],
    description: 'Head rotation around depth axis (side-to-side tilt), degrees',
    cubismParam: 'ParamAngleZ',
    vtsParam: 'FaceAngleZ',
  },

  // ── Body offset — normalized [-1, 1] on the bot, scaled ×30 on renderer to
  //    reach Cubism ParamBodyAngle* degrees. Scale carried here for docs only;
  //    the renderer's channel map owns the operational copy. ──
  {
    id: 'body.x',
    range: [-1, 1],
    description: 'Body sway left/right (normalized; scales to BodyAngleX degrees)',
    cubismParam: 'ParamBodyAngleX',
    cubismScale: 30,
    vtsParam: 'FacePositionX',
  },
  {
    id: 'body.y',
    range: [-1, 1],
    description: 'Body sway up/down (normalized; scales to BodyAngleY degrees)',
    cubismParam: 'ParamBodyAngleY',
    cubismScale: 30,
    vtsParam: 'FacePositionY',
  },
  {
    id: 'body.z',
    range: [0, 1],
    description: 'Body depth / lean (normalized; scales to BodyAngleZ degrees)',
    cubismParam: 'ParamBodyAngleZ',
    cubismScale: 30,
    vtsParam: 'FacePositionZ',
  },

  // ── Eyes ──
  {
    id: 'eye.open.left',
    range: [0, 1],
    description: 'Left eye openness (0 = closed, 1 = fully open)',
    cubismParam: 'ParamEyeLOpen',
    vtsParam: 'EyeOpenLeft',
  },
  {
    id: 'eye.open.right',
    range: [0, 1],
    description: 'Right eye openness (0 = closed, 1 = fully open)',
    cubismParam: 'ParamEyeROpen',
    vtsParam: 'EyeOpenRight',
  },
  {
    id: 'eye.ball.x',
    range: [-1, 1],
    description: 'Eye-ball gaze horizontal (left/right look direction)',
    cubismParam: 'ParamEyeBallX',
    vtsParam: 'EyeRightX',
  },
  {
    id: 'eye.ball.y',
    range: [-1, 1],
    description: 'Eye-ball gaze vertical (up/down look direction)',
    cubismParam: 'ParamEyeBallY',
    vtsParam: 'EyeRightY',
  },

  // ── Mouth ──
  {
    id: 'mouth.open',
    range: [0, 1],
    description: 'Mouth openness (for lip sync / surprise)',
    cubismParam: 'ParamMouthOpenY',
    vtsParam: 'MouthOpen',
  },
  {
    id: 'mouth.smile',
    range: [-1, 1],
    description: 'Mouth deformation (-1 = frown, 0 = neutral, +1 = smile)',
    cubismParam: 'ParamMouthForm',
    vtsParam: 'MouthSmile',
  },

  // ── Brows — Cubism has separate L/R form params; VTS exposes a single
  //    averaged "Brows" input. The bare `brow` channel drives BOTH brow L/R
  //    on the Cubism side (fan-out handled in the renderer), and just maps
  //    to the single VTS param here. ──
  {
    id: 'brow',
    range: [-1, 1],
    description: 'Both-brow deformation (-1 = furrowed, +1 = raised)',
    cubismParam: 'ParamBrowLForm',
    vtsParam: 'Brows',
  },
  {
    id: 'brow.left',
    range: [-1, 1],
    description: 'Left brow deformation',
    cubismParam: 'ParamBrowLForm',
    vtsParam: 'Brows',
  },
  {
    id: 'brow.right',
    range: [-1, 1],
    description: 'Right brow deformation',
    cubismParam: 'ParamBrowRForm',
    vtsParam: 'Brows',
  },

  // ── Cheek ──
  {
    id: 'cheek.puff',
    range: [0, 1],
    description: 'Cheek blush / puff intensity',
    cubismParam: 'ParamCheek',
    vtsParam: 'CheekPuff',
  },

  // ── Breath — single biggest "is the character alive?" signal on Cubism.
  //    No VTS equivalent (VTS tracking doesn't derive a breath signal).
  {
    id: 'breath',
    range: [0, 1],
    description: 'Chest-rise / breath shape (0 = exhaled, 1 = inhaled)',
    cubismParam: 'ParamBreath',
    // vtsParam intentionally omitted.
  },
];

/** O(1) lookup from channel id → info. */
export const CHANNEL_BY_ID: ReadonlyMap<string, ChannelInfo> = new Map(CHANNELS.map((c) => [c.id, c]));

/**
 * Translate a channel-keyed param bag into a VTS tracking param bag. Channels
 * without a `vtsParam` alias are silently dropped. When multiple channels
 * alias the same VTS param (e.g. `brow.left` + `brow.right` → `Brows`), the
 * values are averaged — matches the previous behavior in `vts-channel-map`.
 */
export function translateChannelsToVTS(channels: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [ch, val] of Object.entries(channels)) {
    const info = CHANNEL_BY_ID.get(ch);
    const vtsId = info?.vtsParam;
    if (!vtsId) continue;
    out[vtsId] = out[vtsId] === undefined ? val : (out[vtsId] + val) / 2;
  }
  return out;
}
