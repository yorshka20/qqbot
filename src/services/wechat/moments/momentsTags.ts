/**
 * Canonical tag definitions and normalization for WeChat moments.
 *
 * Shared by: moments-tag script, tool executors, MomentsBackend.
 *
 * Prompt templates live in:
 * - prompts/analysis/wechat_moments_tag.txt     (batch tagging)
 * - prompts/analysis/wechat_moments_analyze.txt  (topic analysis)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Canonical tag whitelist ──

export const CANONICAL_TAGS = [
  'AI',
  '技术',
  '编程',
  '产品',
  '创业',
  '工作',
  '职场',
  '生活',
  '情感',
  '健康',
  '美食',
  '旅行',
  '运动',
  '音乐',
  '电影',
  '读书',
  '游戏',
  '摄影',
  '社会',
  '经济',
  '政治',
  '历史',
  '哲学',
  '教育',
  '科学',
  '文化',
  '艺术',
  '吐槽',
  '其他',
] as const;

export type CanonicalTag = (typeof CANONICAL_TAGS)[number];

// ── Tag normalization ──

/** Map non-standard LLM output back to canonical tags */
export const TAG_NORMALIZE_MAP: Record<string, string> = {
  // 技术 variants
  科技: '技术',
  技术评论: '技术',
  开发: '编程',
  工程: '编程',
  // 社会 variants
  社会观察: '社会',
  城市观察: '社会',
  城市: '社会',
  网络文化: '文化',
  文化评论: '文化',
  文化观察: '文化',
  // 影视 variants
  影视: '电影',
  影视评论: '电影',
  科幻: '电影',
  // 工作 variants
  面试: '职场',
  沟通: '职场',
  // 其他 merges
  心理: '情感',
  心理学: '情感',
  思考: '哲学',
  消费: '经济',
  产品设计: '产品',
  文学: '读书',
  学习: '教育',
};

/** Normalize raw tags: map to canonical form and deduplicate */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const normalized = TAG_NORMALIZE_MAP[raw] ?? raw;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

// ── Prompt template loading ──

const TAG_PROMPT_PATH = 'prompts/analysis/wechat_moments_tag.txt';
const ANALYZE_PROMPT_PATH = 'prompts/analysis/wechat_moments_analyze.txt';

/** Load and render the batch tagging prompt template */
export function loadTaggingPrompt(contentList: string): string {
  const template = readFileSync(resolve(TAG_PROMPT_PATH), 'utf-8');
  return template.replace('{{canonicalTags}}', CANONICAL_TAGS.join('、')).replace('{{contentList}}', contentList);
}

/** Load and render the topic analysis prompt template */
export function loadAnalysisPrompt(vars: { topic: string; analysisAngle: string; contextText: string }): string {
  const template = readFileSync(resolve(ANALYZE_PROMPT_PATH), 'utf-8');
  return template
    .replace('{{topic}}', vars.topic)
    .replace('{{analysisAngle}}', vars.analysisAngle ? `额外关注角度：${vars.analysisAngle}` : '')
    .replace('{{contextText}}', vars.contextText);
}
