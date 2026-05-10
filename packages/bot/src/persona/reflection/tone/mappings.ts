// Tone mappings — one entry per tone in the vocabulary.
//
// Design rules:
//   - `neutral` is the identity fallback: empty promptFragment, all deltas = identity.
//   - promptFragment is short (≤ 50 Chinese chars), imperative, tells the LLM how to
//     color its reply rather than stating bot state as fact.
//   - modulationDelta scales are multiplicative around 1.0; durationBias is additive (ms).
//   - variantWeights is only added where the tone meaningfully skews action variants.

import type { Tone, ToneMapping } from './types';

/** Complete vocabulary table — one entry per tone. */
export const TONE_MAPPINGS: Readonly<Record<Tone, ToneMapping>> = {
  neutral: {
    promptFragment: '',
    modulationDelta: { intensityScale: 1.0, speedScale: 1.0, durationBias: 0 },
  },
  playful: {
    promptFragment: '你此刻心情轻快，语气活泼跳脱，带一点俏皮感。',
    modulationDelta: { intensityScale: 1.1, speedScale: 1.1, durationBias: -20 },
  },
  sarcastic: {
    promptFragment: '你此刻略带讽刺，措辞含蓄讥诮，语气冷淡但不失机智。',
    modulationDelta: { intensityScale: 0.85, speedScale: 0.95, durationBias: 0 },
  },
  affectionate: {
    promptFragment: '你此刻感情充沛，语气温柔亲切，带一点细腻的关怀。',
    modulationDelta: { intensityScale: 1.1, speedScale: 0.9, durationBias: 40 },
  },
  tsundere: {
    promptFragment: '你此刻傲娇，嘴上嫌弃但内心在乎，语气冲中带点呵护。',
    modulationDelta: { intensityScale: 1.05, speedScale: 1.0, durationBias: 0 },
  },
  melancholy: {
    promptFragment: '你此刻有些落寞，语气带若有所思的惆怅感，不必强撑欢快。',
    modulationDelta: { intensityScale: 0.8, speedScale: 0.85, durationBias: 60 },
  },
  excited: {
    promptFragment: '你此刻心情亢奋，语气充满活力，语速稍快，热情洋溢。',
    modulationDelta: { intensityScale: 1.25, speedScale: 1.2, durationBias: -30 },
  },
  weary: {
    promptFragment: '你此刻身心俱疲，语气带沉沉的倦怠感，回复可以简短。',
    modulationDelta: { intensityScale: 0.75, speedScale: 0.8, durationBias: 80 },
  },
  professional: {
    promptFragment: '你此刻处于专业模式，语气务实简洁，避免过多情绪化表达。',
    modulationDelta: { intensityScale: 0.9, speedScale: 1.05, durationBias: -10 },
  },
  dismissive: {
    promptFragment: '你此刻有些不耐烦，语气漫不经心，回复简短直接。',
    modulationDelta: { intensityScale: 0.7, speedScale: 1.15, durationBias: -40 },
  },
  coy: {
    promptFragment: '你此刻娇羞欲言又止，语气带一点欲说还休的含蓄。',
    modulationDelta: { intensityScale: 1.0, speedScale: 0.9, durationBias: 30 },
  },
  defiant: {
    promptFragment: '你此刻态度强硬，语气带不服输的倔强，不轻易妥协。',
    modulationDelta: { intensityScale: 1.2, speedScale: 1.05, durationBias: -20 },
  },
};
