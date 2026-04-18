/**
 * Entity extraction constants and prompt loading for WeChat moments.
 *
 * Shared by: moments-ner script, MomentsBackend.
 *
 * Prompt template: prompts/analysis/wechat_moments_ner.txt
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Entity type definitions ──

export const ENTITY_TYPES = ['person', 'company', 'product', 'tech', 'location'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  person: '人物',
  company: '公司/组织',
  product: '产品/服务',
  tech: '技术/概念',
  location: '地点',
};

// ── Normalization ──

/** Validate entity type. Returns null for invalid types. */
export function normalizeEntityType(raw: string): EntityType | null {
  const lower = raw.toLowerCase().trim();
  if (ENTITY_TYPES.includes(lower as EntityType)) return lower as EntityType;
  // Common aliases
  const aliases: Record<string, EntityType> = {
    people: 'person',
    人物: 'person',
    公司: 'company',
    组织: 'company',
    产品: 'product',
    技术: 'tech',
    technology: 'tech',
    地点: 'location',
    place: 'location',
  };
  return aliases[lower] ?? null;
}

/** Clean up entity name: trim, collapse whitespace. */
export function normalizeEntityName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

// ── Prompt template loading ──

const PROMPT_PATH = 'prompts/analysis/wechat_moments_ner.txt';

/** Load and render the NER prompt template */
export function loadNERPrompt(contentList: string): string {
  const template = readFileSync(resolve(PROMPT_PATH), 'utf-8');
  return template.replace('{{contentList}}', contentList);
}
