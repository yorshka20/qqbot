// RAG configuration types (Ollama embed + Qdrant)

export interface OllamaEmbedConfig {
  url: string;
  model: string;
  timeout?: number;
}

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  timeout?: number;
}

export interface RAGConfig {
  enabled: boolean;
  ollama: OllamaEmbedConfig;
  qdrant: QdrantConfig;
  queryInstructionPrefix?: string;
  defaultVectorSize?: number;
  defaultDistance?: 'Cosine' | 'Euclid' | 'Dot';
}
