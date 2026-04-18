/**
 * Sentiment analysis constants and prompt loading for WeChat moments.
 *
 * Shared by: moments-sentiment script, MomentsBackend.
 *
 * Prompt template: prompts/analysis/wechat_moments_sentiment.txt
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Canonical sentiment values ──

export const VALID_SENTIMENTS = ['positive', 'negative', 'neutral', 'mixed'] as const;
export type Sentiment = (typeof VALID_SENTIMENTS)[number];

// ── Attitude tag whitelist ──

export const ATTITUDE_TAGS = [
  '赞赏',
  '吐槽',
  '反讽',
  '感慨',
  '焦虑',
  '期待',
  '无奈',
  '自嘲',
  '愤怒',
  '幽默',
  '好奇',
  '怀旧',
] as const;

export type AttitudeTag = (typeof ATTITUDE_TAGS)[number];

// ── Normalization ──

/** Validate and normalize a sentiment value. Returns 'neutral' for invalid values. */
export function normalizeSentiment(raw: string): Sentiment {
  const lower = raw.toLowerCase().trim();
  if (VALID_SENTIMENTS.includes(lower as Sentiment)) return lower as Sentiment;
  return 'neutral';
}

/** Clamp a sentiment score to [-1, 1]. */
export function clampScore(score: number): number {
  if (typeof score !== 'number' || Number.isNaN(score)) return 0;
  return Math.max(-1, Math.min(1, score));
}

/** Filter attitude tags to only valid ones. */
export function normalizeAttitudeTags(tags: string[]): string[] {
  const valid = new Set<string>(ATTITUDE_TAGS as unknown as string[]);
  return tags.filter((t) => valid.has(t));
}

// ── Prompt template loading ──

const PROMPT_PATH = 'prompts/analysis/wechat_moments_sentiment.txt';
const COMBINED_PROMPT_PATH = 'prompts/analysis/wechat_moments_analyze_combined.txt';

/** Load and render the sentiment analysis prompt template */
export function loadSentimentPrompt(contentList: string): string {
  const template = readFileSync(resolve(PROMPT_PATH), 'utf-8');
  return template
    .replace('{{attitudeTags}}', (ATTITUDE_TAGS as unknown as string[]).join('、'))
    .replace('{{contentList}}', contentList);
}

/** Load and render the combined sentiment + NER prompt template */
export function loadCombinedAnalysisPrompt(contentList: string): string {
  const template = readFileSync(resolve(COMBINED_PROMPT_PATH), 'utf-8');
  return template
    .replace('{{attitudeTags}}', (ATTITUDE_TAGS as unknown as string[]).join('、'))
    .replace('{{contentList}}', contentList);
}
