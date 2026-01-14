// Plugin and Hook decorators for automatic registration

import type { HookPriorityVariant } from '@/hooks/HookPriority';
import type { Plugin } from './types';

/**
 * Plugin decorator options
 */
export interface PluginOptions {
  name: string;
  version: string;
  description: string;
}

/**
 * Hook decorator options
 */
export interface HookOptions {
  stage: string;
  priority?: HookPriorityVariant; // Default: 'NORMAL'
}

/**
 * Plugin metadata stored on class
 */
export interface PluginMetadata extends PluginOptions {
  pluginClass: new (...args: any[]) => Plugin;
}

/**
 * Hook metadata stored on method
 */
export interface HookMetadata {
  hookName: string; // extended hook name
  priority: HookPriorityVariant;
  methodName: string;
  pluginClass: new (...args: any[]) => Plugin;
}

// Symbol for storing plugin metadata on class
const PLUGIN_METADATA_KEY = Symbol('plugin:metadata');

// Symbol for storing hook metadata on class
const HOOK_METADATA_KEY = Symbol('plugin:hooks');

// Static registry for all decorated plugins
const pluginRegistry: PluginMetadata[] = [];

// Static registry for all decorated hooks (by plugin class)
const hookRegistry = new Map<new (...args: any[]) => Plugin, HookMetadata[]>();

/**
 * Plugin decorator
 * Automatically registers plugin metadata when class is loaded
 *
 * @param options - Plugin options (name, version, description, etc.)
 */
export function Plugin(options: PluginOptions) {
  return function <T extends new (...args: any[]) => Plugin>(target: T): T {
    // Store metadata on class
    const metadata: PluginMetadata = {
      ...options,
      pluginClass: target,
    };

    // Store metadata using Symbol
    (target as any)[PLUGIN_METADATA_KEY] = metadata;

    // Add to static registry
    pluginRegistry.push(metadata);

    // Initialize hooks array for this plugin class
    if (!hookRegistry.has(target)) {
      hookRegistry.set(target, []);
    }

    return target;
  };
}

/**
 * Hook decorator
 * Automatically registers hook metadata when method is decorated
 *
 * @param options - Hook options (stage, priority)
 */
export function Hook(options: HookOptions) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor): PropertyDescriptor {
    // Get plugin class (target is the prototype, constructor is the class)
    const pluginClass = target.constructor as new (...args: any[]) => Plugin;

    // Store hook metadata
    const hookMetadata: HookMetadata = {
      hookName: options.stage,
      priority: options.priority || 'NORMAL',
      methodName: propertyKey,
      pluginClass,
    };

    // Get or create hooks array for this plugin class
    if (!hookRegistry.has(pluginClass)) {
      hookRegistry.set(pluginClass, []);
    }
    hookRegistry.get(pluginClass)!.push(hookMetadata);

    return descriptor;
  };
}

/**
 * Get plugin metadata from class
 */
export function getPluginMetadata(pluginClass: new (...args: any[]) => Plugin): PluginMetadata | undefined {
  return (pluginClass as any)[PLUGIN_METADATA_KEY];
}

/**
 * Get hook metadata for a plugin class
 */
export function getPluginHooks(pluginClass: new (...args: any[]) => Plugin): HookMetadata[] {
  return hookRegistry.get(pluginClass) || [];
}

/**
 * Get all registered plugin metadata
 */
export function getAllPluginMetadata(): PluginMetadata[] {
  return [...pluginRegistry];
}

/**
 * Get all registered hook metadata
 */
export function getAllHookMetadata(): Map<new (...args: any[]) => Plugin, HookMetadata[]> {
  return new Map(hookRegistry);
}
