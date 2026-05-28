// ReplyComplexityClassifierPlugin — classifies each pending reply as
// "quick" or "deep" so PromptAssemblyStage can pick the right reasoning
// budget on workhorse providers. Runs at onMessageBeforeAI, well before
// the main LLM call.

import { z } from 'zod';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { parseLlmJson } from '@/ai/utils/llmJsonExtract';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '../../decorators';
import { PluginBase } from '../../PluginBase';

const CLASSIFIER_TIMEOUT_MS = 800;
const HISTORY_TURNS = 5;

const ClassifierOutputSchema = z.object({
  reply_mode: z.enum(['quick', 'deep']),
  intent: z.enum(['chitchat', 'question', 'request', 'emotional', 'command', 'meta']),
  topic_type: z.enum(['casual', 'tech', 'creative', 'factual', 'personal', 'nsfw', 'other']),
  reasoning: z.string().max(120).optional().default(''),
});

@RegisterPlugin({
  name: 'replyComplexityClassifier',
  version: '1.0.0',
  description:
    'Classifies pending replies as quick / deep via a lite LLM call. Writes metadata.replyMode for PromptAssemblyStage to pick the right reasoning effort on workhorse providers (deepseek/openai/gemini). Fails open to deep.',
})
export class ReplyComplexityClassifierPlugin extends PluginBase {
  private llmService!: LLMService;
  private promptManager!: PromptManager;
  private historyService!: ConversationHistoryService;
  private config!: Config;

  async onInit(): Promise<void> {
    const container = getContainer();
    this.llmService = container.resolve<LLMService>(DITokens.LLM_SERVICE);
    this.promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    this.historyService = container.resolve<ConversationHistoryService>(DITokens.CONVERSATION_HISTORY_SERVICE);
    this.config = container.resolve<Config>(DITokens.CONFIG);
    logger.info('[ReplyComplexityClassifier] Enabled');
  }

  @Hook({
    stage: 'onMessageBeforeAI',
    priority: 'HIGH',
    order: 0,
  })
  async onMessageBeforeAI(context: HookContext): Promise<boolean> {
    if (!this.enabled) return true;
    // Already set upstream (e.g. by a test harness or future router) — respect it.
    if (context.metadata.get('replyMode')) return true;

    try {
      const result = await this.classify(context);
      if (result) {
        context.metadata.set('replyMode', result.reply_mode);
        logger.info(
          `[ReplyComplexityClassifier] mode=${result.reply_mode} intent=${result.intent} topic=${result.topic_type} reason="${result.reasoning ?? ''}"`,
        );
      }
    } catch (err) {
      // Fail-open: any error → leave replyMode unset → PromptAssemblyStage defaults to chatReasoning (deep).
      logger.warn(
        '[ReplyComplexityClassifier] classify failed, defaulting to deep:',
        err instanceof Error ? err.message : err,
      );
    }
    return true;
  }

  private async classify(context: HookContext): Promise<z.infer<typeof ClassifierOutputSchema> | null> {
    const currentMessage = (context.message.message ?? '').trim();
    if (!currentMessage) return null;

    const sessionId = String(context.metadata.get('sessionId') ?? '');
    const sessionType = context.metadata.get('sessionType') ?? 'group';
    const historyLines = sessionId
      ? this.formatHistoryLines(
          await this.historyService.getRecentMessagesForSession(sessionId, sessionType, HISTORY_TURNS),
        )
      : '(无)';

    const senderNickname = context.message.sender?.nickname ?? context.message.sender?.card ?? '匿名';
    const senderRole = String(context.metadata.get('senderRole') ?? 'user');

    const prompt = this.promptManager.render('analysis.reply_complexity', {
      historyLines,
      senderNickname,
      senderRole,
      currentMessage,
    });

    const aiConfig = this.config.getAIConfig();
    const liteProvider = aiConfig?.taskProviders?.lite ?? aiConfig?.defaultProviders?.llm ?? 'deepseek';
    const liteModel = aiConfig?.taskProviders?.liteModel ?? '';

    const callPromise = this.llmService.generateLite(
      prompt,
      { maxTokens: 200, jsonMode: true, model: liteModel || undefined },
      liteProvider,
    );

    // Hard timeout: classifier must not stall the reply pipeline. On timeout we
    // fail-open to deep — better to spend extra TTFT on this turn than to wait.
    const response = await Promise.race([
      callPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`classifier timeout after ${CLASSIFIER_TIMEOUT_MS}ms`)), CLASSIFIER_TIMEOUT_MS),
      ),
    ]);

    return parseLlmJson(response.text, ClassifierOutputSchema);
  }

  private formatHistoryLines(entries: Array<{ nickname?: string; content: string; isBotReply: boolean }>): string {
    if (entries.length === 0) return '(无)';
    return entries
      .map((e) => {
        const speaker = e.isBotReply ? 'bot' : (e.nickname?.trim() || '某人');
        const content = (e.content ?? '').replace(/\s+/g, ' ').slice(0, 100);
        return `[${speaker}]: ${content}`;
      })
      .join('\n');
  }
}
