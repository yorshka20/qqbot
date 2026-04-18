// SubAgentRolePresets - loads subagent preset configuration from prompts/subagent/{presetKey}/config.json
//
// To add a custom preset, create a directory under prompts/subagent/ with:
//   config.json    — technical configuration (displayName, type, allowedTools, timeout, etc.)
//   keywords.txt   — trigger words (one per line)
//   task.txt       — task description template (supports {{message}})
//   system.txt     — (optional) system prompt override

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { logger } from '@/utils/logger';
import type { SubAgentConfig } from './types';
import { SubAgentType } from './types';

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
   * Tool names must match task types registered in ToolManager.
   */
  defaultAllowedTools: string[];
  /** SubAgentConfig fields that differ from SubAgentManager defaults for this preset. */
  configOverrides: Partial<SubAgentConfig>;
}

// ---------------------------------------------------------------------------
// Config file schema (what config.json contains)
// ---------------------------------------------------------------------------

interface PresetConfigFile {
  displayName: string;
  type: string;
  allowedTools?: string[];
  maxDepth?: number;
  maxChildren?: number;
  timeout?: number;
  inheritSoul?: boolean;
  inheritMemory?: boolean;
  inheritPreference?: boolean;
  providerName?: string | string[];
  maxTokens?: number;
  maxToolRounds?: number;
  systemTemplate?: string;
}

// ---------------------------------------------------------------------------
// Type string → SubAgentType mapping
// ---------------------------------------------------------------------------

const TYPE_MAP: Record<string, SubAgentType> = {
  research: SubAgentType.RESEARCH,
  analysis: SubAgentType.ANALYSIS,
  writing: SubAgentType.WRITING,
  coding: SubAgentType.CODING,
  task: SubAgentType.TASK_EXECUTION,
  task_execution: SubAgentType.TASK_EXECUTION,
  validation: SubAgentType.VALIDATION,
  generic: SubAgentType.GENERIC,
};

function resolveSubAgentType(typeStr: string): SubAgentType {
  return TYPE_MAP[typeStr] ?? SubAgentType.GENERIC;
}

// ---------------------------------------------------------------------------
// Preset loading
// ---------------------------------------------------------------------------

const GENERIC_DEFAULTS: RolePreset = {
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
};

/** Loaded presets cache. null = not yet loaded. */
let presetCache: Map<string, RolePreset> | null = null;

/** Custom prompts directory set via initRolePresets(). */
let promptsBaseDir: string | null = null;

function getSubagentDir(): string {
  const base = promptsBaseDir ?? resolve(process.cwd(), 'prompts');
  return join(base, 'subagent');
}

function parseConfigFile(configPath: string): PresetConfigFile | null {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as PresetConfigFile;
  } catch (err) {
    logger.warn(`[SubAgentRolePresets] Failed to parse ${configPath}:`, err);
    return null;
  }
}

function configToPreset(cfg: PresetConfigFile): RolePreset {
  const overrides: Partial<SubAgentConfig> = {};

  if (cfg.maxDepth !== undefined) overrides.maxDepth = cfg.maxDepth;
  if (cfg.maxChildren !== undefined) overrides.maxChildren = cfg.maxChildren;
  if (cfg.timeout !== undefined) overrides.timeout = cfg.timeout;
  if (cfg.inheritSoul !== undefined) overrides.inheritSoul = cfg.inheritSoul;
  if (cfg.inheritMemory !== undefined) overrides.inheritMemory = cfg.inheritMemory;
  if (cfg.inheritPreference !== undefined) overrides.inheritPreference = cfg.inheritPreference;
  if (cfg.providerName !== undefined) overrides.providerName = cfg.providerName;
  if (cfg.maxTokens !== undefined) overrides.maxTokens = cfg.maxTokens;
  if (cfg.maxToolRounds !== undefined) overrides.maxToolRounds = cfg.maxToolRounds;
  if (cfg.systemTemplate !== undefined) overrides.systemTemplate = cfg.systemTemplate;

  return {
    displayName: cfg.displayName,
    type: resolveSubAgentType(cfg.type),
    defaultAllowedTools: cfg.allowedTools ?? [],
    configOverrides: overrides,
  };
}

function loadAllPresets(): Map<string, RolePreset> {
  const map = new Map<string, RolePreset>();
  const subagentDir = getSubagentDir();

  if (!existsSync(subagentDir)) {
    logger.warn(`[SubAgentRolePresets] Subagent directory not found: ${subagentDir}`);
    return map;
  }

  for (const entry of readdirSync(subagentDir)) {
    const dirPath = join(subagentDir, entry);
    if (!statSync(dirPath).isDirectory()) continue;

    const configPath = join(dirPath, 'config.json');
    if (!existsSync(configPath)) continue;

    const cfg = parseConfigFile(configPath);
    if (!cfg) continue;

    map.set(entry, configToPreset(cfg));
    logger.debug(`[SubAgentRolePresets] Loaded preset "${entry}" from config.json`);
  }

  logger.info(`[SubAgentRolePresets] Loaded ${map.size} preset(s) from ${subagentDir}`);
  return map;
}

function ensureLoaded(): Map<string, RolePreset> {
  if (!presetCache) {
    presetCache = loadAllPresets();
  }
  return presetCache;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Optionally set the prompts base directory before first access.
 * Call this during bootstrap if the prompts directory is overridden in config.
 */
export function initRolePresets(promptsDir: string): void {
  promptsBaseDir = promptsDir;
  presetCache = null; // force reload on next access
}

/** Fallback for custom preset keys not found in config files. */
export function getRolePreset(presetKey: string): RolePreset {
  return ensureLoaded().get(presetKey) ?? GENERIC_DEFAULTS;
}

/** Get all loaded preset keys. */
export function getPresetKeys(): string[] {
  return Array.from(ensureLoaded().keys());
}
