// Tool decorator for automatic registration

import { normalizeVisibility, type ToolExecutor, type ToolScope, type ToolSpec, type ToolVisibility } from './types';

/**
 * Tool decorator options
 */
export interface ToolOptions {
  name: string;
  description: string;
  executor: string;
  visibility?: ToolScope[] | ToolVisibility;
  parameters?: {
    [key: string]: {
      type: 'string' | 'number' | 'boolean' | 'object' | 'array';
      required: boolean;
      description: string;
    };
  };
  examples?: string[];
  triggerKeywords?: string[];
  whenToUse?: string;
}

/**
 * Tool metadata stored on executor class
 */
export interface ToolMetadata extends ToolOptions {
  executorClass: new (...args: any[]) => ToolExecutor;
}

// Symbol for storing tool metadata on class
const TOOL_METADATA_KEY = Symbol('tool:metadata');

// Static registry for all decorated tools
const toolRegistry: ToolMetadata[] = [];
// Track registered classes to prevent duplicates from module reloads
const registeredClasses = new WeakSet<new (...args: any[]) => ToolExecutor>();

/**
 * Tool definition decorator.
 * Automatically registers tool specs and executors when class is loaded.
 *
 * @param options - Tool options (name, description, executor, parameters, visibility, etc.)
 */
export function Tool(options: ToolOptions) {
  return <T extends new (...args: any[]) => ToolExecutor>(target: T): T => {
    if (registeredClasses.has(target)) {
      return target;
    }

    const metadata: ToolMetadata = {
      ...options,
      executorClass: target,
    };

    (target as any)[TOOL_METADATA_KEY] = metadata;
    registeredClasses.add(target);
    toolRegistry.push(metadata);

    return target;
  };
}

/**
 * Get tool metadata from executor class
 */
export function getToolMetadata(executorClass: new (...args: any[]) => ToolExecutor): ToolMetadata | undefined {
  return (executorClass as any)[TOOL_METADATA_KEY];
}

/**
 * Get all registered tool metadata.
 * Deduplicates by tool name to avoid duplicates from module reloads.
 */
export function getAllToolMetadata(): ToolMetadata[] {
  const seen = new Map<string, ToolMetadata>();

  for (const metadata of toolRegistry) {
    const name = metadata.name.toLowerCase();
    if (!seen.has(name)) {
      seen.set(name, metadata);
    }
  }

  return Array.from(seen.values());
}

/**
 * Convert ToolMetadata to ToolSpec
 */
export function metadataToToolSpec(metadata: ToolMetadata): ToolSpec {
  return {
    name: metadata.name,
    description: metadata.description,
    executor: metadata.executor,
    visibility: normalizeVisibility(metadata.visibility),
    parameters: metadata.parameters,
    examples: metadata.examples,
    triggerKeywords: metadata.triggerKeywords,
    whenToUse: metadata.whenToUse,
  };
}
