// Global dependency injection container management
// Provides a centralized container for dependency injection using TSyringe

import { container, type DependencyContainer } from 'tsyringe';
import { logger } from '@/utils/logger';
import { DITokens, getRequiredTokens, getTokenMeta } from './DITokens';

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
  registerInstance<T>(token: string, instance: T, options?: { allowOverride?: boolean }): void {
    const allowOverride = options?.allowOverride ?? false;

    // Check if already registered
    if (this.registeredTokens.has(token) && !allowOverride) {
      logger.warn(`[DIContainer] Service "${token}" is already registered. Use allowOverride: true to override.`);
      return;
    }

    // Register the instance
    this._container.register(token, { useValue: instance });
    this.registeredTokens.add(token);

    logger.debug(`[DIContainer] Registered service instance: ${token}`);
  }

  /**
   * Register a service class as singleton, under a string token or under the class itself
   * (then `resolve(ctor)` returns the one instance).
   */
  registerSingleton<T>(ctor: new (...args: any[]) => T): void;
  registerSingleton<T>(token: string, ctor: new (...args: any[]) => T): void;
  registerSingleton<T>(tokenOrCtor: string | (new (...args: any[]) => T), ctor?: new (...args: any[]) => T): void {
    if (typeof tokenOrCtor === 'string') {
      this._container.registerSingleton(tokenOrCtor, ctor as new (...args: any[]) => T);
    } else {
      this._container.registerSingleton(tokenOrCtor);
    }
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
   * Throw when a required-by-contract token (see DITokens.ts) is still unregistered, so
   * bootstrap and `bun run smoke-test` fail loud instead of degrading into a null deref
   * later. Optional tokens gated off in this run are only logged.
   */
  verifyRequiredTokens(): void {
    const missing = getRequiredTokens().filter((token) => !this.isRegistered(token));
    if (missing.length > 0) {
      throw new Error(
        `[DIContainer] Bootstrap left required DI tokens unregistered: ${missing.join(', ')}. ` +
          'Either fix the registration order or, if the token is feature-gated, mark it ' +
          '`required: false, gatedBy: ...` in DITokens.ts.',
      );
    }

    const skipped: string[] = [];
    for (const token of Object.values(DITokens)) {
      const meta = getTokenMeta(token);
      if (meta && !meta.required && !this.isRegistered(token)) {
        skipped.push(`${token} (${meta.gatedBy})`);
      }
    }
    if (skipped.length > 0) {
      logger.debug(`[DIContainer] Optional tokens not registered: ${skipped.join('; ')}`);
    }
    logger.debug('[DIContainer] All required services are registered');
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
