// System interface and types
// Unified interface for all systems (Lifecycle, Command, Task, AI, etc.)

import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';

/**
 * System execution stage
 */
export enum SystemStage {
  ON_MESSAGE_RECEIVED = 'onMessageReceived',
  PREPROCESS = 'preprocess',
  PROCESS = 'process',
  PREPARE = 'prepare',
  SEND = 'send',
  COMPLETE = 'complete',
}

/**
 * System dependencies
 */
export interface SystemDependency {
  systemName: string;
  required: boolean; // If false, system can work without this dependency
}

/**
 * System context provided during initialization
 */
export interface SystemContext {
  hookManager: HookManager;
  getSystem<T extends System>(name: string): T | null;
  config: unknown;
}

/**
 * Extension hook definition
 * Used to declare extension hooks that plugins can subscribe to.
 * Systems declare hooks to make them available for plugins to register handlers.
 */
export interface ExtensionHookDefinition {
  hookName: string;
  priority?: number; // Default priority for this hook (used when plugins register without specifying priority)
}

/**
 * System interface
 * All systems (Lifecycle, Command, Task, AI, etc.) implement this interface
 */
export interface System {
  /**
   * System name (unique identifier)
   */
  readonly name: string;

  /**
   * System version
   */
  readonly version: string;

  /**
   * System dependencies
   * Systems will be initialized in dependency order
   */
  readonly dependencies?: SystemDependency[];

  /**
   * Stage where this system executes
   */
  readonly stage: SystemStage;

  /**
   * Priority within the stage (higher = executed earlier)
   */
  readonly priority?: number;

  /**
   * Initialize the system
   * Called once during startup, after dependencies are initialized
   */
  initialize?(context: SystemContext): Promise<void> | void;

  /**
   * Execute the system
   * Called during message processing
   * @param context - Hook context with message and metadata
   * @returns true to continue, false to interrupt
   */
  execute(context: HookContext): Promise<boolean> | boolean;

  /**
   * Get extension hooks that should be registered
   * Called during initialization
   */
  getExtensionHooks?(): ExtensionHookDefinition[];

  /**
   * Cleanup the system
   * Called during shutdown
   */
  cleanup?(): Promise<void> | void;
}

/**
 * System factory function type
 */
export type SystemFactory = (context: SystemContext) => Promise<System> | System;
