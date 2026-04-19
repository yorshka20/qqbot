import type { IdleClip } from './types';

/**
 * Hiyori-style default idle clips. Hand-authored to capture the "naturalistic
 * multi-channel drift" feel of Cubism's built-in Idle motion group without
 * copying keyframes directly. Each clip targets a subset of channels centered
 * at 0 (additively mixed on top of BreathLayer's baseline).
 *
 * Amplitudes are deliberately small — these clips *add* to BreathLayer (which
 * already provides ±15°/±8° breath oscillation), so a clip's own head motion
 * needs only ~3-8° peak to produce a noticeable "micro-gesture" on top of
 * baseline breathing. Same logic for body/eye channels.
 */
export const DEFAULT_IDLE_CLIPS: IdleClip[] = [
  // 1. Slow look-aside — ~5s. Turn head yaw left, pause, return to center.
  //    Subtle body.x counter-sway sells the weight shift.
  {
    id: 'look-aside',
    duration: 5.0,
    tracks: [
      {
        channel: 'head.yaw',
        keyframes: [
          { time: 0.0, value: 0 },
          { time: 1.2, value: -6 },
          { time: 3.0, value: -6 },
          { time: 4.5, value: 0 },
          { time: 5.0, value: 0 },
        ],
      },
      {
        channel: 'body.x',
        keyframes: [
          { time: 0.0, value: 0 },
          { time: 1.5, value: 0.04 },
          { time: 3.2, value: 0.04 },
          { time: 4.7, value: 0 },
        ],
      },
      {
        channel: 'eye.ball.x',
        keyframes: [
          { time: 0.0, value: 0 },
          { time: 1.0, value: -0.3 },
          { time: 2.8, value: -0.2 },
          { time: 4.2, value: 0 },
        ],
      },
    ],
  },

  // 2. Small nod curiosity — ~3.5s. Tilt down then slightly up, head roll
  //    adds a hint of tilt; eye.ball follows down briefly.
  {
    id: 'curious-nod',
    duration: 3.5,
    tracks: [
      {
        channel: 'head.pitch',
        keyframes: [
          { time: 0.0, value: 0 },
          { time: 0.9, value: -5 },
          { time: 1.8, value: 2 },
          { time: 3.0, value: 0 },
        ],
      },
      {
        channel: 'head.roll',
        keyframes: [
          { time: 0.0, value: 0 },
          { time: 1.2, value: 3 },
          { time: 2.6, value: -1 },
          { time: 3.5, value: 0 },
        ],
      },
      {
        channel: 'eye.ball.y',
        keyframes: [
          { time: 0.0, value: 0 },
          { time: 0.8, value: 0.3 },
          { time: 2.0, value: 0 },
        ],
      },
    ],
  },

  // 3. Cheerful sway — ~6s. Head roll + body sway in opposite directions
  //    (classic shoulder-roll idle), slight smile-corner twitch on brow.
  {
    id: 'cheerful-sway',
    duration: 6.0,
    tracks: [
      {
        channel: 'head.roll',
        keyframes: [
          { time: 0.0, value: 0 },
          { time: 1.5, value: 4 },
          { time: 3.0, value: -3 },
          { time: 4.5, value: 2 },
          { time: 6.0, value: 0 },
        ],
      },
      {
        channel: 'body.x',
        keyframes: [
          { time: 0.0, value: 0 },
          { time: 1.5, value: -0.05 },
          { time: 3.0, value: 0.04 },
          { time: 4.5, value: -0.03 },
          { time: 6.0, value: 0 },
        ],
      },
      {
        channel: 'head.yaw',
        keyframes: [
          { time: 0.0, value: 0 },
          { time: 2.0, value: 3 },
          { time: 4.0, value: -2 },
          { time: 6.0, value: 0 },
        ],
      },
      {
        channel: 'brow',
        keyframes: [
          { time: 0.0, value: 0 },
          { time: 2.5, value: 0.15 },
          { time: 4.0, value: 0.05 },
          { time: 6.0, value: 0 },
        ],
      },
    ],
  },
];
