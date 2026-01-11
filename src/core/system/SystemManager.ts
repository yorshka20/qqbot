// System Manager - manages system registration and dependency resolution

import type { System, SystemContext } from './System';
import { logger } from '@/utils/logger';

/**
 * System Manager
 * Manages system registration, dependency resolution, and initialization order
 */
export class SystemManager {
  private systems = new Map<string, System>();
  private initialized = false;

  /**
   * Register a system
   */
  registerSystem(system: System): void {
    if (this.systems.has(system.name)) {
      logger.warn(`[SystemManager] System ${system.name} already registered, overwriting...`);
    }

    this.systems.set(system.name, system);
    logger.info(`[SystemManager] Registered system: ${system.name}`);
  }

  /**
   * Initialize all systems in dependency order
   */
  async initializeSystems(context: SystemContext): Promise<void> {
    if (this.initialized) {
      logger.warn('[SystemManager] Systems already initialized');
      return;
    }

    // Resolve dependency order
    const orderedSystems = this.resolveDependencies();

    // Initialize systems in order
    for (const system of orderedSystems) {
      try {
        if (system.initialize) {
          await system.initialize(context);
        }
        logger.info(`[SystemManager] Initialized system: ${system.name}`);
      } catch (error) {
        logger.error(`[SystemManager] Failed to initialize system ${system.name}:`, error);
        throw error;
      }
    }

    this.initialized = true;
  }

  /**
   * Resolve system dependencies and return ordered list
   */
  private resolveDependencies(): System[] {
    const systems = Array.from(this.systems.values());
    const ordered: System[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (system: System): void => {
      if (visiting.has(system.name)) {
        throw new Error(`Circular dependency detected involving system: ${system.name}`);
      }

      if (visited.has(system.name)) {
        return;
      }

      visiting.add(system.name);

      // Visit dependencies first
      if (system.dependencies) {
        for (const dep of system.dependencies) {
          const depSystem = systems.find((s) => s.name === dep.systemName);
          if (!depSystem) {
            if (dep.required) {
              throw new Error(
                `Required dependency ${dep.systemName} not found for system ${system.name}`,
              );
            }
            continue;
          }
          visit(depSystem);
        }
      }

      visiting.delete(system.name);
      visited.add(system.name);
      ordered.push(system);
    };

    for (const system of systems) {
      if (!visited.has(system.name)) {
        visit(system);
      }
    }

    return ordered;
  }

  /**
   * Get system by name
   */
  getSystem<T extends System>(name: string): T | null {
    return (this.systems.get(name) as T) || null;
  }

  /**
   * Get all systems
   */
  getAllSystems(): System[] {
    return Array.from(this.systems.values());
  }

  /**
   * Get systems by stage
   */
  getSystemsByStage(stage: System['stage']): System[] {
    return Array.from(this.systems.values())
      .filter((s) => s.stage === stage)
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }
}
