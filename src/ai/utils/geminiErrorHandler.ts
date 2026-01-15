// Gemini API error message handler
// Provides utilities for handling errors in Gemini API responses and converting them to user-friendly messages

import { logger } from '@/utils/logger';
import type { ProviderImageGenerationResponse } from '../capabilities/types';

/**
 * Gemini API response types (partial, for error handling)
 */
interface GeminiCandidate {
  finishReason?: string;
  content?: {
    parts?: Array<{
      text?: string;
      inlineData?: {
        data?: string;
        mimeType?: string;
      };
    }>;
  };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: {
    blockReason?: string;
  };
}

/**
 * Finish reason to user-friendly message mapping
 */
const FINISH_REASON_MESSAGES: Record<string, string> = {
  MAX_TOKENS: 'Image generation stopped: Maximum tokens reached',
  SAFETY: 'Image generation blocked: Content was filtered by safety settings',
  RECITATION: 'Image generation blocked: Content may contain recitation',
  OTHER: 'Image generation failed: Unknown reason',
};

/**
 * Create error response for image generation failure
 */
function createErrorResponse(
  errorMessage: string,
  prompt: string,
  additionalMetadata?: Record<string, unknown>,
): ProviderImageGenerationResponse {
  logger.warn(`[GeminiErrorHandler] ${errorMessage}`);
  return {
    images: [],
    text: errorMessage,
    metadata: {
      prompt,
      error: true,
      ...additionalMetadata,
    },
  };
}

/**
 * Handle case when no candidates are in response
 */
export function handleNoCandidates(response: GeminiResponse, prompt: string): ProviderImageGenerationResponse | null {
  if (!response.candidates || response.candidates.length === 0) {
    const errorMessage = response.promptFeedback?.blockReason
      ? `Image generation failed: ${response.promptFeedback.blockReason}`
      : 'Image generation failed: No candidates in response. The request may have been blocked or failed.';
    return createErrorResponse(errorMessage, prompt);
  }
  return null;
}

/**
 * Handle case when candidate has non-STOP finish reason
 */
export function handleFinishReason(candidate: GeminiCandidate, prompt: string): ProviderImageGenerationResponse | null {
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    const errorMessage =
      FINISH_REASON_MESSAGES[candidate.finishReason] || `Image generation failed: ${candidate.finishReason}`;
    return createErrorResponse(errorMessage, prompt, {
      finishReason: candidate.finishReason,
    });
  }
  return null;
}

/**
 * Handle case when candidate content structure is invalid
 */
export function handleInvalidContent(
  candidate: GeminiCandidate,
  prompt: string,
): ProviderImageGenerationResponse | null {
  if (!candidate.content || !candidate.content.parts) {
    const errorMessage = 'Image generation failed: Invalid response structure (missing content.parts)';
    return createErrorResponse(errorMessage, prompt);
  }
  return null;
}

/**
 * Handle case when no image data is found in response
 */
export function handleNoImageData(text: string, prompt: string): ProviderImageGenerationResponse {
  const errorMessage = text
    ? `Image generation failed: ${text}`
    : 'Image generation failed: No image data found in response. The model may have returned text instead of an image.';
  return createErrorResponse(errorMessage, prompt, {
    responseText: text,
  });
}

/**
 * Handle general errors (from catch blocks)
 */
export function handleGeneralError(error: unknown, prompt: string): ProviderImageGenerationResponse {
  const err = error instanceof Error ? error : new Error('Unknown error');
  logger.error(`[GeminiErrorHandler] Generation failed: ${err.message}`, err);
  const errorMessage = `Image generation failed: ${err.message}`;
  return createErrorResponse(errorMessage, prompt, {
    errorType: err.name || 'Error',
  });
}
