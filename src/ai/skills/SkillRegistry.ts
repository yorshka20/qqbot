import type { TaskType } from '@/task/types';
import type { ToolDefinition } from '../types';

export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  examples?: string[];
  parameters: ToolDefinition['parameters'];
}

export interface SkillRegistryOptions {
  nativeWebSearchEnabled?: boolean;
}

const REPLY_TASK_NAME = 'reply';
const SEARCH_TASK_NAME = 'search';

/**
 * SkillRegistry adapts TaskType definitions to skill/tool definitions for reply generation.
 * v1 keeps TaskManager/TaskExecutor as the runtime backend.
 */
export class SkillRegistry {
  constructor(private readonly taskTypes: TaskType[]) {}

  /**
   * All task types as skill definitions (no filtering). Used by taskTypesToToolDefinitions for SubAgent.
   */
  getSkillDefinitions(): SkillDefinition[] {
    return this.taskTypes.map((tt) => this.toSkillDefinition(tt));
  }

  getReplySkills(options?: SkillRegistryOptions): SkillDefinition[] {
    return this.taskTypes
      .filter((tt) => tt.name !== REPLY_TASK_NAME)
      .filter((tt) => !(options?.nativeWebSearchEnabled && tt.name === SEARCH_TASK_NAME))
      .map((tt) => this.toSkillDefinition(tt));
  }

  toToolDefinitions(skills: SkillDefinition[]): ToolDefinition[] {
    return skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      parameters: skill.parameters,
    }));
  }

  private toSkillDefinition(taskType: TaskType): SkillDefinition {
    const properties: Record<string, { type: string; description?: string; enum?: string[] }> = {};
    const required: string[] = [];

    for (const [key, def] of Object.entries(taskType.parameters || {})) {
      properties[key] = {
        type: def.type,
        description: def.description || '',
      };
      if (def.required) {
        required.push(key);
      }
    }

    return {
      name: taskType.name,
      description: taskType.description,
      whenToUse: taskType.whenToUse,
      examples: taskType.examples,
      parameters: {
        type: 'object',
        properties,
        required,
      },
    };
  }
}
