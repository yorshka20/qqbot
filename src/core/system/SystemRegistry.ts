// System Registry - centralized system registration and management

import type { System, SystemContext, SystemFactory, SystemStage } from './System';
import { logger } from '@/utils/logger';

/**
 * System Registry
 * Centralized system registration and management
 */
export class SystemRegistry {
  private systems = new Map<string, System>();
  private systemFactories = new Map<string, SystemFactory>();

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
        logger.error(`[SystemRegistry] Failed to create system ${name}:`, error);
        throw error;
      }
    }
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
