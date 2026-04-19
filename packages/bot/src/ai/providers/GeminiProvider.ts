// Gemini Provider implementation

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileState, GoogleGenAI } from '@google/genai';
import { container } from 'tsyringe';
import type { GeminiProviderConfig } from '@/core/config/types/ai';
import { DITokens } from '@/core/DITokens';
import type { ResourceCleanupService } from '@/services/video';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';
import { AIProvider } from '../base/AIProvider';
import type { Image2ImageCapability } from '../capabilities/Image2ImageCapability';
import type { LLMCapability } from '../capabilities/LLMCapability';
import type { Text2ImageCapability } from '../capabilities/Text2ImageCapability';
import type {
  CapabilityType,
  Image2ImageOptions,
  ProviderImageGenerationResponse,
  Text2ImageOptions,
  VideoAnalysisOptions,
  VideoAnalysisResult,
  VisionImage,
} from '../capabilities/types';
import type { VideoAnalysisCapability, VideoAnalysisUploadedFile } from '../capabilities/VideoAnalysisCapability';
import type { VisionCapability } from '../capabilities/VisionCapability';
import type { AIGenerateOptions, AIGenerateResponse, ChatMessage, StreamingHandler, ToolDefinition } from '../types';
import { contentToPlainString } from '../utils/contentUtils';
import {
  handleFinishReason,
  handleGeneralError,
  handleInvalidContent,
  handleNoCandidates,
  handleNoImageData,
} from '../utils/geminiErrorHandler';
import { ResourceDownloader } from '../utils/ResourceDownloader';

/** Runtime key mode for Gemini (free vs paid tier). Switch via GeminiProvider.setKeyMode(). */
export type GeminiKeyMode = 'free' | 'paid';

/**
 * Gemini Provider implementation
 * LLM, vision, video analysis, text2img and img2img via Google Gemini API.
 * Capabilities are enabled by config: llm, vision, text2img each optional and independent.
 * Supports free/paid key modes: set apiKeyFree and apiKeyPaid, then switch at runtime via GeminiProvider.setKeyMode().
 */

export class GeminiProvider
  extends AIProvider
  implements Text2ImageCapability, Image2ImageCapability, LLMCapability, VisionCapability, VideoAnalysisCapability
{
  readonly name = 'gemini';
  override readonly supportsToolUse = true;
  private config: GeminiProviderConfig;
  private _capabilities: CapabilityType[];
  /** Cached clients per key so we use the key for current mode; model unchanged. */
  private clientFree: GoogleGenAI | null = null;
  private clientPaid: GoogleGenAI | null = null;

  private outputPath = join(getRepoRoot(), 'output', 'gemini');

  // Default values for text2img when not overridden by config
  private static readonly DEFAULT_T2I_MODEL = 'gemini-2.5-flash-image';
  private static readonly DEFAULT_WIDTH = 1024;
  private static readonly DEFAULT_HEIGHT = 1024;

  /** Runtime key mode (free/paid). Default 'free'. Switch via GeminiProvider.setKeyMode(). */
  private static _keyMode: GeminiKeyMode = 'free';
  static getKeyMode(): GeminiKeyMode {
    return GeminiProvider._keyMode;
  }
  static setKeyMode(mode: GeminiKeyMode): void {
    GeminiProvider._keyMode = mode;
  }

  constructor(config: GeminiProviderConfig) {
    super();
    this.config = config;

    // Build capabilities from structured config: llm, vision, video_analysis, text2img (+ img2img)
    this._capabilities = [];
    if (config.llm) {
      this._capabilities.push('llm');
      this.setContextConfig(config.llm.enableContext ?? false, config.llm.contextMessageCount ?? 10);
    }
    if (config.vision) {
      this._capabilities.push('vision');
    }
    this._capabilities.push('video_analysis');
    if (config.text2img) {
      this._capabilities.push('text2img', 'img2img');
    }

    // register cleanup function for uploaded temp files.
    this.registryResourceCleanup();

    // Clients are created lazily in getClient() using the key for current mode
    logger.info('[GeminiProvider] Initialized (free/paid key mode supported)');
  }

  /** Resolve API key for current runtime mode (free or paid). Model is unchanged. */
  private getEffectiveApiKey(): string | undefined {
    const mode = GeminiProvider.getKeyMode();
    return mode === 'free' ? this.config.apiKeyFree : this.config.apiKeyPaid;
  }

  /** Return GoogleGenAI client for current key mode; creates and caches per key. */
  private getClient(): GoogleGenAI {
    const mode = GeminiProvider.getKeyMode();
    if (mode === 'free') {
      if (!this.clientFree) {
        this.clientFree = new GoogleGenAI({ apiKey: this.config.apiKeyFree });
      }
      return this.clientFree;
    }
    if (!this.clientPaid) {
      this.clientPaid = new GoogleGenAI({ apiKey: this.config.apiKeyPaid });
    }
    return this.clientPaid;
  }

  /**
   * Register the cleanup function for the Gemini provider.
   */
  private registryResourceCleanup(): void {
    const resourceCleanupService = container.resolve<ResourceCleanupService>(DITokens.RESOURCE_CLEANUP_SERVICE);
    resourceCleanupService.registerFileCleanup(this.name, this.deleteUploadedFile);
  }

  /**
   * Execute an async operation with automatic paid-key fallback.
   * If the current mode is 'free' and the call fails, retry once with the paid key,
   * then restore the original key mode regardless of the retry outcome.
   */
  private async withPaidFallback<T>(fn: (isPaidFallback: boolean) => Promise<T>): Promise<T> {
    try {
      return await fn(false);
    } catch (error) {
      const originalMode = GeminiProvider.getKeyMode();
      if (originalMode !== 'free' || !this.config.apiKeyPaid) {
        throw error;
      }
      logger.warn(
        `[GeminiProvider] Free key request failed (${error instanceof Error ? error.message : String(error)}), retrying with paid key...`,
      );
      GeminiProvider.setKeyMode('paid');
      try {
        return await fn(true);
      } finally {
        GeminiProvider.setKeyMode(originalMode);
        logger.debug(`[GeminiProvider] Restored key mode to '${originalMode}'`);
      }
    }
  }

  /** Text2img/img2img model from config.text2img */
  private getText2ImgModel(): string {
    return this.config.text2img?.model ?? GeminiProvider.DEFAULT_T2I_MODEL;
  }

  /** Default width from config.text2img */
  private getDefaultWidth(): number {
    return this.config.text2img?.defaultWidth ?? GeminiProvider.DEFAULT_WIDTH;
  }

  /** Default height from config.text2img */
  private getDefaultHeight(): number {
    return this.config.text2img?.defaultHeight ?? GeminiProvider.DEFAULT_HEIGHT;
  }

  isAvailable(): boolean {
    return !!this.getEffectiveApiKey();
  }

  async checkAvailability(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }
    try {
      const client = this.getClient();
      const model =
        this.config.llm?.model ?? this.config.videoAnalysisModel ?? this.config.vision?.model ?? 'gemini-2.5-flash';
      await client.models.get({ model });
      return true;
    } catch (error) {
      logger.debug('[GeminiProvider] Availability check failed:', error);
      if (error instanceof Error && error.message.includes('timeout')) {
        return false;
      }
      // Non-timeout errors (401, 400) mean API is reachable
      return true;
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      llm: this.config.llm ?? undefined,
      vision: this.config.vision ?? undefined,
      videoAnalysisModel: this.config.videoAnalysisModel ?? undefined,
      text2img: this.config.text2img ?? undefined,
    };
  }

  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  /**
   * Save image data to local file
   * Supports both Buffer and base64 string input
   * @returns Relative path from output directory (e.g., 'gemini/image.png') or null if save failed
   */
  private async saveImageToFile(imageData: Buffer | string, originalFilename: string): Promise<string | null> {
    try {
      const outputDir = this.outputPath;
      await mkdir(outputDir, { recursive: true });

      const timestamp = Date.now();
      const filename = `${timestamp}_${originalFilename}`;
      const filepath = join(outputDir, filename);

      let imageBuffer: Buffer;
      if (imageData instanceof Buffer) {
        imageBuffer = imageData;
      } else if (typeof imageData === 'string') {
        imageBuffer = Buffer.from(imageData, 'base64');
      } else {
        throw new Error('Invalid imageData type');
      }
      await writeFile(filepath, imageBuffer);

      const relativePath = `gemini/${filename}`;
      logger.info(`[GeminiProvider] Saved image to: ${filepath} (${imageBuffer.length} bytes)`);
      return relativePath;
    } catch (error) {
      logger.warn(
        `[GeminiProvider] Failed to save image to file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Map ToolDefinition[] to Gemini API tools format (functionDeclarations).
   */
  private static mapToolsToGemini(tools: ToolDefinition[]): Array<{
    functionDeclarations: Array<{
      name?: string;
      description?: string;
      parameters?: unknown;
      parametersJsonSchema?: unknown;
    }>;
  }> {
    if (!tools.length) {
      return [];
    }
    const functionDeclarations = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parametersJsonSchema: t.parameters,
    }));
    return [{ functionDeclarations }];
  }

  /**
   * Map ChatMessage[] to Gemini multi-turn Content[] format.
   * - System messages → combined into systemInstruction
   * - User messages → {role:'user', parts:[{text}]}
   * - Assistant messages (no tool_calls) → {role:'model', parts:[{text}]}
   * - Assistant messages (with tool_calls) → {role:'model', parts:[{functionCall:{name,args}}]}
   * - Tool messages → {role:'user', parts:[{functionResponse:{name,response}}]}
   */
  private static mapChatMessagesToGeminiContents(messages: ChatMessage[]): {
    systemInstruction?: string;
    contents: Array<{
      role: string;
      parts: Array<{
        text?: string;
        functionCall?: { name: string; args: Record<string, unknown> };
        functionResponse?: { name: string; response: Record<string, unknown> };
        inlineData?: { mimeType: string; data: string };
        thoughtSignature?: string;
      }>;
    }>;
  } {
    // Extract system messages → systemInstruction
    const systemParts = messages
      .filter((m) => m.role === 'system')
      .map((m) => contentToPlainString(m.content))
      .filter(Boolean);
    const systemInstruction = systemParts.join('\n\n') || undefined;

    // Build a lookup: tool_call_id → tool_name (from assistant messages with tool_calls)
    const toolCallIdToName = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          toolCallIdToName.set(tc.id, tc.name);
        }
      }
    }

    const contents: Array<{
      role: string;
      parts: Array<{
        text?: string;
        functionCall?: { name: string; args: Record<string, unknown> };
        functionResponse?: { name: string; response: Record<string, unknown> };
        inlineData?: { mimeType: string; data: string };
        thoughtSignature?: string;
      }>;
    }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        continue; // handled as systemInstruction
      }

      if (msg.role === 'assistant') {
        const parts: Array<{
          text?: string;
          functionCall?: { name: string; args: Record<string, unknown> };
          thoughtSignature?: string;
        }> = [];

        const textContent = contentToPlainString(msg.content).trim();
        if (textContent) {
          parts.push({ text: textContent });
        }

        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            let args: Record<string, unknown>;
            try {
              const parsed = JSON.parse(tc.arguments);
              args = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
            } catch {
              args = {};
            }
            const part: {
              functionCall: { name: string; args: Record<string, unknown> };
              thoughtSignature?: string;
            } = { functionCall: { name: tc.name, args } };
            // Echo back thoughtSignature for Gemini thinking models.
            if (tc.thought_signature) {
              part.thoughtSignature = tc.thought_signature;
            }
            parts.push(part);
          }
        }

        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
        continue;
      }

      if (msg.role === 'tool') {
        const toolName = msg.tool_call_id ? (toolCallIdToName.get(msg.tool_call_id) ?? 'unknown_tool') : 'unknown_tool';
        const rawContent = contentToPlainString(msg.content);
        let response: Record<string, unknown>;
        try {
          const parsed = JSON.parse(rawContent);
          response =
            typeof parsed === 'object' && parsed !== null
              ? (parsed as Record<string, unknown>)
              : { result: rawContent };
        } catch {
          response = { result: rawContent };
        }
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name: toolName, response } }],
        });
        continue;
      }

      // user role — handle both plain string and ContentPart[] (with image_url)
      if (typeof msg.content === 'string') {
        if (msg.content) {
          contents.push({ role: 'user', parts: [{ text: msg.content }] });
        }
      } else if (Array.isArray(msg.content)) {
        const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
        for (const part of msg.content) {
          if (part.type === 'text') {
            if (part.text) parts.push({ text: part.text });
          } else if (part.type === 'image_url') {
            const url = part.image_url.url;
            const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(url);
            if (dataUrlMatch) {
              parts.push({ inlineData: { mimeType: dataUrlMatch[1], data: dataUrlMatch[2] } });
            }
          }
        }
        if (parts.length > 0) {
          contents.push({ role: 'user', parts });
        }
      }
    }

    return { systemInstruction, contents };
  }

  /**
   * Call generateContent for text response (LLM or vision). Optional tools for function calling.
   * Returns text, usage, and if the model chose to call a function: functionCall + toolCallId.
   * Accepts either Part[] (for simple/vision requests) or Content[] (for multi-turn tool use).
   */
  private async generateContentText(
    model: string,
    parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>,
    options?: {
      temperature?: number;
      maxTokens?: number;
      tools?: ToolDefinition[];
      systemInstruction?: string;
      paidModel?: string;
    },
  ): Promise<{
    text: string;
    usage?: AIGenerateResponse['usage'];
    functionCalls?: AIGenerateResponse['functionCalls'];
  }>;

  private async generateContentText(
    model: string,
    contents: Array<{
      role: string;
      parts: Array<{
        text?: string;
        functionCall?: { name: string; args: Record<string, unknown> };
        functionResponse?: { name: string; response: Record<string, unknown> };
        inlineData?: { mimeType: string; data: string };
      }>;
    }>,
    options?: {
      temperature?: number;
      maxTokens?: number;
      tools?: ToolDefinition[];
      systemInstruction?: string;
      paidModel?: string;
    },
  ): Promise<{
    text: string;
    usage?: AIGenerateResponse['usage'];
    functionCalls?: AIGenerateResponse['functionCalls'];
  }>;

  private async generateContentText(
    model: string,
    contentsOrParts: unknown,
    options?: {
      temperature?: number;
      maxTokens?: number;
      tools?: ToolDefinition[];
      systemInstruction?: string;
      paidModel?: string;
    },
  ): Promise<{
    text: string;
    usage?: AIGenerateResponse['usage'];
    functionCalls?: AIGenerateResponse['functionCalls'];
  }> {
    const config: Record<string, unknown> = {
      temperature: options?.temperature ?? 0.7,
      maxOutputTokens: options?.maxTokens ?? 2000,
    };
    if (options?.tools?.length) {
      config.tools = GeminiProvider.mapToolsToGemini(options.tools);
      config.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
    if (options?.systemInstruction) {
      config.systemInstruction = options.systemInstruction;
    }

    const response = await this.withPaidFallback((isPaidFallback) =>
      this.getClient().models.generateContent({
        model: isPaidFallback && options?.paidModel ? options.paidModel : model,
        // The SDK accepts both Part[] and Content[] for contents; cast through unknown to satisfy the union.
        contents: contentsOrParts as Parameters<GoogleGenAI['models']['generateContent']>[0]['contents'],
        config,
      }),
    );

    const noCandidatesError = handleNoCandidates(response, '');
    if (noCandidatesError) {
      throw new Error(noCandidatesError.text || 'No candidates in response');
    }

    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts) {
      throw new Error('Invalid response structure');
    }

    const text = (response as { text?: string }).text ?? candidate.content.parts.map((p) => p.text ?? '').join('');
    const out: {
      text: string;
      usage?: AIGenerateResponse['usage'];
      functionCalls?: AIGenerateResponse['functionCalls'];
    } = {
      text: text ?? '',
      usage: undefined,
    };

    // Extract ALL function calls from the response.
    // Check response.functionCalls first (SDK shortcut), then fall back to checking parts directly.
    const sdkFunctionCalls = (
      response as { functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> }
    ).functionCalls;

    // Also collect all functionCall parts from candidate (fallback + thoughtSignature source).
    const partFunctionCalls = candidate.content.parts.filter(
      (p) => (p as { functionCall?: unknown }).functionCall != null,
    ) as Array<{
      functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
      thoughtSignature?: string;
    }>;

    // Build a map of name→thoughtSignature from parts for lookup.
    const thoughtSignatureByIndex = new Map<number, string>();
    for (let i = 0; i < partFunctionCalls.length; i++) {
      const sig = partFunctionCalls[i].thoughtSignature;
      if (sig) {
        thoughtSignatureByIndex.set(i, sig);
      }
    }

    // Prefer SDK shortcut array; fall back to parts-based extraction.
    const rawCalls =
      Array.isArray(sdkFunctionCalls) && sdkFunctionCalls.length > 0
        ? sdkFunctionCalls
        : partFunctionCalls
            .map((p) => p.functionCall)
            .filter((fc): fc is { id?: string; name?: string; args?: Record<string, unknown> } => fc != null);

    if (rawCalls.length > 0) {
      out.functionCalls = [];
      for (let i = 0; i < rawCalls.length; i++) {
        const fc = rawCalls[i];
        if (!fc?.name) continue;
        let argsStr: string;
        if (typeof fc.args === 'object' && fc.args !== null) {
          argsStr = JSON.stringify(fc.args);
        } else if (typeof fc.args === 'string') {
          argsStr = fc.args as string;
        } else {
          argsStr = '{}';
        }
        out.functionCalls.push({
          name: fc.name,
          arguments: argsStr,
          toolCallId: fc.id,
          thoughtSignature: thoughtSignatureByIndex.get(i),
        });
      }
      // When returning functionCalls, clear text so caller can detect tool-use cleanly.
      out.text = out.text || '';
    }

    return out;
  }

  /**
   * Convert VisionImage[] to inlineData parts for vision requests
   */
  private async visionImagesToInlineParts(
    images: VisionImage[],
  ): Promise<Array<{ inlineData: { mimeType: string; data: string } }>> {
    const result: Array<{ inlineData: { mimeType: string; data: string } }> = [];
    for (const img of images) {
      let resource: string;
      if (img.base64) {
        resource = `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}`;
      } else if (img.file) {
        resource = img.file.startsWith('file://') ? img.file : img.file;
      } else if (img.url) {
        resource = img.url;
      } else {
        continue;
      }
      const { data, mimeType } = await ResourceDownloader.downloadImageToBase64WithMimeType(resource, {
        timeout: 30000,
        maxSize: 10 * 1024 * 1024,
        filename: `gemini_image_${Date.now()}.png`,
      });
      result.push({ inlineData: { mimeType, data } });
    }
    return result;
  }

  // ---------- LLMCapability ----------

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    if (!this.config.llm) {
      throw new Error('GeminiProvider: llm not configured');
    }
    const model = options?.model ?? this.config.llm.model;
    const paidModel = this.config.llm.paidModel;
    const temperature = options?.temperature ?? this.config.llm.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.llm.maxTokens ?? 2000;

    if (options?.messages?.length) {
      // Multi-turn path: map ChatMessage[] to Gemini Content[] format.
      // This correctly handles tool use messages (functionCall / functionResponse parts).
      const { systemInstruction, contents } = GeminiProvider.mapChatMessagesToGeminiContents(options.messages);

      // Gemini requires at least one non-empty content entry.
      if (contents.length === 0) {
        contents.push({ role: 'user', parts: [{ text: prompt }] });
      }

      const result = await this.generateContentText(model, contents, {
        temperature,
        maxTokens,
        tools: options.tools,
        systemInstruction: systemInstruction ?? options.systemPrompt,
        paidModel,
      });
      return {
        text: result.text,
        usage: result.usage,
        functionCalls: result.functionCalls,
      };
    }

    // Legacy single-turn path: build flat text prompt from history.
    const history = await this.loadHistory(options);
    const parts: Array<{ text: string }> = [];
    if (options?.systemPrompt) {
      parts.push({ text: `system: ${options.systemPrompt}\n\n` });
    }
    for (const msg of history) {
      parts.push({ text: `${msg.role}: ${msg.content}\n\n` });
    }
    parts.push({ text: prompt });
    const fullPrompt = parts.map((p) => p.text).join('');

    const result = await this.generateContentText(model, [{ text: fullPrompt }], {
      temperature,
      maxTokens,
      tools: options?.tools,
      paidModel,
    });
    return {
      text: result.text,
      usage: result.usage,
      functionCalls: result.functionCalls,
    };
  }

  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const result = await this.generate(prompt, options);
    handler(result.text);
    return result;
  }

  // ---------- VisionCapability ----------

  async generateWithVision(
    prompt: string,
    images: VisionImage[],
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.config.vision) {
      throw new Error('GeminiProvider: vision not configured');
    }
    const model = this.config.vision.model;
    const paidModel = this.config.vision.paidModel;
    const imageParts = await this.visionImagesToInlineParts(images);
    const contentsParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
    if (options?.systemPrompt) {
      contentsParts.push({ text: `system: ${options.systemPrompt}\n\n` });
    }
    contentsParts.push({ text: prompt });
    contentsParts.push(...imageParts);

    return this.generateContentText(model, contentsParts, {
      temperature: options?.temperature ?? 0.7,
      maxTokens: options?.maxTokens ?? 2000,
      paidModel,
    });
  }

  async generateStreamWithVision(
    prompt: string,
    images: VisionImage[],
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const result = await this.generateWithVision(prompt, images, options);
    handler(result.text);
    return result;
  }

  async explainImages(images: VisionImage[], prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    return this.generateWithVision(prompt, images, options);
  }

  // ---------- Text2ImageCapability ----------

  async generateImage(prompt: string, options?: Text2ImageOptions): Promise<ProviderImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('GeminiProvider is not available: apiKeyFree/apiKeyPaid not configured');
    }
    if (!this.config.text2img) {
      throw new Error('GeminiProvider: text2img not configured');
    }

    try {
      logger.info(`[GeminiProvider] Starting image generation for prompt: ${prompt}`);

      const model = options?.model ?? this.getText2ImgModel();
      const width = options?.width ?? this.getDefaultWidth();
      const height = options?.height ?? this.getDefaultHeight();

      logger.info(`[GeminiProvider] Parameters: model=${model}, size=${width}x${height}`);

      const response = await this.withPaidFallback((_isPaidFallback) =>
        this.getClient().models.generateContent({
          model,
          contents: prompt,
        }),
      );

      logger.debug(`[GeminiProvider] Response received`, response);

      const noCandidatesError = handleNoCandidates(response, prompt);
      if (noCandidatesError) {
        return noCandidatesError;
      }

      const candidate = response.candidates?.[0];
      if (!candidate) {
        return {
          images: [],
          text: '',
          metadata: { prompt, numImages: 0 },
          error: { code: 'no_candidates', message: 'No candidates in response' },
        };
      }
      const finishReasonError = handleFinishReason(candidate, prompt);
      if (finishReasonError) {
        return finishReasonError;
      }

      const invalidContentError = handleInvalidContent(candidate, prompt);
      if (invalidContentError) {
        return invalidContentError;
      }

      const parts = candidate.content?.parts ?? [];
      let imageData: string | null = null;
      let text = '';
      let mimeType = 'image/png';

      for (const part of parts) {
        if (part.text) {
          text = part.text;
        } else if (part.inlineData) {
          const data = part.inlineData.data;
          if (data) {
            imageData = data;
            mimeType = part.inlineData.mimeType || 'image/png';
            break;
          }
        }
      }

      if (!imageData) {
        return handleNoImageData(text, prompt);
      }

      logger.info(`[GeminiProvider] Extracted image data (${imageData.length} chars, mimeType: ${mimeType})`);

      const extension = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? '.jpg' : '.png';
      const originalFilename = `gemini_image${extension}`;
      const relativePath = await this.saveImageToFile(imageData, originalFilename);

      const imageDataResponse: { relativePath?: string; base64?: string } = {};
      if (relativePath) {
        imageDataResponse.relativePath = relativePath;
      } else {
        imageDataResponse.base64 = imageData;
        logger.warn('[GeminiProvider] File save failed, using base64 fallback');
      }

      return {
        images: [imageDataResponse],
        text,
        metadata: {
          prompt,
          numImages: 1,
          width,
          height,
          model,
          mimeType,
        },
      };
    } catch (error) {
      return handleGeneralError(error, prompt);
    }
  }

  // ---------- Image2ImageCapability ----------

  async generateImageFromImage(
    image: string,
    prompt: string,
    options?: Image2ImageOptions,
  ): Promise<ProviderImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('GeminiProvider is not available: apiKeyFree/apiKeyPaid not configured');
    }
    if (!this.config.text2img) {
      throw new Error('GeminiProvider: text2img not configured (required for img2img)');
    }

    try {
      logger.info(`[GeminiProvider] Starting image-to-image transformation for prompt: ${prompt}`);

      const model = options?.model ?? this.getText2ImgModel();
      const width = options?.width ?? this.getDefaultWidth();
      const height = options?.height ?? this.getDefaultHeight();

      const { data: imageBase64, mimeType: imageMimeType } = await ResourceDownloader.downloadImageToBase64WithMimeType(
        image,
        {
          timeout: 30000,
          maxSize: 10 * 1024 * 1024,
          filename: `gemini_image_${Date.now()}.png`,
        },
      );

      const response = await this.withPaidFallback((_isPaidFallback) =>
        this.getClient().models.generateContent({
          model,
          contents: [{ text: prompt }, { inlineData: { mimeType: imageMimeType, data: imageBase64 } }],
        }),
      );

      const noCandidatesError = handleNoCandidates(response, prompt);
      if (noCandidatesError) {
        return noCandidatesError;
      }

      const candidate = response.candidates?.[0];
      if (!candidate) {
        return {
          images: [],
          text: '',
          metadata: { prompt, numImages: 0 },
          error: { code: 'no_candidates', message: 'No candidates in response' },
        };
      }

      const finishReasonError = handleFinishReason(candidate, prompt);
      if (finishReasonError) {
        return finishReasonError;
      }

      const invalidContentError = handleInvalidContent(candidate, prompt);
      if (invalidContentError) {
        return invalidContentError;
      }

      const parts = candidate.content?.parts ?? [];
      let imageData: string | null = null;
      let text = '';
      let mimeType = 'image/png';

      for (const part of parts) {
        if (part.text) {
          text = part.text;
        } else if (part.inlineData) {
          const data = part.inlineData.data;
          if (data) {
            imageData = data;
            mimeType = part.inlineData.mimeType || 'image/png';
            break;
          }
        }
      }

      if (!imageData) {
        return handleNoImageData(text, prompt);
      }

      logger.info(`[GeminiProvider] Extracted image data (${imageData.length} chars, mimeType: ${mimeType})`);

      const extension = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? '.jpg' : '.png';
      const originalFilename = `gemini_img2img${extension}`;
      const relativePath = await this.saveImageToFile(imageData, originalFilename);

      const imageDataResponse: { relativePath?: string; base64?: string } = {};
      if (relativePath) {
        imageDataResponse.relativePath = relativePath;
      } else {
        imageDataResponse.base64 = imageData;
        logger.warn('[GeminiProvider] File save failed, using base64 fallback');
      }

      return {
        images: [imageDataResponse],
        text,
        metadata: {
          prompt,
          numImages: 1,
          width,
          height,
          model,
          mimeType,
          inputImage: image.substring(0, 100),
        },
      };
    } catch (error) {
      return handleGeneralError(error, prompt);
    }
  }

  // ---------- Video File API ----------

  /**
   * Return a single consistent GoogleGenAI client for the entire video file lifecycle
   * (upload → wait → generate → delete). All operations MUST use the same API key
   * because Gemini File API files are scoped to the key that uploaded them.
   *
   * Prefers paid key (higher rate limits, more reliable for heavy workloads).
   * Falls back to free key only when paid key is not configured.
   */
  private getVideoClient(): GoogleGenAI {
    if (this.config.apiKeyPaid) {
      if (!this.clientPaid) {
        this.clientPaid = new GoogleGenAI({ apiKey: this.config.apiKeyPaid });
      }
      return this.clientPaid;
    }
    // No paid key — use free key
    if (!this.clientFree) {
      this.clientFree = new GoogleGenAI({ apiKey: this.config.apiKeyFree });
    }
    return this.clientFree;
  }

  /**
   * Upload a video buffer to Gemini File API.
   * @param videoBuffer Raw video bytes
   * @param mimeType MIME type of the video (auto-detected from extension if omitted)
   * @returns Uploaded File object (may still be PROCESSING)
   */
  async uploadVideoFile(videoBuffer: Buffer, mimeType = 'video/mp4'): Promise<VideoAnalysisUploadedFile> {
    return this.getVideoClient().files.upload({
      file: new Blob([new Uint8Array(videoBuffer)], { type: mimeType }),
      config: { mimeType },
    }) as Promise<VideoAnalysisUploadedFile>;
  }

  /**
   * Poll Gemini File API until the file is ACTIVE or FAILED.
   * @param fileName The "files/..." resource name returned by uploadVideoFile
   * @param timeoutMs Max wait time (default 5 minutes)
   * @param pollIntervalMs Polling interval (default 10 seconds)
   * @throws Error if file stays PROCESSING beyond timeout or enters FAILED state
   */
  async waitForFileProcessing(
    fileName: string,
    timeoutMs = 300_000,
    pollIntervalMs = 10_000,
  ): Promise<VideoAnalysisUploadedFile> {
    const client = this.getVideoClient();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const file = (await client.files.get({ name: fileName })) as VideoAnalysisUploadedFile;
      if (file.state === FileState.ACTIVE) {
        return file;
      }
      if (file.state === FileState.FAILED) {
        throw new Error(`Gemini file processing failed: ${file.error?.message ?? 'unknown error'}`);
      }
      // Still PROCESSING — wait before next poll
      await Bun.sleep(Math.min(pollIntervalMs, deadline - Date.now()));
    }
    throw new Error(`Gemini file processing timed out after ${timeoutMs / 1000}s: ${fileName}`);
  }

  /**
   * Generate a text response from a video using Gemini.
   * Combines upload → wait → generate into one call.
   *
   * @param prompt Question or instruction for the video
   * @param videoBuffer Raw video bytes
   * @param options Generation options
   * @returns Text response from the model
   */
  async generateWithVideo(
    prompt: string,
    videoBuffer: Buffer,
    options?: VideoAnalysisOptions,
  ): Promise<VideoAnalysisResult> {
    const client = this.getVideoClient();

    // 1. Upload video
    logger.info('[GeminiProvider] Uploading video to Gemini File API...');
    const file = await this.uploadVideoFile(videoBuffer);

    // 2. Wait for processing
    logger.info(`[GeminiProvider] Waiting for video processing: ${file.name}`);
    const processedFile = await this.waitForFileProcessing(file.name ?? '');

    // 3. Generate with video
    logger.info('[GeminiProvider] Generating analysis with video...');
    const temperature = options?.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? 2000;

    const response = await client.models.generateContent({
      model: this.config.videoAnalysisModel ?? 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { fileData: { mimeType: processedFile.mimeType ?? 'video/mp4', fileUri: processedFile.uri ?? '' } },
          ],
        },
      ],
      config: {
        temperature,
        maxOutputTokens: maxTokens,
        systemInstruction: options?.systemPrompt,
      },
    });

    const text = (response as { text?: string }).text ?? '';
    return { text };
  }

  /**
   * Generate a text response using an already-uploaded Gemini File URI.
   * Unlike generateWithVideo(), this method skips the upload and wait steps,
   * so callers that have already called uploadVideoFile + waitForFileProcessing
   * can pass the resulting fileUri directly and avoid a double-upload.
   *
   * @param prompt User question or instruction
   * @param fileUri The "fileUri" field from the ACTIVE File object returned by waitForFileProcessing
   * @param mimeType MIME type of the video (e.g. "video/mp4")
   * @param options Optional generation parameters
   */
  async generateWithFileUri(
    prompt: string,
    fileUri: string,
    mimeType: string,
    options?: VideoAnalysisOptions,
  ): Promise<VideoAnalysisResult> {
    const temperature = options?.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? 2000;

    logger.info('[GeminiProvider] Generating analysis from file URI...');

    const response = await this.getVideoClient().models.generateContent({
      model: this.config.videoAnalysisModel ?? 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }, { fileData: { mimeType, fileUri } }],
        },
      ],
      config: {
        temperature,
        maxOutputTokens: maxTokens,
        systemInstruction: options?.systemPrompt,
      },
    });

    const text = (response as { text?: string }).text ?? '';
    return { text };
  }

  /**
   * Delete an uploaded file from Gemini File API.
   * @param fileName The "files/..." resource name
   */
  async deleteUploadedFile(fileName: string): Promise<void> {
    await this.getVideoClient().files.delete({ name: fileName });
    logger.debug(`[GeminiProvider] Deleted uploaded file: ${fileName}`);
  }
}

export type { VideoAnalysisOptions, VideoAnalysisResult } from '../capabilities/types';
