/**
 * Metadata for a single semantic channel in the avatar system.
 *
 * A channel is a renderer-agnostic named value that the animation pipeline
 * (layers, compiler, action map) produces. It's **defined against the Cubism
 * SDK / Live2D model** — every channel exists because there's a Cubism
 * parameter we want to drive. Other renderers (VTS, future WebGPU, …) get
 * optional aliases via extra fields on this record.
 *
 * The rule for adding a new channel: it must correspond to a real Cubism
 * `Param*` on the target model class (Hiyori / Cubism 4 conventions). If
 * there's no Cubism param, there's no channel.
 */
export interface ChannelInfo {
  /** Canonical semantic id, e.g. `head.yaw`, `eye.open.left`, `breath`. */
  id: string;
  /**
   * Natural range the channel's value is authored in. Informational today —
   * the compiler doesn't clamp, and the renderer clamps via Cubism param
   * ranges — but kept for future runtime validation and for documenting
   * what layer / action authors should emit.
   */
  range: [number, number];
  /** One-line human-readable description. */
  description: string;
  /**
   * Cubism SDK parameter id the channel represents. This is the *reason* the
   * channel exists — our model of "what channels there are" is defined by
   * "what Cubism params we want to drive". Keep in sync with the renderer's
   * `cubism-channel-map.ts` (separate repo, manually mirrored).
   */
  cubismParam: string;
  /**
   * Optional scale applied when translating to the Cubism domain. Used for
   * channels whose natural unit differs from Cubism's (e.g. body offsets
   * authored as VTS-style normalized [-1, 1] → Cubism BodyAngle degrees).
   * Informational on the bot side; the renderer's channel map carries the
   * operational copy. Defaults to 1.
   */
  cubismScale?: number;
  /**
   * VTS tracking parameter id, when this channel has a VTS equivalent.
   * Absent when the channel exists in the Cubism domain but has no VTS
   * analogue (e.g. `breath` → `ParamBreath`, but VTS has no breath input).
   */
  vtsParam?: string;
}
