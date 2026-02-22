// Parse LLM response into slot map and build NAI prompt line

import { GACHA_SLOT_IDS } from './slots';

export interface ParsedTag {
  en: string;
  zh: string;
}

export type ParsedSlots = Record<string, ParsedTag[]>;

const CATEGORY_MAP: Record<string, string[]> = {
  quality: ['quality', '质量', '画质', '质量&画师', '画师', 'artist', '艺术家'],
  character: ['character', '角色', '人物'],
  expression: ['expression', '表情', '神情'],
  appearance: ['appearance', '外貌', '外观', '容貌'],
  clothing: ['clothing', '服装', '衣服', '服饰'],
  action: ['action', '动作', '姿势', '行为'],
  items: ['items', 'item', '物品', '道具'],
  scene: ['scene', '场景', '背景', '环境'],
  composition: ['composition', '构图', '视角'],
};

/**
 * Strip thinking blocks and extract content inside <提示词>...</提示词>
 */
function extractPromptBlock(text: string): string {
  let cleaned = text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<Think>[\s\S]*?<\/Think>/gi, '')
    .replace(/[\s\S]*?<\/think>/gi, '');
  const match = cleaned.match(/<提示词>([\s\S]*?)<\/提示词>/);
  return match ? match[1] : cleaned;
}

/**
 * Parse raw LLM response into slot id -> array of { en, zh }.
 * Section headers: [quality], [character], etc. Lines: tag|中文 or tag | 中文.
 */
export function parseStandardPrompt(text: string): ParsedSlots {
  const result: ParsedSlots = {};
  for (const id of GACHA_SLOT_IDS) {
    result[id] = [];
  }

  const contentToParse = extractPromptBlock(text);
  const lines = contentToParse.split('\n');
  let currentCategory: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const categoryMatch =
      trimmed.match(/^\[([^\]]+)\]/) ||
      trimmed.match(/^【([^】]+)】/) ||
      trimmed.match(/^##?\s*\[?([^\]\s]+)\]?/);
    if (categoryMatch) {
      const catName = categoryMatch[1].toLowerCase();
      for (const [key, aliases] of Object.entries(CATEGORY_MAP)) {
        if (aliases.some((a) => catName.includes(a.toLowerCase()))) {
          currentCategory = key;
          break;
        }
      }
      continue;
    }

    if (currentCategory && result[currentCategory]) {
      const parts = trimmed.split(/\s*[|｜\/]\s*/);
      if (parts.length >= 1) {
        const en = parts[0].trim().replace(/^[-*•]\s*/, '');
        const zh = (parts[1]?.trim() ?? '?');
        if (en && !/^\[/.test(en) && !/^#/.test(en)) {
          result[currentCategory].push({ en, zh });
        }
      }
    }
  }

  return result;
}

/**
 * Build a single NAI prompt string from parsed slots (all slot tags in order, joined by space).
 * LLM already outputs NAI-style tags (e.g. 1.2::masterpiece::).
 */
export function slotsToNaiPrompt(slots: ParsedSlots): string {
  const parts: string[] = [];
  for (const id of GACHA_SLOT_IDS) {
    const tags = slots[id];
    if (tags && tags.length > 0) {
      for (const t of tags) {
        if (t.en && t.en.toLowerCase() !== 'none') {
          parts.push(t.en);
        }
      }
    }
  }
  return parts.join(' ');
}
