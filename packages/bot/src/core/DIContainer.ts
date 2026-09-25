// Global dependency injection container management
// Provides a centralized container for dependency injection using TSyringe

import { container, type DependencyContainer, instanceCachingFactory } from 'tsyringe';
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
   * @param token - Service token (from DITokens), or a service class to replace its class-token registration (e.g. a test double)
   * @param instance - Service instance to register
   * @param options - Registration options
   * @param options.allowOverride - Allow overriding existing registration (default: false)
   * @param options.logRegistration - Log registration (default: true)
   */
  registerInstance<T>(
    token: string | (new (...args: any[]) => unknown),
    instance: T,
    options?: { allowOverride?: boolean },
  ): void {
    const allowOverride = options?.allowOverride ?? false;

    if (typeof token !== 'string') {
      this._container.register(token, { useValue: instance });
      return;
    }

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
   * Expose a class-token singleton under a string token as well. `useToken` resolves to
   * the class's own registration, so both tokens return the same instance; registering
   * the class again with `registerSingleton(token, ctor)` would build a second one.
   */
  registerAlias<T>(token: string, target: new (...args: any[]) => T): void {
    this._container.register(token, { useToken: target });
    this.registeredTokens.add(token);
  }

  /**
   * Register a factory function
   */
  registerFactory<T>(token: string, factory: (container: DependencyContainer) => T): void {
    this._container.register(token, { useFactory: factory });
  }

  /**
   * Register a provider that is built on first resolve and reused afterwards. The factory
   * resolves its own dependencies, so the container builds them first: registration order
   * does not matter, only that every dependency has a provider by the time it is resolved.
   */
  registerSingletonFactory<T>(token: string, factory: () => T): void {
    if (this.registeredTokens.has(token)) {
      logger.warn(`[DIContainer] Service "${token}" is already registered; keeping the first provider.`);
      return;
    }
    this._container.register(token, { useFactory: instanceCachingFactory(() => factory()) });
    this.registeredTokens.add(token);
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
  isRegistered(token: string | (new (...args: any[]) => unknown)): boolean {
    if (typeof token !== 'string') {
      return this._container.isRegistered(token, true);
    }
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
          'Either register a provider for it or, if the token is feature-gated, mark it ' +
          '`required: false, gatedBy: ...` in DITokens.ts.',
      );
    }

    // A registered provider can still fail to build (a dependency without a provider, a
    // cycle). Resolving every required token here also builds the lazy singletons, so the
    // process ends bootstrap with the same instances an eager wiring would have made.
    const unbuildable: string[] = [];
    for (const token of getRequiredTokens()) {
      try {
        this._container.resolve(token);
      } catch (err) {
        unbuildable.push(`${token}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
    }
    if (unbuildable.length > 0) {
      throw new Error(`[DIContainer] Required DI tokens could not be built:\n  ${unbuildable.join('\n  ')}`);
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
