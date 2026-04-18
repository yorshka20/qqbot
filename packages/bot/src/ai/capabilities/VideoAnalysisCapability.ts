// Video analysis capability interface - Gemini video upload and analysis support

import type { AIProvider } from '../base/AIProvider';
import type { VideoAnalysisOptions, VideoAnalysisResult } from './types';

/**
 * Uploaded video file info returned by Gemini File API.
 * `name` is always required; other fields are provider/runtime dependent.
 */
export interface VideoAnalysisUploadedFile {
  name: string;
  mimeType?: string;
  uri?: string;
  state?: string;
  error?: {
    message?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Video analysis capability interface.
 * Providers that support Gemini-style video upload and analysis should implement this interface.
 */
export interface VideoAnalysisCapability {
  uploadVideoFile(videoBuffer: Buffer, mimeType?: string): Promise<VideoAnalysisUploadedFile>;
  waitForFileProcessing(
    fileName: string,
    timeoutMs?: number,
    pollIntervalMs?: number,
  ): Promise<VideoAnalysisUploadedFile>;
  generateWithVideo(prompt: string, videoBuffer: Buffer, options?: VideoAnalysisOptions): Promise<VideoAnalysisResult>;
  generateWithFileUri(
    prompt: string,
    fileUri: string,
    mimeType: string,
    options?: VideoAnalysisOptions,
  ): Promise<VideoAnalysisResult>;
  deleteUploadedFile(fileName: string): Promise<void>;
}

/**
 * Type guard to check if a provider implements VideoAnalysisCapability.
 */
export function isVideoAnalysisCapability(provider: unknown): provider is VideoAnalysisCapability {
  if (typeof provider !== 'object' || provider === null) {
    return false;
  }

  const aiProvider = provider as AIProvider;
  const capabilities = aiProvider.getCapabilities();
  return Array.isArray(capabilities) && capabilities.includes('video_analysis');
}
