// Task decorator for automatic registration

import type { TaskExecutor, TaskType } from './types';

/**
 * Task decorator options
 * Defines task type metadata including description, parameters, examples, etc.
 */
export interface TaskOptions {
  /**
   * Task type name (required, unique identifier)
   */
  name: string;

  /**
   * Task description - what this task does
   */
  description: string;

  /**
   * Executor identifier - must match the executor name
   */
  executor: string;

  /**
   * Task parameters definition
   */
  parameters?: {
    [key: string]: {
      type: 'string' | 'number' | 'boolean' | 'object' | 'array';
      required: boolean;
      description: string;
    };
  };

  /**
   * Example user messages that would trigger this task type
   * Helps AI understand when to use this task type
   */
  examples?: string[];

  /**
   * Trigger conditions or keywords that indicate this task type
   * Optional: helps AI identify when to use this task
   */
  triggerKeywords?: string[];

  /**
   * When to use this task type (detailed guidance for AI)
   */
  whenToUse?: string;
}

/**
 * Task metadata stored on executor class
 */
export interface TaskMetadata extends TaskOptions {
  executorClass: new (...args: any[]) => TaskExecutor;
}

// Symbol for storing task metadata on class
const TASK_METADATA_KEY = Symbol('task:metadata');

// Static registry for all decorated tasks
const taskRegistry: TaskMetadata[] = [];
// Track registered classes to prevent duplicates from module reloads
const registeredClasses = new WeakSet<new (...args: any[]) => TaskExecutor>();

/**
 * Task definition decorator
 * Automatically registers task types and executors when class is loaded
 *
 * @param options - Task options (name, description, executor, parameters, etc.)
 */
export function TaskDefinition(options: TaskOptions) {
  return function <T extends new (...args: any[]) => TaskExecutor>(target: T): T {
    // Check if this class has already been registered
    if (registeredClasses.has(target)) {
      return target;
    }

    // Store metadata on class
    const metadata: TaskMetadata = {
      ...options,
      executorClass: target,
    };

    // Store metadata using Symbol
    (target as any)[TASK_METADATA_KEY] = metadata;

    // Mark class as registered
    registeredClasses.add(target);

    // Add to static registry
    taskRegistry.push(metadata);

    return target;
  };
}

/**
 * Get task metadata from executor class
 */
export function getTaskMetadata(executorClass: new (...args: any[]) => TaskExecutor): TaskMetadata | undefined {
  return (executorClass as any)[TASK_METADATA_KEY];
}

/**
 * Get all registered task metadata
 * Deduplicates by task name to avoid duplicates from module reloads
 */
export function getAllTaskMetadata(): TaskMetadata[] {
  const seen = new Map<string, TaskMetadata>();

  // Deduplicate by task name (case-insensitive)
  for (const metadata of taskRegistry) {
    const name = metadata.name.toLowerCase();
    if (!seen.has(name)) {
      seen.set(name, metadata);
    }
  }

  return Array.from(seen.values());
}

/**
 * Convert TaskMetadata to TaskType
 */
export function metadataToTaskType(metadata: TaskMetadata): TaskType {
  return {
    name: metadata.name,
    description: metadata.description,
    executor: metadata.executor,
    parameters: metadata.parameters,
    examples: metadata.examples,
    triggerKeywords: metadata.triggerKeywords,
    whenToUse: metadata.whenToUse,
  };
}
