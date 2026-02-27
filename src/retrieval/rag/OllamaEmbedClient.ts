// Ollama embed client - calls /api/embed and returns normalized vectors

import { HttpClient } from '@/api/http/HttpClient';
import type { OllamaEmbedConfig } from '@/core/config/rag';
import { logger } from '@/utils/logger';

interface OllamaEmbedResponse {
  embeddings: number[][];
}

function normalizeL2(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

export class OllamaEmbedClient {
  private httpClient: HttpClient;
  private model: string;

  constructor(config: OllamaEmbedConfig) {
    const baseUrl = config.url.replace(/\/$/, '');
    this.model = config.model;
    this.httpClient = new HttpClient({
      baseURL: baseUrl,
      defaultHeaders: {
        'Content-Type': 'application/json',
      },
      defaultTimeout: config.timeout ?? 30000,
    });
  }

  /**
   * Embed text(s) and return normalized vectors
   * @param text - Single string or array of strings
   */
  async embed(text: string | string[]): Promise<number[][]> {
    const input = Array.isArray(text) ? text : [text];
    if (input.length === 0) {
      return [];
    }

    const response = await this.httpClient.post<OllamaEmbedResponse>('/api/embed', {
      model: this.model,
      input,
    });

    const embeddings = response.embeddings ?? [];
    return embeddings.map((vec) => normalizeL2(vec));
  }

  /**
   * Embed a single text and return normalized vector
   */
  async embedSingle(text: string): Promise<number[]> {
    const result = await this.embed(text);
    return result[0] ?? [];
  }
}
