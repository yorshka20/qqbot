// Personal portrait (radar chart) configuration.
//
// Each `dimension` is one radar axis. A group message accrues score on a
// dimension when it hits that dimension's keyword rules (case-insensitive
// substring). The radar value shown to a user is that user's accumulated score
// normalized against the group's per-axis maximum (relative percentile), so the
// chart is self-calibrating and needs no per-axis fullMark tuning.
//
// The dimension set (axes + keywords) is intended to be generated offline from a
// group's own chat history — see scripts/cli `generate-portrait-axes` — so each
// group's portrait reflects its own culture rather than a generic rank ladder.

export interface PortraitScoreRule {
  /** Hitting any one keyword (case-insensitive substring) triggers this rule. */
  keywords: string[];
  /** Score granted when the rule matches within a message. */
  points: number;
}

export interface PortraitDimensionConfig {
  /** Stable identifier persisted with each score row — do not rename casually. */
  id: string;
  /** Axis label shown on the radar (e.g. 技术浓度). */
  name: string;
  /** Keyword→points rules driving accrual for this axis. */
  rules: PortraitScoreRule[];
}

export interface PortraitConfig {
  enabled?: boolean;
  /** Per (user, dimension) cooldown window in seconds — a dimension grants at most once per window. Default 60. */
  cooldownSeconds?: number;
  /** Radar axes. A radar needs at least 3 to render meaningfully. */
  dimensions: PortraitDimensionConfig[];
}
