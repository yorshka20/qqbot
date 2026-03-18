// Anthropic Provider implementation

import { HttpClient } from '@/api/http/HttpClient';
import { logger } from '@/utils/logger';
import { AIProvider } from '../base/AIProvider';
import type { LLMCapability } from '../capabilities/LLMCapability';
import type { CapabilityType, VisionImage } from '../capabilities/types';
import type { VisionCapability } from '../capabilities/VisionCapability';
import type {
  AIGenerateOptions,
  AIGenerateResponse,
  ChatMessage,
  ContentPart,
  ConversationHistoryRole,
  StreamingHandler,
  ToolDefinition,
} from '../types';
import { contentToPlainString } from '../utils/contentUtils';
import { ResourceDownloader } from '../utils/ResourceDownloader';

export interface AnthropicProviderConfig {
  apiKey: string;
  model?: string; // claude-3-opus, claude-3-sonnet, claude-3-haiku, etc.
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  enableContext?: boolean;
  contextMessageCount?: number;
  resourceSavePath?: string; // Directory path to save downloaded resources
}

interface AnthropicMessage {
  role: ConversationHistoryRole;
  content: AnthropicContent;
}

interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface AnthropicMessagesRequestBody {
  model: string;
  max_tokens: number;
  temperature: number;
  messages: AnthropicMessage[];
  system?: AnthropicSystemBlock[];
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'none' | 'tool'; name?: string };
}

interface AnthropicStreamRequestBody extends AnthropicMessagesRequestBody {
  stream: true;
}

interface AnthropicVisionRequestBody {
  model: string;
  max_tokens: number;
  temperature: number;
  messages: Array<{ role: 'user'; content: AnthropicMessage['content'] }>;
  system?: AnthropicSystemBlock[];
}

interface AnthropicMessagesResponse {
  content: AnthropicContentBlock[];
  usage?: { input_tokens: number; output_tokens: number };
  model: string;
  stop_reason?: string | null;
}

interface AnthropicStreamChunk {
  type: string;
  delta?: { text?: string };
  usage?: { input_tokens: number; output_tokens: number };
}

function isAnthropicStreamChunk(value: unknown): value is AnthropicStreamChunk {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof Reflect.get(value, 'type') === 'string';
}

type AnthropicTextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
type AnthropicImageBlock = { type: 'image'; source: { type: string; media_type: string; data: string } };
type AnthropicToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
  is_error?: boolean;
};
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;
type AnthropicContent = string | AnthropicContentBlock[];
type AnthropicClientTool = {
  name: string;
  description?: string;
  input_schema: ToolDefinition['parameters'];
};
type AnthropicWebSearchTool = {
  type: 'web_search_20250305';
  name: 'web_search';
  max_uses?: number;
};
type AnthropicTool = AnthropicClientTool | AnthropicWebSearchTool;

const ANTHROPIC_DEFAULT_MODEL = 'claude-3-sonnet-20240229';
const ANTHROPIC_WEB_SEARCH_TOOL_NAME = 'web_search';
const ANTHROPIC_WEB_SEARCH_TOOL_TYPE = 'web_search_20250305';
const ANTHROPIC_WEB_SEARCH_MAX_USES = 5;
const ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS = 3;

function toAnthropicTextBlocks(text: string): AnthropicTextBlock[] {
  return [{ type: 'text', text }];
}

function parseToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringifyToolResultContent(content: ChatMessage['content']): string {
  return typeof content === 'string' ? content : contentToPlainString(content);
}

function extractAnthropicText(blocks: AnthropicContentBlock[]): string {
  return blocks
    .filter((block): block is AnthropicTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** Convert our ChatMessage content (string | ContentPart[]) to Anthropic message content. */
function toAnthropicContent(content: ChatMessage['content']): AnthropicContent {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.map((part: ContentPart) => {
    if (part.type === 'text') {
      return { type: 'text' as const, text: part.text };
    }
    // type === 'image_url': convert to Anthropic image block (base64 source)
    const url = part.image_url.url;
    const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(url);
    const mediaType = dataUrlMatch ? dataUrlMatch[1] : 'image/jpeg';
    const data = dataUrlMatch ? dataUrlMatch[2] : url.replace(/^data:[^;]+;base64,/, '');
    return { type: 'image' as const, source: { type: 'base64', media_type: mediaType, data } };
  });
}

/**
 * Anthropic Provider implementation
 * Implements LLM and Vision capabilities
 * Supports Claude 3 models with vision support
 */
export class AnthropicProvider extends AIProvider implements LLMCapability, VisionCapability {
  readonly name = 'anthropic';
  private config: AnthropicProviderConfig;
  private baseUrl = 'https://api.anthropic.com/v1';
  private _capabilities: CapabilityType[];
  private httpClient: HttpClient;

  constructor(config: AnthropicProviderConfig) {
    super();
    this.config = config;

    // Explicitly declare supported capabilities
    // Anthropic Claude 3 supports both LLM and Vision
    this._capabilities = ['llm', 'vision'];

    // Set context configuration
    this.setContextConfig(config.enableContext ?? false, config.contextMessageCount ?? 10);

    // Configure HttpClient
    this.httpClient = new HttpClient({
      baseURL: this.baseUrl,
      defaultHeaders: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      defaultTimeout: 120000, // 2 minutes default timeout for AI processing
    });

    if (this.isAvailable()) {
      logger.info('[AnthropicProvider] Initialized');
    }
  }

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }

  async checkAvailability(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      // Test API connection by making a simple request
      await this.httpClient.post(
        '/messages',
        {
          model: this.config.model || 'claude-3-sonnet-20240229',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'test' }],
        },
        { timeout: 5000 },
      );
      return true;
    } catch (error) {
      logger.debug('[AnthropicProvider] Availability check failed:', error);
      // If we get a 401 or 400, the API is reachable but token/request might be invalid
      // If we get a network error, the API is not reachable
      if (error instanceof Error && error.message.includes('timeout')) {
        return false;
      }
      // Other errors (like 401, 400) mean the API is reachable
      return true;
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      model: this.config.model || 'claude-3-sonnet-20240229',
      defaultTemperature: this.config.defaultTemperature || 0.7,
      defaultMaxTokens: this.config.defaultMaxTokens || 2000,
    };
  }

  /**
   * Get capabilities supported by this provider
   * Anthropic Claude 3 supports LLM text generation and Vision (multimodal)
   */
  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    const model = options?.model ?? this.config.model ?? ANTHROPIC_DEFAULT_MODEL;
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[AnthropicProvider] Generating with model: ${model}`);

      let messages = await this.buildAnthropicMessages(prompt, options);
      this.addHistoryCacheBreakpoint(messages);
      const tools = this.buildAnthropicTools(options);
      const explicitSystem = this.buildAnthropicSystemPrompt(options);
      let data: AnthropicMessagesResponse | null = null;

      for (let continuation = 0; continuation <= ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS; continuation++) {
        const requestBody: AnthropicMessagesRequestBody = {
          model,
          max_tokens: maxTokens,
          temperature,
          messages,
        };
        if (explicitSystem?.length) {
          requestBody.system = explicitSystem;
        }
        if (tools.length > 0) {
          requestBody.tools = tools;
          requestBody.tool_choice = { type: 'auto' };
        }

        data = await this.httpClient.post<AnthropicMessagesResponse>('/messages', requestBody);
        if (data.stop_reason !== 'pause_turn') {
          break;
        }
        logger.debug('[AnthropicProvider] Received pause_turn, continuing server-tool turn');
        messages = [...messages, { role: 'assistant', content: data.content }];
      }

      if (!data) {
        throw new Error('Anthropic response missing');
      }

      const text = extractAnthropicText(data.content);
      const usage = data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined;

      const result: AIGenerateResponse = {
        text,
        usage,
        metadata: {
          model: data.model,
        },
      };

      const toolUseBlock = data.content.find((block): block is AnthropicToolUseBlock => block.type === 'tool_use');
      if (toolUseBlock) {
        result.functionCall = {
          name: toolUseBlock.name,
          arguments: JSON.stringify(toolUseBlock.input ?? {}),
        };
        result.toolCallId = toolUseBlock.id;
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[AnthropicProvider] Generation failed:', err);
      throw err;
    }
  }

  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const model = options?.model ?? this.config.model ?? ANTHROPIC_DEFAULT_MODEL;
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[AnthropicProvider] Generating stream with model: ${model}`);

      const messages = await this.buildAnthropicMessages(prompt, options);
      this.addHistoryCacheBreakpoint(messages);
      const tools = this.buildAnthropicTools(options);

      // Use HttpClient stream method for streaming requests
      const requestBody: AnthropicStreamRequestBody = {
        model,
        max_tokens: maxTokens,
        temperature,
        messages,
        stream: true,
      };
      const explicitSystemStream = this.buildAnthropicSystemPrompt(options);
      if (explicitSystemStream?.length) {
        requestBody.system = explicitSystemStream;
      }
      if (tools.length > 0) {
        requestBody.tools = tools;
        requestBody.tool_choice = { type: 'auto' };
      }

      const stream = await this.httpClient.stream('/messages', {
        method: 'POST',
        body: requestBody,
      });

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let usage: AIGenerateResponse['usage'] | undefined;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n').filter((line) => line.trim() && line.startsWith('data: '));

          for (const line of lines) {
            try {
              const jsonStr = line.substring(6); // Remove 'data: ' prefix
              if (jsonStr === '[DONE]') {
                continue;
              }

              const parsed = JSON.parse(jsonStr);
              if (!isAnthropicStreamChunk(parsed)) {
                continue;
              }

              if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                fullText += parsed.delta.text;
                handler(parsed.delta.text);
              }

              if (parsed.type === 'message_stop' && parsed.usage) {
                usage = {
                  promptTokens: parsed.usage.input_tokens,
                  completionTokens: parsed.usage.output_tokens,
                  totalTokens: parsed.usage.input_tokens + parsed.usage.output_tokens,
                };
              }
            } catch (parseError) {
              logger.debug('[AnthropicProvider] Failed to parse stream chunk:', parseError);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      return {
        text: fullText,
        usage,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[AnthropicProvider] Stream generation failed:', err);
      throw err;
    }
  }

  async generateWithVision(
    prompt: string,
    images: VisionImage[],
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const model = options?.model ?? this.config.model ?? 'claude-3-opus-20240229';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[AnthropicProvider] Generating with vision, model: ${model}`);

      // Build content array with text and images
      const content: AnthropicContentBlock[] = [{ type: 'text', text: prompt }];

      // Add images to content
      for (const image of images) {
        let imageData: string;
        const mimeType = image.mimeType || 'image/jpeg';

        // Use ResourceDownloader to handle various input formats
        if (image.base64) {
          imageData = image.base64;
        } else if (image.url) {
          // Download from URL and convert to base64
          // Anthropic API limit: 5MB per image, 32MB per request
          imageData = await ResourceDownloader.downloadToBase64(image.url, {
            timeout: 30000, // 30 seconds timeout
            maxSize: 5 * 1024 * 1024, // 5MB maximum (Anthropic API limit)
            savePath: this.config.resourceSavePath, // Use provider-specific save path if configured
            filename: `anthropic_image_${Date.now()}`,
          });
        } else if (image.file) {
          // Read file and convert to base64
          // Anthropic API limit: 5MB per image, 32MB per request
          imageData = await ResourceDownloader.downloadToBase64(image.file, {
            timeout: 5000, // 5 seconds for local file
            maxSize: 5 * 1024 * 1024, // 5MB maximum (Anthropic API limit)
            savePath: this.config.resourceSavePath, // Use provider-specific save path if configured
            filename: `anthropic_image_${Date.now()}`,
          });
        } else {
          throw new Error('Invalid image format. Must provide base64, url, or file.');
        }

        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType,
            data: imageData,
          },
        });
      }

      const requestBody: AnthropicVisionRequestBody = {
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [
          {
            role: 'user',
            content,
          },
        ],
      };
      if (options?.systemPrompt?.trim()) {
        requestBody.system = [
          { type: 'text', text: options.systemPrompt, cache_control: { type: 'ephemeral' } },
        ];
      }

      const data = await this.httpClient.post<AnthropicMessagesResponse>('/messages', requestBody);

      const text = extractAnthropicText(data.content);
      const usage = data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined;

      return {
        text,
        usage,
        metadata: {
          model: data.model,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[AnthropicProvider] Vision generation failed:', err);
      throw err;
    }
  }

  /**
   * Explain image(s): describe image content as text. Prompt is the full rendered text from the dedicated explain-image template.
   */
  async explainImages(images: VisionImage[], prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    return this.generateWithVision(prompt, images, options);
  }

  async generateStreamWithVision(
    prompt: string,
    images: VisionImage[],
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    // Similar to generateWithVision but with streaming
    // Implementation would be similar to generateStream but with image content
    // For brevity, we'll use the non-streaming version and convert
    const response = await this.generateWithVision(prompt, images, options);
    // In a real implementation, you would stream the response
    handler(response.text);
    return response;
  }

  private buildAnthropicSystemPrompt(options?: AIGenerateOptions): AnthropicSystemBlock[] | undefined {
    const systemParts: string[] = [];

    const explicitSystem = options?.messages
      ?.filter((m) => m.role === 'system')
      .map((m) => contentToPlainString(m.content))
      .join('\n\n');
    if (explicitSystem?.trim()) {
      systemParts.push(explicitSystem);
    } else if (options?.systemPrompt?.trim()) {
      systemParts.push(options.systemPrompt);
    }

    if (systemParts.length === 0) {
      return undefined;
    }

    // Return system blocks with cache_control on the last block.
    // Anthropic caches everything up to and including the block with cache_control.
    return systemParts.map((text, i) => {
      const block: AnthropicSystemBlock = { type: 'text', text };
      if (i === systemParts.length - 1) {
        block.cache_control = { type: 'ephemeral' };
      }
      return block;
    });
  }

  private async buildAnthropicMessages(prompt: string, options?: AIGenerateOptions): Promise<AnthropicMessage[]> {
    if (options?.messages?.length) {
      return this.mapChatMessagesToAnthropic(options.messages);
    }

    const history = await this.loadHistory(options);
    const messages: AnthropicMessage[] = [];
    for (const msg of history) {
      messages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: toAnthropicContent(msg.content),
      });
    }
    messages.push({
      role: 'user',
      content: prompt,
    });
    return messages;
  }

  private mapChatMessagesToAnthropic(messages: ChatMessage[]): AnthropicMessage[] {
    const mapped: AnthropicMessage[] = [];

    for (const message of messages) {
      if (message.role === 'system') {
        continue;
      }

      if (message.role === 'assistant' && message.tool_calls?.length) {
        const content: AnthropicContentBlock[] = [];
        const assistantText = contentToPlainString(message.content).trim();
        if (assistantText) {
          content.push(...toAnthropicTextBlocks(assistantText));
        }
        for (const toolCall of message.tool_calls) {
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: parseToolArguments(toolCall.arguments),
          });
        }
        mapped.push({ role: 'assistant', content });
        continue;
      }

      if (message.role === 'tool') {
        mapped.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.tool_call_id ?? '',
              content: stringifyToolResultContent(message.content),
            },
          ],
        });
        continue;
      }

      mapped.push({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: toAnthropicContent(message.content),
      });
    }

    return mapped;
  }

  /**
   * Add cache_control breakpoint to the end of the conversation history prefix.
   * The last message is always the new user query; everything before it is stable
   * across turns and benefits from caching.
   * Mutates the messages array in place.
   */
  private addHistoryCacheBreakpoint(messages: AnthropicMessage[]): void {
    if (messages.length < 2) return;

    const target = messages[messages.length - 2];
    if (typeof target.content === 'string') {
      // Convert to block form so we can attach cache_control
      target.content = [{ type: 'text', text: target.content, cache_control: { type: 'ephemeral' } }];
    } else if (Array.isArray(target.content) && target.content.length > 0) {
      (target.content[target.content.length - 1] as AnthropicTextBlock).cache_control = { type: 'ephemeral' };
    }
  }

  private buildAnthropicTools(options?: AIGenerateOptions): AnthropicTool[] {
    const tools: AnthropicTool[] = [];

    if (options?.nativeWebSearch) {
      tools.push({
        type: ANTHROPIC_WEB_SEARCH_TOOL_TYPE,
        name: ANTHROPIC_WEB_SEARCH_TOOL_NAME,
        max_uses: ANTHROPIC_WEB_SEARCH_MAX_USES,
      });
    }

    if (options?.tools?.length) {
      tools.push(
        ...options.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
      );
    }

    // Add cache_control to the last tool so Anthropic caches system + tools prefix
    if (tools.length > 0) {
      (tools[tools.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' };
    }

    return tools;
  }
}
