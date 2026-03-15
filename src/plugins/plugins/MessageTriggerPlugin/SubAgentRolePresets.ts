// SubAgentRolePresets - technical configuration per built-in preset key
// Content (keywords, task description) lives in prompts/subagent/{presetKey}/*.txt

import type { SubAgentConfig } from '@/agent/types';
import { SubAgentType } from '@/agent/types';

/**
 * Technical (non-content) configuration for a subagent preset.
 * The actual task wording and trigger keywords come from prompt templates:
 *   prompts/subagent/{presetKey}/keywords.txt  — trigger words (one per line)
 *   prompts/subagent/{presetKey}/task.txt      — task description (supports {{message}})
 */
export interface RolePreset {
  /** Human-readable name shown in the notification message sent to the group when spawning. */
  displayName: string;
  /** SubAgentType forwarded to SubAgentManager.spawn(). */
  type: SubAgentType;
  /**
   * Default tool allowlist for this preset (empty = no restriction).
   * Individual rules can override this via SubAgentTriggerRule.allowedTools.
   * Tool names must match task types registered in TaskManager.
   */
  defaultAllowedTools: string[];
  /** SubAgentConfig fields that differ from SubAgentManager defaults for this preset. */
  configOverrides: Partial<SubAgentConfig>;
}

/**
 * Built-in preset technical configs.
 * To add a custom preset, create a directory under prompts/subagent/ — no code change needed.
 * Unknown presetKeys fall back to GENERIC_PRESET.
 */
const BUILT_IN_PRESETS: Record<string, RolePreset> = {
  research: {
    displayName: '信息调研',
    type: SubAgentType.RESEARCH,
    defaultAllowedTools: ['web_search', 'http_request', 'rag_retrieval'],
    configOverrides: {
      maxDepth: 1,
      maxChildren: 0,
      timeout: 120_000,
      inheritSoul: false,
      inheritMemory: false,
      inheritPreference: false,
    },
  },

  collect: {
    displayName: '资料整理',
    type: SubAgentType.TASK_EXECUTION,
    defaultAllowedTools: ['rag_retrieval', 'http_request'],
    configOverrides: {
      maxDepth: 1,
      maxChildren: 0,
      timeout: 90_000,
      inheritSoul: false,
      inheritMemory: false,
      inheritPreference: false,
    },
  },

  generate: {
    displayName: '内容生成',
    type: SubAgentType.WRITING,
    defaultAllowedTools: [],
    configOverrides: {
      maxDepth: 0,
      maxChildren: 0,
      timeout: 60_000,
      inheritSoul: false,
      inheritMemory: false,
      inheritPreference: false,
    },
  },

  generic: {
    displayName: '后台任务',
    type: SubAgentType.GENERIC,
    defaultAllowedTools: [],
    configOverrides: {
      maxDepth: 1,
      maxChildren: 3,
      timeout: 120_000,
      inheritSoul: false,
      inheritMemory: false,
      inheritPreference: false,
    },
  },

  wechat_report: {
    displayName: '微信报告',
    type: SubAgentType.ANALYSIS,
    defaultAllowedTools: [
      'wechat_stats',
      'wechat_group_summary',
      'wechat_article_summary',
      'wechat_search',
      'wechat_report',
    ],
    configOverrides: {
      maxDepth: 1,
      maxChildren: 0,
      timeout: 180_000, // 3 minutes for comprehensive report generation
      inheritSoul: false,
      inheritMemory: false,
      inheritPreference: false,
    },
  },
};

/** Fallback for custom preset keys not listed in BUILT_IN_PRESETS. */
const GENERIC_PRESET: RolePreset = BUILT_IN_PRESETS.generic;

export function getRolePreset(presetKey: string): RolePreset {
  return BUILT_IN_PRESETS[presetKey] ?? GENERIC_PRESET;
}
