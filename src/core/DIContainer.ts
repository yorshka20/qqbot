// Global dependency injection container management
// Provides a centralized container for dependency injection using TSyringe

import { logger } from '@/utils/logger';
import { container, type DependencyContainer } from 'tsyringe';

/**
 * Global DI Container Manager
 * Provides centralized access to the TSyringe container and helper methods
 */
export class DIContainer {
  private static instance: DIContainer;
  private _container: DependencyContainer;
  private registeredTokens = new Set<string>();

  private constructor() {
    this._container = container;
  }

  /**
   * Get singleton instance
   */
  static getInstance(): DIContainer {
    if (!DIContainer.instance) {
      DIContainer.instance = new DIContainer();
    }
    return DIContainer.instance;
  }

  /**
   * Get the underlying TSyringe container
   */
  get container(): DependencyContainer {
    return this._container;
  }

  /**
   * Register a service instance
   *
   * @param token - Service token (from DITokens)
   * @param instance - Service instance to register
   * @param options - Registration options
   * @param options.allowOverride - Allow overriding existing registration (default: false)
   * @param options.logRegistration - Log registration (default: true)
   */
  registerInstance<T>(
    token: string,
    instance: T,
    options?: { allowOverride?: boolean; logRegistration?: boolean },
  ): void {
    const allowOverride = options?.allowOverride ?? false;
    const logRegistration = options?.logRegistration ?? true;

    // Check if already registered
    if (this.registeredTokens.has(token) && !allowOverride) {
      logger.warn(`[DIContainer] Service "${token}" is already registered. Use allowOverride: true to override.`);
      return;
    }

    // Register the instance
    this._container.register(token, { useValue: instance });
    this.registeredTokens.add(token);

    if (logRegistration) {
      logger.debug(`[DIContainer] Registered service instance: ${token}`);
    }
  }

  /**
   * Register a service class (transient)
   */
  registerClass<T>(token: string, constructor: new (...args: any[]) => T): void {
    this._container.register(token, { useClass: constructor });
  }

  /**
   * Register a service class as singleton
   */
  registerSingleton<T>(token: string, constructor: new (...args: any[]) => T): void {
    this._container.registerSingleton(token, constructor);
  }

  /**
   * Register a factory function
   */
  registerFactory<T>(token: string, factory: (container: DependencyContainer) => T): void {
    this._container.register(token, { useFactory: factory });
  }

  /**
   * Resolve a service
   */
  resolve<T>(token: string | (new (...args: any[]) => T)): T {
    return this._container.resolve<T>(token as any);
  }

  /**
   * Check if a service is registered
   */
  isRegistered(token: string): boolean {
    return this.registeredTokens.has(token) || this._container.isRegistered(token);
  }

  /**
   * Get all registered token names
   */
  getRegisteredTokens(): string[] {
    return Array.from(this.registeredTokens);
  }

  /**
   * Clear all registrations
   */
  clear(): void {
    this._container.clearInstances();
    this.registeredTokens.clear();
  }
}

// Export convenience function to get container instance
export const getContainer = () => DIContainer.getInstance();
