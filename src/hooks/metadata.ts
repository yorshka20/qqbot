// HookContext Metadata type definitions
// Provides type-safe access to metadata keys

/**
 * HookContext Metadata interface
 * Defines all possible metadata keys and their types
 *
 */
export interface HookContextMetadata {
  // Session & Context Information
  sessionId: string;
  sessionType: 'user' | 'group';
  conversationId?: string;
  botSelfId: string;

  // Access Control & Processing Mode
  postProcessOnly?: boolean;
  whitelistUser?: boolean;
  whitelistGroup?: boolean;

  // Proactive conversation (thread): when in active thread, reply without @bot
  inProactiveThread?: boolean;
  proactiveThreadId?: string;

  // Context Manager metadata (internal use)
  userId?: number;
  groupId?: number;

  // Command metadata
  senderRole?: string;
}

/**
 * Type-safe metadata map
 * Provides type-safe get/set operations for metadata
 */
export class MetadataMap {
  private map = new Map<string, unknown>();

  /**
   * Get metadata value by key with type safety
   */
  get<K extends keyof HookContextMetadata>(key: K): HookContextMetadata[K] {
    return this.map.get(key) as HookContextMetadata[K];
  }

  /**
   * Set metadata value by key with type safety
   */
  set<K extends keyof HookContextMetadata>(key: K, value: HookContextMetadata[K]): void {
    this.map.set(key, value);
  }

  /**
   * Check if metadata key exists
   */
  has<K extends keyof HookContextMetadata>(key: K): boolean {
    return this.map.has(key);
  }

  /**
   * Delete metadata key
   */
  delete<K extends keyof HookContextMetadata>(key: K): boolean {
    return this.map.delete(key);
  }

  /**
   * Clear all metadata
   */
  clear(): void {
    this.map.clear();
  }

  /**
   * Get all entries (for iteration)
   * @internal Use get/set/has/delete methods instead
   */
  entries(): IterableIterator<[string, unknown]> {
    return this.map.entries();
  }

  /**
   * Get all keys
   * @internal Use get/set/has/delete methods instead
   */
  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  /**
   * Get all values
   * @internal Use get/set/has/delete methods instead
   */
  values(): IterableIterator<unknown> {
    return this.map.values();
  }

  /**
   * Get size of metadata map
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Create MetadataMap from array of entries
   */
  static fromEntries(entries: Array<[keyof HookContextMetadata, unknown]>): MetadataMap {
    const metadata = new MetadataMap();
    for (const [key, value] of entries) {
      metadata.map.set(key, value);
    }
    return metadata;
  }
}

/**
 * Type guard to check if a Map is a MetadataMap
 */
export function isMetadataMap(map: Map<string, unknown> | MetadataMap): map is MetadataMap {
  return map instanceof MetadataMap;
}
