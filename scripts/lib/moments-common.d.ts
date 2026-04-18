/**
 * Shared utilities for moments batch processing scripts.
 *
 * Provides: config loading, CLI parsing, Qdrant operations, Ollama calls,
 * and a generic batch processing loop to eliminate duplication across
 * moments-tag.ts, moments-sentiment.ts, moments-ner.ts, etc.
 */
export interface ProviderConfig {
    type: string;
    baseUrl?: string;
    baseURL?: string;
    model?: string;
    apiKey?: string;
}
export interface AppConfig {
    rag: {
        enabled: boolean;
        qdrant: {
            url: string;
            apiKey?: string;
        };
    };
    ai: {
        providers: Record<string, ProviderConfig>;
    };
}
/** Resolved LLM connection info for batch scripts. */
export interface LLMConnection {
    provider: string;
    type: string;
    baseUrl: string;
    apiKey?: string;
    model: string;
}
export interface QdrantPoint {
    id: string | number;
    payload: Record<string, unknown>;
}
export interface ScrollResponse {
    result: {
        points: QdrantPoint[];
        next_page_offset: string | number | null;
    };
}
export interface ParsedArgs {
    limit: number;
    dryRun: boolean;
    model: string;
    provider: string;
    batchSize: number;
    output: string;
}
export declare function loadConfig(configPath?: string): AppConfig;
/** @deprecated Use resolveLLMConnection instead. Kept for backward compatibility. */
export declare function getOllamaBaseUrl(config: AppConfig): string;
/**
 * Resolve an LLM connection from config by provider key or type.
 * Lookup order: exact key match → first provider with matching type → fallback to 'ollama'.
 */
export declare function resolveLLMConnection(config: AppConfig, providerKey: string, modelOverride?: string): LLMConnection;
export declare function parseArgs(defaults: {
    model: string;
    batchSize: number;
    output: string;
    provider?: string;
}): ParsedArgs;
export declare function qdrantScroll(qdrantUrl: string, offset: string | number | null, limit: number, options?: {
    collection?: string;
    filter?: Record<string, unknown>;
    payloadInclude?: string[];
}): Promise<ScrollResponse>;
export declare function qdrantSetPayload(qdrantUrl: string, pointIds: Array<string | number>, payload: Record<string, unknown>, collection?: string): Promise<void>;
/**
 * Call LLM with a batch of content items and a prompt builder.
 * Supports Ollama (/api/chat) and OpenAI-compatible providers (/v1/chat/completions).
 * Extracts JSON array from the LLM response.
 */
export declare function callLLM<T>(conn: LLMConnection, contents: Array<{
    index: number;
    content: string;
}>, promptBuilder: (contentList: string) => string): Promise<T[]>;
/** @deprecated Use callLLM instead. */
export declare function callOllama<T>(ollamaUrl: string, model: string, contents: Array<{
    index: number;
    content: string;
}>, promptBuilder: (contentList: string) => string): Promise<T[]>;
/** Extract a JSON array from LLM response text (handles markdown code blocks). */
export declare function extractJsonArray<T>(text: string): T[];
export declare function ensureOutputDir(outputPath: string): void;
export declare function appendJsonl(outputPath: string, record: unknown): void;
export declare function writeSummaryJson(outputPath: string, data: Record<string, unknown>): void;
export declare function printDistribution(stats: Map<string, number>, title: string, maxBarLength?: number): void;
export declare function printHeader(title: string, info: Record<string, string | number | boolean>): void;
export interface BatchProcessOptions<R extends {
    index: number;
}> {
    qdrantUrl: string;
    /** LLM connection info (resolved via resolveLLMConnection). */
    llm: LLMConnection;
    batchSize: number;
    limit: number;
    output: string;
    dryRun: boolean;
    /** Qdrant scroll filter (e.g. filter for untagged records) */
    scrollFilter?: Record<string, unknown>;
    /** Which payload fields to include in the scroll response */
    payloadInclude?: string[];
    /** Build the prompt from a content list string */
    promptBuilder: (contentList: string) => string;
    /** Process one LLM result item, returning an output record to append to JSONL. */
    processResult: (result: R, point: QdrantPoint) => unknown;
    /** Set of point IDs to skip (already processed). */
    skipIds?: Set<string>;
}
export interface BatchProcessResult {
    totalProcessed: number;
    totalSkipped: number;
    totalSuccess: number;
    totalFailed: number;
}
export declare function runBatchLoop<R extends {
    index: number;
}>(opts: BatchProcessOptions<R>): Promise<BatchProcessResult>;
//# sourceMappingURL=moments-common.d.ts.map