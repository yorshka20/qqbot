// MessageTriggerPlugin - type definitions

/**
 * One keyword-to-subagent trigger rule.
 *
 * Keywords and task description are loaded from prompt templates, following the same
 * convention as `preference/{key}/trigger.txt`:
 *
 *   prompts/subagent/{presetKey}/keywords.txt  — trigger keyword list (one per line)
 *   prompts/subagent/{presetKey}/task.txt      — task description (supports {{message}})
 *
 * Built-in preset keys: research | collect | generate | generic
 * Custom presets are supported by adding a new subdirectory under prompts/subagent/.
 *
 * The trigger is independent of the normal reply pipeline — both can fire simultaneously
 * on the same message.
 */
export interface SubAgentTriggerRule {
  /**
   * Template preset key — maps to prompts/subagent/{presetKey}/.
   * Controls: trigger keywords, task description, agent type, default tool allowlist, timeout.
   */
  presetKey: string;

  /**
   * Target group to push the result into.
   * Defaults to the group where the triggering message was sent.
   */
  targetGroupId?: string;

  /**
   * Override the default tool allowlist defined by the preset.
   * If empty, the preset's defaultAllowedTools applies.
   * Use tool names as registered in ToolManager (e.g. "web_search", "rag_retrieval").
   */
  allowedTools?: string[];

  /**
   * Minimum milliseconds between consecutive triggers of this rule in the same group.
   * Prevents rapid re-firing if multiple messages match in quick succession.
   * Default: 60 000 ms (1 minute).
   */
  cooldownMs?: number;
}

/** Plugin configuration shape (stored under config.plugins.messageTrigger.config). */
export interface MessageTriggerPluginConfig {
  /** Global wake words that trigger reply pipeline without @bot. */
  wakeWords?: string[];

  /** List of keyword-triggered subagent rules. */
  subAgentTriggers?: SubAgentTriggerRule[];
}
