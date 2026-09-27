/**
 * Parser for the coding-agent commands. The grammar is the same for every
 * executor command (`claude`, `codex`):
 * - <cmd> <prompt>                    → default project task
 * - <cmd> @<alias> <prompt>           → task on specific project
 * - <cmd> @/path/to/project <prompt>  → task on path-based project
 * - <cmd> new <path> [--type X] <prompt> → create new project
 * - <cmd> projects                    → list projects
 * - <cmd> projects add <alias> <path> → register project
 * - <cmd> projects remove <alias>     → unregister project
 * - <cmd> status [taskId]             → task status
 * - <cmd> cancel <taskId>             → cancel task
 * - <cmd> info                        → service info
 * - <cmd> models                      → models and efforts this executor accepts
 *
 * Task and new-project commands accept leading run options:
 * - --model <id> | -m <id> | --model=<id>
 * - --effort <level> | -e <level> | --effort=<level>
 */

import type { AgentRunOptions } from './types';

const RUN_OPTION_FLAGS: Record<string, keyof AgentRunOptions> = {
  '--model': 'model',
  '-m': 'model',
  '--effort': 'effort',
  '-e': 'effort',
};

const SUBCOMMANDS_WITHOUT_RUN_OPTIONS = new Set(['status', 'cancel', 'info', 'models', 'projects']);

export interface ParsedAgentCommand {
  type: 'task' | 'new-project' | 'project-management' | 'status' | 'cancel' | 'info' | 'models' | 'invalid';
  /** Why the command was rejected (type 'invalid') */
  error?: string;
  /** Leading --model / --effort options (task and new-project only) */
  options?: AgentRunOptions;
  /** @alias or @path resolved project identifier */
  projectIdentifier?: string;
  /** Task prompt */
  prompt?: string;
  /** Project type for new command */
  projectType?: string;
  /** Path for new project */
  projectPath?: string;
  /** Sub-command args (for projects management) */
  args?: string[];
}

/**
 * Parse an agent command's arguments.
 *
 * @param args - Array of command arguments (already split, without the command name)
 */
export function parseAgentCommand(rawArgs: string[]): ParsedAgentCommand {
  const leading = takeRunOptions(rawArgs);
  if ('error' in leading) {
    return { type: 'invalid', error: leading.error };
  }
  const { options, args } = leading;
  const hasOptions = Object.keys(options).length > 0;

  if (args.length === 0) {
    return { type: 'task', prompt: '', options };
  }

  const first = args[0].toLowerCase();

  if (hasOptions && SUBCOMMANDS_WITHOUT_RUN_OPTIONS.has(first)) {
    return { type: 'invalid', error: `--model / --effort 只能用于任务，不能用于 ${first}` };
  }

  // Sub-commands
  switch (first) {
    case 'status':
      return { type: 'status', args: args.slice(1) };

    case 'cancel':
      return { type: 'cancel', args: args.slice(1) };

    case 'info':
      return { type: 'info' };

    case 'models':
      return { type: 'models' };

    case 'projects':
      return { type: 'project-management', args: args.slice(1) };

    case 'new':
      return { ...parseNewProjectCommand(args.slice(1)), options };
  }

  // Check for @alias or @path prefix
  if (args[0].startsWith('@')) {
    const identifier = args[0].slice(1); // Remove @
    const prompt = args.slice(1).join(' ');
    return {
      type: 'task',
      projectIdentifier: identifier,
      prompt,
      options,
    };
  }

  // Default: treat everything as prompt for default project
  return {
    type: 'task',
    prompt: args.join(' '),
    options,
  };
}

/** Strip leading run-option flags; anything else starting with `-` there is refused rather than read as prompt. */
function takeRunOptions(args: string[]): { options: AgentRunOptions; args: string[] } | { error: string } {
  const options: AgentRunOptions = {};
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const token = args[i];
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    const key = RUN_OPTION_FLAGS[flag];
    if (!key) {
      return { error: `未知参数 ${flag}` };
    }
    const value = eq === -1 ? args[i + 1] : token.slice(eq + 1);
    if (!value || value.startsWith('-')) {
      return { error: `${flag} 缺少取值` };
    }
    if (options[key] !== undefined) {
      return { error: `${flag} 重复指定` };
    }
    options[key] = value;
    i += eq === -1 ? 2 : 1;
  }
  return { options, args: args.slice(i) };
}

/**
 * Parse "new <path> [--type X] <prompt>"
 */
function parseNewProjectCommand(args: string[]): ParsedAgentCommand {
  if (args.length === 0) {
    return { type: 'new-project', prompt: '' };
  }

  const projectPath = args[0];
  let projectType: string | undefined;
  const promptParts: string[] = [];
  let i = 1;

  while (i < args.length) {
    if (args[i] === '--type' && i + 1 < args.length) {
      projectType = args[i + 1];
      i += 2;
    } else {
      promptParts.push(args[i]);
      i++;
    }
  }

  return {
    type: 'new-project',
    projectPath,
    projectType,
    prompt: promptParts.join(' '),
  };
}
