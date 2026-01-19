// Database model types and interfaces

/**
 * Base model interface
 */
export interface BaseModel {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Conversation model
 */
export interface Conversation extends BaseModel {
  sessionId: string; // User ID or Group ID
  sessionType: 'user' | 'group';
  messageCount: number;
  lastMessageAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Message model
 */
export interface Message extends BaseModel {
  conversationId: string;
  userId: number;
  messageType: 'private' | 'group';
  groupId?: number;
  content: string;
  rawContent?: string; // Original message segments
  protocol: string;
  messageId?: string; // Protocol-specific message ID (for non-Milky protocols)
  messageSeq?: number; // Message sequence number (for Milky protocol, unique within groupId)
  metadata?: Record<string, unknown>;
}


/**
 * Provider selection for a session
 */
export interface ProviderSelection {
  llm?: string;
  vision?: string;
  text2img?: string;
  img2img?: string;
}

/**
 * Conversation config data structure
 */
export interface ConversationConfigData {
  commands?: {
    enabled?: string[];
    disabled?: string[];
  };
  plugins?: {
    enabled?: string[];
    disabled?: string[];
  };
  permissions?: {
    users?: Record<string, string[]>; // userId -> permission levels (as strings, will be validated as PermissionLevel)
  };
  providers?: ProviderSelection; // Session-level AI provider selection
}

/**
 * Conversation config model
 */
export interface ConversationConfig extends BaseModel {
  sessionId: string; // User ID or Group ID
  sessionType: 'user' | 'group';
  config: ConversationConfigData; // JSON object
}

/**
 * Model accessor interface
 */
export interface ModelAccessor<T extends BaseModel> {
  /**
   * Create a new record
   */
  create(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<T>;

  /**
   * Find by ID
   */
  findById(id: string): Promise<T | null>;

  /**
   * Find records by criteria
   */
  find(criteria: Partial<T>): Promise<T[]>;

  /**
   * Find one record by criteria
   */
  findOne(criteria: Partial<T>): Promise<T | null>;

  /**
   * Update record
   */
  update(id: string, data: Partial<Omit<T, 'id' | 'createdAt'>>): Promise<T>;

  /**
   * Delete record
   */
  delete(id: string): Promise<boolean>;

  /**
   * Count records
   */
  count(criteria?: Partial<T>): Promise<number>;
}

/**
 * Database model registry
 */
export interface DatabaseModel {
  conversations: ModelAccessor<Conversation>;
  messages: ModelAccessor<Message>;
  conversationConfigs: ModelAccessor<ConversationConfig>;
}
