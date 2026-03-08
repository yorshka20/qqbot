// Vision Service - provides vision/multimodal capability

import type { AIManager } from '../AIManager';
import type { VisionImage } from '../capabilities/types';
import type { VisionCapability } from '../capabilities/VisionCapability';
import { isVisionCapability } from '../capabilities/VisionCapability';
import type { ProviderSelector } from '../ProviderSelector';
import type { AIGenerateOptions, AIGenerateResponse, ChatMessage, ContentPart, StreamingHandler } from '../types';
import { normalizeVisionImages } from '../utils/imageUtils';

/**
 * Vision Service
 * Provides vision/multimodal capability (text + images)
 */
export class VisionService {
  constructor(
    private aiManager: AIManager,
    private providerSelector?: ProviderSelector,
  ) {}

  /**
   * Generate text with vision (multimodal input)
   */
  async generateWithVision(
    prompt: string,
    images: VisionImage[],
    options?: AIGenerateOptions,
    providerName?: string,
  ): Promise<AIGenerateResponse> {
    if (images.length === 0) {
      throw new Error('At least one image is required for vision generation');
    }

    // Normalize images before passing to provider: always convert URL/file to base64, never pass URL to model
    const normalizedImages = await normalizeVisionImages(images, {
      timeout: 30000,
      maxSize: 10 * 1024 * 1024, // 10MB default
    });

    // Determine which provider to use
    let provider: VisionCapability | null = null;
    const sessionId = options?.sessionId;

    if (providerName) {
      const p = this.aiManager.getProviderForCapability('vision', providerName);
      if (p && isVisionCapability(p)) {
        provider = p;
      } else {
        throw new Error(`Provider ${providerName} does not support Vision capability`);
      }
    } else if (sessionId && this.providerSelector) {
      const sessionProviderName = await this.providerSelector.getProviderForSession(sessionId, 'vision');
      if (sessionProviderName) {
        const p = this.aiManager.getProviderForCapability('vision', sessionProviderName);
        if (p && isVisionCapability(p)) {
          provider = p;
        }
      }
    }

    // Fall back to default provider
    if (!provider) {
      const defaultProvider = this.aiManager.getDefaultProvider('vision');
      if (defaultProvider && isVisionCapability(defaultProvider)) {
        provider = defaultProvider;
      } else {
        throw new Error('No Vision provider available');
      }
    }

    return await provider.generateWithVision(prompt, normalizedImages, options);
  }

  /**
   * Explain image(s): get text description of image content. Prompt is the full rendered text from the dedicated explain-image template.
   */
  async explainImages(
    images: VisionImage[],
    prompt: string,
    options?: AIGenerateOptions,
    providerName?: string,
  ): Promise<AIGenerateResponse> {
    if (images.length === 0) {
      throw new Error('At least one image is required to explain');
    }

    const normalizedImages = await normalizeVisionImages(images, {
      timeout: 30000,
      maxSize: 10 * 1024 * 1024, // 10MB default
    });

    let provider: VisionCapability | null = null;
    const sessionId = options?.sessionId;

    if (providerName) {
      const p = this.aiManager.getProviderForCapability('vision', providerName);
      if (p && isVisionCapability(p)) {
        provider = p;
      } else {
        throw new Error(`Provider ${providerName} does not support Vision capability`);
      }
    } else if (sessionId && this.providerSelector) {
      const sessionProviderName = await this.providerSelector.getProviderForSession(sessionId, 'vision');
      if (sessionProviderName) {
        const p = this.aiManager.getProviderForCapability('vision', sessionProviderName);
        if (p && isVisionCapability(p)) {
          provider = p;
        }
      }
    }

    if (!provider) {
      const defaultProvider = this.aiManager.getDefaultProvider('vision');
      if (defaultProvider && isVisionCapability(defaultProvider)) {
        provider = defaultProvider;
      } else {
        throw new Error('No Vision provider available');
      }
    }

    return await provider.explainImages(normalizedImages, prompt, options);
  }

  /**
   * Generate text with vision and streaming
   */
  async generateStreamWithVision(
    prompt: string,
    images: VisionImage[],
    handler: StreamingHandler,
    options?: AIGenerateOptions,
    providerName?: string,
  ): Promise<AIGenerateResponse> {
    if (images.length === 0) {
      throw new Error('At least one image is required for vision generation');
    }

    // Normalize images before passing to provider: always convert URL/file to base64, never pass URL to model
    const normalizedImages = await normalizeVisionImages(images, {
      timeout: 30000,
      maxSize: 10 * 1024 * 1024, // 10MB default
    });

    // Determine which provider to use
    let provider: VisionCapability | null = null;
    const sessionId = options?.sessionId;

    if (providerName) {
      const p = this.aiManager.getProviderForCapability('vision', providerName);
      if (p && isVisionCapability(p)) {
        provider = p;
      } else {
        throw new Error(`Provider ${providerName} does not support Vision capability`);
      }
    } else if (sessionId && this.providerSelector) {
      const sessionProviderName = await this.providerSelector.getProviderForSession(sessionId, 'vision');
      if (sessionProviderName) {
        const p = this.aiManager.getProviderForCapability('vision', sessionProviderName);
        if (p && isVisionCapability(p)) {
          provider = p;
        }
      }
    }

    if (!provider) {
      const defaultProvider = this.aiManager.getDefaultProvider('vision');
      if (defaultProvider && isVisionCapability(defaultProvider)) {
        provider = defaultProvider;
      } else {
        throw new Error('No Vision provider available');
      }
    }

    return await provider.generateStreamWithVision(prompt, normalizedImages, handler, options);
  }

  /**
   * Generate from full messages (history may contain image_url parts). Appends currentMessageImages to the last user message.
   * When provider implements generateWithVisionMessages, uses it; else falls back to flatten + generateWithVision.
   */
  async generateWithVisionMessages(
    messages: ChatMessage[],
    currentMessageImages: VisionImage[],
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (messages.length === 0) {
      throw new Error('At least one message is required');
    }

    // Caller must have inlined images into messages or pass already-processed images; no repeated normalization here.
    let finalMessages = messages;
    if (currentMessageImages.length > 0) {
      const imageParts: ContentPart[] = currentMessageImages
        .filter((img) => img.base64 || img.url)
        .map((img) => ({
          type: 'image_url' as const,
          image_url: {
            url: img.base64 ? `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}` : (img.url ?? ''),
          },
        }));
      const last = messages[messages.length - 1];
      const lastContent: ContentPart[] =
        typeof last.content === 'string'
          ? [{ type: 'text', text: last.content }, ...imageParts]
          : [...(last.content ?? []), ...imageParts];
      finalMessages = [...messages.slice(0, -1), { ...last, content: lastContent }];
    }

    let provider: VisionCapability | null = null;
    const sessionId = options?.sessionId;
    if (sessionId && this.providerSelector) {
      const name = await this.providerSelector.getProviderForSession(sessionId, 'vision');
      if (name) {
        const p = this.aiManager.getProviderForCapability('vision', name);
        if (p && isVisionCapability(p)) {
          provider = p;
        }
      }
    }
    if (!provider) {
      const defaultProvider = this.aiManager.getDefaultProvider('vision');
      if (defaultProvider && isVisionCapability(defaultProvider)) {
        provider = defaultProvider;
      }
    }
    if (!provider) {
      throw new Error('No Vision provider available');
    }

    if (typeof provider.generateWithVisionMessages === 'function') {
      return await provider.generateWithVisionMessages(finalMessages, options);
    }

    // Fallback: flatten to single prompt + all images (order may not match; use when provider has no messages API)
    const textParts: string[] = [];
    const allImages: VisionImage[] = [];
    for (const m of finalMessages) {
      if (typeof m.content === 'string') {
        textParts.push(`${m.role}:\n${m.content}`);
      } else {
        const parts: string[] = [];
        for (const p of m.content ?? []) {
          if (p.type === 'text') {
            parts.push(p.text);
          } else {
            const match = p.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              allImages.push({ mimeType: match[1], base64: match[2] });
            }
            parts.push('[image]');
          }
        }
        textParts.push(`${m.role}:\n${parts.join('\n')}`);
      }
    }
    const flattenedPrompt = textParts.join('\n\n');
    return await provider.generateWithVision(flattenedPrompt, allImages, options);
  }
}
