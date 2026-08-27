// Mutable context passed through all reply pipeline stages.
// Each stage reads upstream fields and writes its own outputs.

import type { ConversationMessageEntry } from '@/conversation/history';
import type { ReasoningEffort } from '@/core/config/types/ai';
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
  /**
   * Text of the message the user quoted, if any. Kept separate from `userMessage`
   * so the prompt template owns how it is labelled and so provider-prefix routing
   * only ever looks at what the user actually typed.
   */
  quotedText: string | undefined;
  messageImages: VisionImage[] = [];
  taskResultImages: string[] = [];

  // --- HistoryStage ---
  historyEntries: ConversationMessageEntry[] = [];
  sessionId = '';
  episodeKey = '';

  // --- ContextEnrichmentStage ---
  memoryContextText = '';
  retrievedConversationSection = '';
  glossaryText = '';
  recentActionsText = '';
  sessionMemoText = '';

  // --- ProviderSelectionStage ---
  providerName: string | undefined;
  userMessage = '';
  selectedProviderName: string | undefined;
  // User explicitly wake-worded a provider (e.g. `gemini:`); opts into its premium tier.
  usedExplicitProvider = false;
  providerHasVision = false;
  providerHasFunctionCalling = false;
  effectiveNativeSearchEnabled = false;
  toolDefinitions: ToolDefinition[] = [];
  toolUsageInstructions = '';

  // --- PromptAssemblyStage ---
  messages: ChatMessage[] = [];
  genOptions: {
    temperature: number;
    maxTokens?: number;
    sessionId: string;
    reasoningEffort: ReasoningEffort;
    episodeKey?: string;
    maxToolRounds: number;
  } | null = null;

  // --- GenerationStage ---
  responseText = '';
  actualProvider: string | undefined;
  /** True when the model ended the turn via the end_turn tool (nothing more to send). */
  endTurnRequested = false;

  // --- Control ---
  /** When true the pipeline loop stops immediately. */
  interrupted = false;

  constructor(hookContext: HookContext, taskResults: Map<string, ToolResult>) {
    this.hookContext = hookContext;
    this.taskResults = taskResults;
  }
}
