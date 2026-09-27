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
 */

export interface ParsedAgentCommand {
  type: 'task' | 'new-project' | 'project-management' | 'status' | 'cancel' | 'info';
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
export function parseAgentCommand(args: string[]): ParsedAgentCommand {
  if (args.length === 0) {
    return { type: 'task', prompt: '' };
  }

  const first = args[0].toLowerCase();

  // Sub-commands
  switch (first) {
    case 'status':
      return { type: 'status', args: args.slice(1) };

    case 'cancel':
      return { type: 'cancel', args: args.slice(1) };

    case 'info':
      return { type: 'info' };

    case 'projects':
      return { type: 'project-management', args: args.slice(1) };

    case 'new':
      return parseNewProjectCommand(args.slice(1));
  }

  // Check for @alias or @path prefix
  if (args[0].startsWith('@')) {
    const identifier = args[0].slice(1); // Remove @
    const prompt = args.slice(1).join(' ');
    return {
      type: 'task',
      projectIdentifier: identifier,
      prompt,
    };
  }

  // Default: treat everything as prompt for default project
  return {
    type: 'task',
    prompt: args.join(' '),
  };
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
