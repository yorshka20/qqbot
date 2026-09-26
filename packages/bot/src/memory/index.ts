// Memory module: long-term memory per group and per member.
//
// Layers, each depending only on the ones above it in this list:
//   model/          scope rules and constants; no I/O
//   storage/        the sources of truth (memory_facts rows, manual.txt) and the vector index
//   llm/            shared plumbing for memory's LLM jobs: JSON calls, fact drafts, prompt parts
//   consolidation/  candidate facts → operations on a slot
//   review/         due facts → keep / retire / merge
//   extraction/     chat → candidate facts, handed to consolidation (group_day task, backfills, notes)
//   retrieval/      what a reply, get_memory and search_memory read

export type { CoreScope, GroupCoreScope, ParsedScope, UserCoreScope } from '@/core/config/types/memory';
export { ALL_CORE_SCOPES, GROUP_CORE_SCOPES, USER_CORE_SCOPES } from '@/core/config/types/memory';
export type { ConsolidationSummary } from './consolidation/MemoryConsolidationService';
export { MemoryConsolidationService } from './consolidation/MemoryConsolidationService';
export type { ExtractResult } from './extraction/MemoryExtractService';
export { MemoryExtractService } from './extraction/MemoryExtractService';
export type { MemoryLLMOptions } from './llm/memoryLLM';
export { GROUP_MEMORY_USER_ID } from './model/constants';
export type { FormatMemoryMarkdownInput, MemorySpeakerSection } from './retrieval/formatMemoryMarkdown';
export { buildSpeakerTag, formatMemoryMarkdown } from './retrieval/formatMemoryMarkdown';
export type { MemorySearchResult, ReplyMemory } from './retrieval/MemoryRetrievalService';
export { MemoryRetrievalService } from './retrieval/MemoryRetrievalService';
export type { ReviewSummary } from './review/MemoryReviewService';
export { MemoryReviewService } from './review/MemoryReviewService';
export type { ManualSlot } from './storage/ManualMemoryStore';
export { ManualMemoryStore } from './storage/ManualMemoryStore';
export { MemoryFactStore } from './storage/MemoryFactStore';
export { MemoryIndex } from './storage/MemoryIndex';
