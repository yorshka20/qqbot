import { singleton } from 'tsyringe';
import type { TTSProvider } from './TTSProvider';

@singleton()
export class TTSManager {
  private readonly registry = new Map<string, TTSProvider>();
  private defaultName: string | null = null;

  /** Register a provider. If it is the first one registered, it becomes the default. */
  register(provider: TTSProvider): void {
    this.registry.set(provider.name, provider);
    if (this.defaultName === null) {
      this.defaultName = provider.name;
    }
  }

  /** Remove a provider by name. Returns true if it existed. */
  unregister(name: string): boolean {
    const existed = this.registry.delete(name);
    if (existed && this.defaultName === name) {
      // Pick the first remaining provider as the new default, or null
      const next = this.registry.keys().next();
      this.defaultName = next.done ? null : next.value;
    }
    return existed;
  }

  /** Get a provider by name, or null if not registered. */
  get(name: string): TTSProvider | null {
    return this.registry.get(name) ?? null;
  }

  /** Get the current default provider (must be available), or null. */
  getDefault(): TTSProvider | null {
    if (this.defaultName === null) return null;
    const provider = this.registry.get(this.defaultName);
    return provider?.isAvailable() ? provider : null;
  }

  /** Set the default provider by name. Throws if the name is not registered. */
  setDefault(name: string): void {
    if (!this.registry.has(name)) {
      throw new Error(`TTSManager: provider "${name}" is not registered`);
    }
    this.defaultName = name;
  }

  /** List all registered providers that report isAvailable() === true. */
  list(): TTSProvider[] {
    return [...this.registry.values()].filter((p) => p.isAvailable());
  }

  /** List all registered providers regardless of availability. */
  listAll(): TTSProvider[] {
    return [...this.registry.values()];
  }
}
