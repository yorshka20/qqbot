// SubAgent Manager - manages sub-agent lifecycle

import { logger } from '@/utils/logger';
import type { SubAgentExecutor } from './SubAgentExecutor';
import type { AggregatedResult, SubAgentConfig, SubAgentSession, SubAgentType } from './types';

/**
 * SubAgent Manager
 * Manages sub-agent lifecycle, execution, and concurrency control
 */
export class SubAgentManager {
  private sessions = new Map<string, SubAgentSession>();
  private runningCount = 0;
  private executor: SubAgentExecutor | null = null;
  private readonly MAX_CONCURRENT: number;
  private readonly MAX_DEPTH: number;
  private readonly DEFAULT_CONFIG: Partial<SubAgentConfig>;

  constructor(config?: {
    maxConcurrent?: number;
    maxDepth?: number;
    defaultConfig?: Partial<SubAgentConfig>;
  }) {
    this.MAX_CONCURRENT = config?.maxConcurrent ?? 8;
    this.MAX_DEPTH = config?.maxDepth ?? 5;
    this.DEFAULT_CONFIG = config?.defaultConfig ?? {
      maxDepth: 2,
      maxChildren: 5,
      timeout: 300000, // 5 minutes
      inheritSoul: false,
      inheritMemory: false,
      inheritPreference: false,
      allowedTools: [],
      restrictedTools: [],
    };

    logger.info(`[SubAgentManager] Initialized with maxConcurrent=${this.MAX_CONCURRENT}, maxDepth=${this.MAX_DEPTH}`);
  }

  /**
   * Spawn a new sub-agent.
   * When called from main flow, pass parentContext so the sub-agent can run tools with correct TaskExecutionContext.
   */
  async spawn(
    parentId: string | undefined,
    type: SubAgentType,
    task: {
      description: string;
      input: unknown;
      /** From parent (e.g. HookContext when spawned from main flow); written to session.context for ToolRunner. */
      parentContext?: {
        userId: number;
        groupId?: number;
        messageType: 'private' | 'group';
        protocol?: string;
        conversationId?: string;
        messageId?: string;
      };
    },
    configOverrides?: Partial<SubAgentConfig>,
  ): Promise<string> {
    // Check concurrent limit
    if (this.runningCount >= this.MAX_CONCURRENT) {
      throw new Error(`Max concurrent sub-agents (${this.MAX_CONCURRENT}) reached`);
    }

    // Calculate depth
    const depth = parentId ? (this.getSession(parentId)?.depth ?? 0) + 1 : 0;

    // Check depth limit
    if (depth > this.MAX_DEPTH) {
      throw new Error(`Max sub-agent depth (${this.MAX_DEPTH}) exceeded`);
    }

    // Check parent's children limit
    if (parentId) {
      const parent = this.getSession(parentId);
      if (parent) {
        const children = this.listByParent(parentId);
        if (children.length >= parent.config.maxChildren) {
          throw new Error(`Parent agent's max children (${parent.config.maxChildren}) reached`);
        }
      }
    }

    // Generate session ID
    const sessionId = this.generateSessionId(parentId, depth);

    // Merge config
    const config: SubAgentConfig = {
      ...this.DEFAULT_CONFIG,
      ...configOverrides,
    } as SubAgentConfig;

    const parentContext = task.parentContext;
    const session: SubAgentSession = {
      id: sessionId,
      parentId,
      depth,
      type,
      status: 'pending',
      context: {
        sessionId,
        ...(parentContext && {
          userId: parentContext.userId,
          groupId: parentContext.groupId,
          messageType: parentContext.messageType,
          protocol: parentContext.protocol,
          conversationId: parentContext.conversationId,
          messageId: parentContext.messageId,
        }),
      },
      task: {
        description: task.description,
        input: task.input,
      },
      createdAt: new Date(),
      config,
    };

    this.sessions.set(sessionId, session);

    logger.info(`[SubAgentManager] Spawned sub-agent: ${sessionId} (type=${type}, depth=${depth})`);

    return sessionId;
  }

  /**
   * Set the executor (injected after construction to avoid circular dependency)
   */
  setExecutor(executor: SubAgentExecutor): void {
    this.executor = executor;
  }

  /**
   * Execute sub-agent using SubAgentExecutor
   */
  async execute(sessionId: string): Promise<unknown> {
    if (!this.executor) {
      throw new Error('SubAgentExecutor not set on SubAgentManager');
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Sub-agent session not found: ${sessionId}`);
    }
    if (session.status !== 'pending') {
      throw new Error(`Sub-agent ${sessionId} is not pending (status: ${session.status})`);
    }
    return this.executor.execute(session);
  }

  /**
   * Wait for sub-agent to complete
   */
  async wait(sessionId: string, timeout?: number): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Sub-agent session not found: ${sessionId}`);
    }

    const maxWait = timeout ?? session.config.timeout;
    const startTime = Date.now();

    while (session.status === 'pending' || session.status === 'running') {
      if (Date.now() - startTime > maxWait) {
        session.status = 'failed';
        session.error = new Error('Timeout');
        throw new Error(`Sub-agent timeout: ${sessionId}`);
      }

      // Wait 100ms before checking again
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (session.status === 'failed') {
      throw session.error || new Error(`Sub-agent failed: ${sessionId}`);
    }

    return session.task.output;
  }

  /**
   * Wait for all sub-agents to complete
   */
  async waitAll(sessionIds: string[]): Promise<unknown[]> {
    return await Promise.all(sessionIds.map((id) => this.wait(id)));
  }

  /**
   * Cancel sub-agent
   */
  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.status === 'running') {
      session.status = 'failed';
      session.error = new Error('Cancelled');
      this.runningCount--;
    }

    logger.info(`[SubAgentManager] Cancelled sub-agent: ${sessionId}`);
  }

  /**
   * Get sub-agent status
   */
  getStatus(sessionId: string): SubAgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get session (alias for getStatus)
   */
  getSession(sessionId: string): SubAgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List sub-agents by parent
   */
  listByParent(parentId: string | undefined): SubAgentSession[] {
    const result: SubAgentSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.parentId === parentId) {
        result.push(session);
      }
    }
    return result;
  }

  /**
   * Cleanup completed sub-agents
   */
  cleanup(olderThan?: Date): void {
    const cutoff = olderThan ?? new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
    let cleaned = 0;

    for (const [id, session] of this.sessions.entries()) {
      if (
        (session.status === 'completed' || session.status === 'failed') &&
        (session.completedAt ?? session.createdAt) < cutoff
      ) {
        this.sessions.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`[SubAgentManager] Cleaned up ${cleaned} old sub-agent sessions`);
    }
  }

  /**
   * Aggregate results from multiple sub-agents
   */
  async aggregate(sessionIds: string[]): Promise<AggregatedResult> {
    const sessions = sessionIds.map((id) => this.getStatus(id)).filter((s): s is SubAgentSession => s !== undefined);

    return {
      totalCount: sessions.length,
      completed: sessions.filter((s) => s.status === 'completed').length,
      failed: sessions.filter((s) => s.status === 'failed').length,
      results: sessions
        .filter((s) => s.status === 'completed')
        .map((s) => ({
          type: s.type,
          description: s.task.description,
          output: s.task.output,
        })),
      errors: sessions
        .filter((s) => s.status === 'failed')
        .map((s) => ({
          type: s.type,
          description: s.task.description,
          error: s.error?.message ?? 'Unknown error',
        })),
    };
  }

  /**
   * Generate session ID with depth encoding
   */
  private generateSessionId(parentId: string | undefined, depth: number): string {
    const uuid = this.randomUUID();
    if (!parentId) {
      return `agent:${uuid}`;
    }
    return `subagent:${parentId}:d${depth}:${uuid}`;
  }

  /**
   * Generate a simple UUID (v4-like)
   */
  private randomUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Update session status
   * This is called by SubAgentExecutor
   */
  updateSessionStatus(sessionId: string, status: SubAgentSession['status'], output?: unknown, error?: Error): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const oldStatus = session.status;
    session.status = status;

    if (status === 'running' && oldStatus === 'pending') {
      this.runningCount++;
      session.startedAt = new Date();
    }

    if ((status === 'completed' || status === 'failed') && oldStatus === 'running') {
      this.runningCount--;
      session.completedAt = new Date();
    }

    if (output !== undefined) {
      session.task.output = output;
    }

    if (error) {
      session.error = error;
    }

    logger.debug(`[SubAgentManager] Session ${sessionId} status: ${oldStatus} -> ${status}`);
  }
}
