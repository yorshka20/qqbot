// Task Analyzer - uses AI to analyze conversation and generate tasks

import type { AIManager } from '@/ai/AIManager';
import type { TaskManager } from './TaskManager';
import type {
  Task,
  ConversationContext,
  TaskAnalysisResult,
} from './types';
import { logger } from '@/utils/logger';

/**
 * Task Analyzer - analyzes conversation using AI and generates tasks
 */
export class TaskAnalyzer {
  constructor(
    private aiManager: AIManager,
    private taskManager: TaskManager,
    private systemPrompt?: string,
  ) {}

  /**
   * Analyze conversation and generate task
   */
  async analyze(context: ConversationContext): Promise<TaskAnalysisResult> {
    try {
      // Build prompt for AI
      const prompt = this.buildPrompt(context);

      logger.debug('[TaskAnalyzer] Analyzing conversation with AI...');

      // Generate AI response
      const response = await this.aiManager.generate(prompt, {
        temperature: 0.7,
        maxTokens: 1000,
      });

      // Parse AI response to extract task
      const task = this.parseTaskResponse(response.text, context);

      logger.debug(`[TaskAnalyzer] Generated task: ${task.type}`);

      return {
        task,
        confidence: 0.8, // Default confidence, can be improved with better parsing
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[TaskAnalyzer] Failed to analyze conversation:', err);

      // Fallback: return a reply task
      return {
        task: {
          type: 'reply',
          parameters: {},
          executor: 'reply',
          reply: 'I apologize, but I encountered an error processing your message.',
        },
        confidence: 0,
        reasoning: err.message,
      };
    }
  }

  /**
   * Build prompt for AI task analysis
   */
  private buildPrompt(context: ConversationContext): string {
    const taskTypes = this.taskManager.getAllTaskTypes();
    const taskTypesDescription = taskTypes
      .map((tt) => {
        let desc = `- ${tt.name}: ${tt.description}`;
        if (tt.parameters) {
          const params = Object.entries(tt.parameters)
            .map(([key, def]) => `  - ${key} (${def.type}, ${def.required ? 'required' : 'optional'}): ${def.description}`)
            .join('\n');
          desc += `\n  Parameters:\n${params}`;
        }
        return desc;
      })
      .join('\n');

    const historyText = context.conversationHistory
      ? context.conversationHistory
          .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
          .join('\n')
      : 'No previous conversation history.';

    const systemPrompt = this.systemPrompt || `You are a task analysis assistant. Your job is to analyze user messages and determine what task should be executed.

Available task types:
${taskTypesDescription}

Analyze the user's message and determine the most appropriate task type. If the message matches a specific task type, return a JSON object with the task information. If it's just a general conversation, use the "reply" task type.

Return ONLY a valid JSON object in this format:
{
  "taskType": "task type name",
  "parameters": { /* task parameters object */ },
  "reply": "optional AI-generated reply message"
}`;

    const userPrompt = `User message: ${context.userMessage}

Conversation history:
${historyText}

Analyze this message and return the task information as JSON.`;

    return `${systemPrompt}\n\n${userPrompt}`;
  }

  /**
   * Parse AI response to extract task
   */
  private parseTaskResponse(
    aiResponse: string,
    context: ConversationContext,
  ): Task {
    try {
      // Try to extract JSON from response
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in AI response');
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        taskType?: string;
        parameters?: Record<string, unknown>;
        reply?: string;
      };

      const taskTypeName = parsed.taskType || 'reply';

      // Get task type definition
      const taskType = this.taskManager.getTaskType(taskTypeName);
      if (!taskType) {
        logger.warn(`[TaskAnalyzer] Unknown task type: ${taskTypeName}, falling back to reply`);
        return {
          type: 'reply',
          parameters: {},
          executor: 'reply',
          reply: parsed.reply || aiResponse,
        };
      }

      return {
        type: taskTypeName,
        parameters: parsed.parameters || {},
        executor: taskType.executor,
        reply: parsed.reply,
        metadata: {
          analyzedAt: new Date().toISOString(),
          userId: context.userId,
          groupId: context.groupId,
        },
      };
    } catch (error) {
      logger.warn('[TaskAnalyzer] Failed to parse AI response, using fallback:', error);

      // Fallback: return a reply task with the AI response as reply
      return {
        type: 'reply',
        parameters: {},
        executor: 'reply',
        reply: aiResponse,
        metadata: {
          fallback: true,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  /**
   * Set system prompt
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }
}
