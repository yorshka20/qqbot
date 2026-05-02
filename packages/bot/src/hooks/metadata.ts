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
  conversationId: string;
  botSelfId: string;

  // Access Control & Processing Mode
  /** No direct reply path: skip PROCESS (set by WhitelistPlugin for bot/private deny, or by MessageTriggerPlugin when no @/wake word). Lifecycle skips to COMPLETE. Proactive can still run when whitelistGroup. */
  postProcessOnly: boolean;
  /** Access denied: set by WhitelistPlugin (bot, private/group not in whitelist). No reply, no proactive; only persistence and event-based plugins. */
  whitelistDenied: boolean;
  /** When true, this group has opted in to send replies as forward (Milky); set at process start from conversation config. */
  groupUseForwardMsg: boolean;
  whitelistUser: boolean;
  whitelistGroup: boolean;
  /** When set, this group has limited permissions: only these capability keys are allowed. Unset or empty = full access. Set by WhitelistPlugin when group is in groups config with non-empty capabilities. */
  whitelistGroupCapabilities?: string[];

  // Proactive conversation (thread): when in active thread, reply without @bot
  inProactiveThread: boolean;
  proactiveThreadId: string;
  /** How this message was chosen to trigger a reply: from event.replyTrigger (at | reaction). */
  replyTrigger?: 'at' | 'reaction';
  /** Resolved trigger type for this reply; set by MessageTriggerPlugin when message is allowed for reply. Undefined = not triggered. */
  replyTriggerType?: 'at' | 'reaction' | 'wakeWordConfig' | 'wakeWordPreference' | 'providerName';
  /** When replyTriggerType='providerName', the resolved provider name (e.g. 'anthropic') and user message with prefix stripped. Set by MessageTriggerPlugin. */
  resolvedProviderPrefix?: { providerName: string; strippedMessage: string };
  /** Conversation mode selected for this processing run. */
  contextMode?: 'normal' | 'proactive';

  // Context Manager metadata (internal use)
  userId: number | string;
  groupId: number | string;

  // Command metadata
  senderRole: string;

  // Task analyzer/provider routing metadata
  suggestedProvider?: string;

  /** Reply-only path: when true, RAG persistence writes only the new reply (not the old user message). */
  replyOnly: boolean;
  /** Set by CardFormatToolExecutor when the LLM called format_as_card and produced card JSON. Reset per generation attempt. */
  usedCardFormat?: boolean;
  /** Explicit sendAsForward hint from command handler; consumed by ReplyPrepareSystem. */
  explicitSendAsForward?: boolean;
  /** Caller-provided callback for sources with responseHandler === 'callback' (e.g. avatar-cmd). Receives the final ReplyContent. */
  responseCallback?: (reply: import('./types').ReplyContent) => void;
  /** Per-source history adapter kind, written by SessionStrategyPlugin during onMessagePreprocess. */
  historyAdapterKind?: import('../conversation/sources/types').SourceConfig['historyAdapter'];
  /** Tool usage instructions string, mirrored from ReplyPipelineContext by ProviderSelectionStage so ToolInstructProducer can read it. */
  toolUsageInstructions?: string;
}

type MetadataKeys = keyof HookContextMetadata;
type MetadataValues<K extends MetadataKeys = MetadataKeys> = HookContextMetadata[K];

/** Default values for all required metadata fields (used when constructing new HookContext) */
const DEFAULT_METADATA: Required<
  Omit<
    HookContextMetadata,
    | 'replyTrigger'
    | 'replyTriggerType'
    | 'resolvedProviderPrefix'
    | 'contextMode'
    | 'suggestedProvider'
    | 'usedCardFormat'
    | 'explicitSendAsForward'
    | 'responseCallback'
    | 'historyAdapterKind'
    | 'toolUsageInstructions'
  >
> = {
  sessionId: '',
  sessionType: 'group',
  conversationId: '',
  botSelfId: '',
  postProcessOnly: false,
  whitelistDenied: false,
  groupUseForwardMsg: false,
  whitelistUser: false,
  whitelistGroup: false,
  inProactiveThread: false,
  proactiveThreadId: '',
  userId: 0,
  groupId: 0,
  senderRole: 'user',
  replyOnly: false,
  whitelistGroupCapabilities: [],
};

const OPTIONAL_METADATA_KEYS: (keyof HookContextMetadata)[] = [
  'replyTrigger',
  'replyTriggerType',
  'contextMode',
  'suggestedProvider',
  'whitelistGroupCapabilities',
  'usedCardFormat',
  'explicitSendAsForward',
  'responseCallback',
  'historyAdapterKind',
  'toolUsageInstructions',
];

/**
 * Create a HookMetadataMap with all required fields set.
 * Pass partial to override defaults; optional fields (replyTrigger, replyTriggerType, contextMode, suggestedProvider) can be set in partial.
 * Use at HookContext construction sites so downstream code can assume all required fields are present.
 */
export function createDefaultHookMetadata(partial?: Partial<HookContextMetadata>): HookMetadataMap {
  const map = new HookMetadataMap();
  type RequiredKey = keyof typeof DEFAULT_METADATA;
  for (const key of Object.keys(DEFAULT_METADATA) as RequiredKey[]) {
    map.set(key, (partial?.[key] ?? DEFAULT_METADATA[key]) as HookContextMetadata[RequiredKey]);
  }
  for (const key of OPTIONAL_METADATA_KEYS) {
    const value = partial?.[key];
    if (value !== undefined) {
      map.set(key, value);
    }
  }
  return map;
}

/**
 * Type-safe metadata map
 * Provides type-safe get/set operations for metadata
 */
export class HookMetadataMap {
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
  static fromEntries(entries: Array<[MetadataKeys, MetadataValues]>): HookMetadataMap {
    const metadata = new HookMetadataMap();
    for (const [key, value] of entries) {
      metadata.map.set(key, value);
    }
    return metadata;
  }

  /**
   * Return a shallow copy of this metadata map (new map instance, same key-value pairs)
   */
  clone(): HookMetadataMap {
    return HookMetadataMap.fromEntries([...this.entries()]);
  }
}
