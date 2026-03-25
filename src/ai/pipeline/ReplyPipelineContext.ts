// Mutable context passed through all reply pipeline stages.
// Each stage reads upstream fields and writes its own outputs.

import type { ConversationMessageEntry } from '@/conversation/history';
import type { NormalizedMessageEvent } from '@/events/types';
import type { HookContext } from '@/hooks/types';
import type { ToolResult } from '@/tools/types';
import type { VisionImage } from '../capabilities/types';
import type { ChatMessage, ToolDefinition } from '../types';

/**
 * Mutable context object passed through all reply pipeline stages.
 * Each stage reads fields set by upstream stages and writes its own outputs.
 * The orchestrator creates a fresh instance per reply generation request.
 */
export class ReplyPipelineContext {
  // --- Input (set at construction) ---
  readonly hookContext: HookContext;
  readonly taskResults: Map<string, ToolResult>;

  // --- ContextResolutionStage ---
  referencedMessage: NormalizedMessageEvent | null = null;
  userMessageOverride: string | undefined;
  messageImages: VisionImage[] = [];
  taskResultImages: string[] = [];
  taskResultsSummary = '';

  // --- HistoryStage ---
  historyEntries: ConversationMessageEntry[] = [];
  sessionId = '';
  episodeKey = '';

  // --- ContextEnrichmentStage ---
  memoryContextText = '';
  retrievedConversationSection = '';

  // --- ProviderSelectionStage ---
  providerName: string | undefined;
  userMessage = '';
  selectedProviderName: string | undefined;
  providerHasVision = false;
  effectiveNativeSearchEnabled = false;
  toolDefinitions: ToolDefinition[] = [];
  toolUsageInstructions = '';

  // --- PromptAssemblyStage ---
  messages: ChatMessage[] = [];
  genOptions: {
    temperature: number;
    maxTokens: number;
    sessionId: string;
    reasoningEffort: 'medium';
    episodeKey?: string;
  } | null = null;

  // --- GenerationStage ---
  responseText = '';
  actualProvider: string | undefined;

  // --- Control ---
  /** When true the pipeline loop stops immediately. */
  interrupted = false;

  constructor(hookContext: HookContext, taskResults: Map<string, ToolResult>) {
    this.hookContext = hookContext;
    this.taskResults = taskResults;
  }
}
