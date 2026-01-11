// System Registry - centralized system registration and management

import { logger } from '@/utils/logger';
import type {
  System,
  SystemContext,
  SystemFactory,
  SystemStage,
} from './System';

/**
 * System Registry
 * Centralized system registration, dependency resolution, and initialization
 */
export class SystemRegistry {
  private systems = new Map<string, System>();
  private systemFactories = new Map<string, SystemFactory>();
  private initialized = false;

  /**
   * Register a system factory
   * Factory is called during initialization to create system instance
   */
  registerSystemFactory(name: string, factory: SystemFactory): void {
    if (this.systemFactories.has(name)) {
      logger.warn(
        `[SystemRegistry] System factory ${name} already registered, overwriting...`,
      );
    }
    this.systemFactories.set(name, factory);
    logger.debug(`[SystemRegistry] Registered system factory: ${name}`);
  }

  /**
   * Register a system instance directly
   */
  registerSystem(system: System): void {
    if (this.systems.has(system.name)) {
      logger.warn(
        `[SystemRegistry] System ${system.name} already registered, overwriting...`,
      );
    }
    this.systems.set(system.name, system);
    logger.info(`[SystemRegistry] Registered system: ${system.name}`);
  }

  /**
   * Create and register systems from factories
   */
  async createSystems(context: SystemContext): Promise<void> {
    for (const [name, factory] of this.systemFactories.entries()) {
      try {
        const system = await factory(context);
        this.registerSystem(system);
      } catch (error) {
        logger.error(
          `[SystemRegistry] Failed to create system ${name}:`,
          error,
        );
        throw error;
      }
    }
  }

  /**
   * Initialize all systems in dependency order
   */
  async initializeSystems(context: SystemContext): Promise<void> {
    if (this.initialized) {
      logger.warn('[SystemRegistry] Systems already initialized');
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
        logger.info(`[SystemRegistry] Initialized system: ${system.name}`);
      } catch (error) {
        logger.error(
          `[SystemRegistry] Failed to initialize system ${system.name}:`,
          error,
        );
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
        throw new Error(
          `Circular dependency detected involving system: ${system.name}`,
        );
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
  getSystemsByStage(stage: SystemStage): System[] {
    return Array.from(this.systems.values())
      .filter((s) => s.stage === stage)
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  /**
   * Check if a system factory is registered
   */
  hasSystemFactory(name: string): boolean {
    return this.systemFactories.has(name);
  }
}
