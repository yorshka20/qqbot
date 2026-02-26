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
  /** Set when message was @bot; proactive plugin skips scheduling so no duplicate reply. */
  triggeredByAtBot?: boolean;

  // Context Manager metadata (internal use)
  userId?: number;
  groupId?: number;

  // Command metadata
  senderRole?: string;
}

type MetadataKeys = keyof HookContextMetadata;
type MetadataValues<K extends MetadataKeys = MetadataKeys> = HookContextMetadata[K];

/**
 * Type-safe metadata map
 * Provides type-safe get/set operations for metadata
 */
export class MetadataMap {
  private map = new Map<MetadataKeys, MetadataValues>();

  /**
   * Get metadata value by key with type safety
   */
  get<K extends MetadataKeys>(key: K): MetadataValues<K> {
    return this.map.get(key) as HookContextMetadata[K];
  }

  /**
   * Set metadata value by key with type safety
   */
  set<K extends MetadataKeys>(key: K, value: MetadataValues<K>): void {
    this.map.set(key, value);
  }

  /**
   * Check if metadata key exists
   */
  has<K extends MetadataKeys>(key: K): boolean {
    return this.map.has(key);
  }

  /**
   * Delete metadata key
   */
  delete<K extends MetadataKeys>(key: K): boolean {
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
  entries(): IterableIterator<[MetadataKeys, MetadataValues]> {
    return this.map.entries();
  }

  /**
   * Get all keys
   * @internal Use get/set/has/delete methods instead
   */
  keys(): IterableIterator<MetadataKeys> {
    return this.map.keys();
  }

  /**
   * Get all values
   * @internal Use get/set/has/delete methods instead
   */
  values(): IterableIterator<MetadataValues> {
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
  static fromEntries(entries: Array<[MetadataKeys, MetadataValues]>): MetadataMap {
    const metadata = new MetadataMap();
    for (const [key, value] of entries) {
      metadata.map.set(key, value);
    }
    return metadata;
  }
}
